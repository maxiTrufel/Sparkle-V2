# ─── Bucket de backups (paso C.6) ──────────────────────────────────────
#
# "Un backup en el mismo disco que la base no es un backup." Acá van el
# dump de MariaDB y el tar del volumen de uploads que arma el cron de la
# fase I.

# El nombre de un bucket es único en TODO S3, a nivel global. Un sufijo
# derivado del ID de la cuenta evita el choque sin obligarte a inventar un
# nombre, y hace que el mismo código funcione tal cual en la cuenta nueva
# del runbook de recuperación.
data "aws_caller_identity" "actual" {}

resource "aws_s3_bucket" "backups" {
  bucket = "${var.nombre}-backups-${data.aws_caller_identity.actual.account_id}"

  tags = { Name = "${var.nombre}-backups" }
}

# Versionado: si un backup sale corrupto —o si un script con un bug sube un
# dump vacío encima del bueno— la versión anterior sigue estando. Sin esto,
# el `aws s3 sync` diario pisa el archivo bueno y no hay a qué volver.
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Los backups traen transcripciones de clases y datos de alumnos. Esto es
# el default de AWS desde 2023, pero se declara explícito: es el tipo de
# cosa que no se quiere que dependa de un default que puede cambiar.
resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  # El versionado no sirve de nada si las versiones viejas se acumulan para
  # siempre: sin la segunda regla, cada `sync` diario deja una versión más
  # y la cuenta de S3 crece sin techo.
  depends_on = [aws_s3_bucket_versioning.backups]

  rule {
    id     = "borrar-backups-viejos"
    status = "Enabled"
    filter {}

    expiration {
      days = var.dias_retencion_backups
    }
  }

  rule {
    id     = "borrar-versiones-viejas"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.dias_retencion_backups
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ─── Snapshots del disco (paso C.7) ────────────────────────────────────
#
# Cubre algo distinto del backup a S3, y por eso están los dos: el dump
# restaura los DATOS en una máquina que ya funciona; el snapshot restaura
# la MÁQUINA ENTERA —sistema, Docker, configuración, volúmenes— tal como
# estaba. Si lo que se rompe es el servidor y no la base, el snapshot es
# más rápido que reconstruir.

resource "aws_iam_role" "dlm" {
  name = "${var.nombre}-rol-dlm"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "dlm.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "snapshots_diarios" {
  # Solo ASCII y sin puntuacion rara: DLM valida la descripcion contra
  # [0-9A-Za-z _-]+ y rechaza el guion largo y la coma con un error que no
  # dice cual es el caracter ofensivo.
  description        = "Sparkle V2 snapshot diario del disco retiene ${var.snapshots_a_retener}"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["INSTANCE"]

    # DLM selecciona por etiqueta, no por ID: si la instancia se recrea
    # (cambio de tipo, recuperación), la política la sigue tomando sin
    # tocar nada.
    target_tags = {
      Snapshot = "diario"
    }

    schedule {
      name = "diario-${var.snapshots_a_retener}-dias"

      create_rule {
        # 07:00 UTC = 04:00 en Argentina. La ventana de snapshot congela
        # I/O un instante; que caiga de madrugada y no en el medio de una
        # clase es gratis.
        interval      = 24
        interval_unit = "HOURS"
        times         = ["07:00"]
      }

      retain_rule {
        count = var.snapshots_a_retener
      }

      copy_tags = true
    }
  }
}
