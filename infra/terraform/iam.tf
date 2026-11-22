# ─── Identidad de la instancia (parte del paso C.6) ────────────────────
#
# El objetivo es que el servidor pueda escribir sus backups en S3 SIN
# ninguna credencial guardada en disco. Con un instance profile, el SDK y
# la CLI de AWS sacan credenciales temporales del metadata service solos:
# no hay `aws configure` que correr, ni una access key que se pueda filtrar
# en un backup, en un log o en una captura de pantalla.

resource "aws_iam_role" "instancia" {
  name = "${var.nombre}-rol-instancia"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# Permisos mínimos: escribir y listar SOLO en el bucket de backups. Ni
# siquiera puede borrar objetos — el borrado lo hace la regla de ciclo de
# vida del bucket, no el servidor. Si alguien entra a la máquina, no puede
# borrar los backups con las credenciales que encuentra ahí.
resource "aws_iam_role_policy" "backups" {
  name = "${var.nombre}-escribir-backups"
  role = aws_iam_role.instancia.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = aws_s3_bucket.backups.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.backups.arn}/*"
      }
    ]
  })
}

# SSM Session Manager: consola en la instancia desde la web de AWS, sin
# puerto 22 y sin clave.
#
# No es un lujo: el puerto 22 está abierto solo a `var.mi_ip`, y esa IP es
# dinámica en una conexión hogareña. El día que cambie —probablemente
# mientras estés lejos de la máquina desde la que corrés Terraform— esto es
# lo que evita que quedarte afuera del servidor sea un problema. No cuesta
# nada.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instancia.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instancia" {
  name = "${var.nombre}-perfil-instancia"
  role = aws_iam_role.instancia.name
}
