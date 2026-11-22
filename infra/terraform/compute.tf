# ─── Instancia (paso C.4) ──────────────────────────────────────────────

# La AMI se busca por nombre en vez de fijarse por ID: los IDs de AMI son
# distintos en cada región, y Canonical publica una imagen nueva por mes.
# Fijar un ID acá haría que el `apply` de la cuenta nueva del runbook de
# recuperación fallara con "AMI no encontrada" — exactamente en el momento
# en que menos ganas hay de depurar Terraform.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${var.arquitectura_ami}-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "deploy" {
  key_name   = "${var.nombre}-deploy"
  public_key = var.clave_publica_ssh
}

resource "aws_instance" "servidor" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.tipo_instancia
  subnet_id              = aws_subnet.publica.id
  vpc_security_group_ids = [aws_security_group.servidor.id]
  key_name               = aws_key_pair.deploy.key_name
  iam_instance_profile   = aws_iam_instance_profile.instancia.name

  user_data = file("${path.module}/user_data.sh")
  # Sin esto, editar user_data.sh no hace nada: Terraform lo considera un
  # cambio que no justifica recrear la instancia y el script queda como
  # estaba. Con esto, cambiarlo REEMPLAZA la instancia — que es lo correcto
  # (cloud-init solo corre en el primer arranque) y también es destructivo:
  # antes de tocar ese archivo con el sistema en producción, backup.
  user_data_replace_on_change = true

  # ⚠️ No es decorativo. Nada en los atributos de arriba ata la instancia a
  # las REGLAS del security group ni a la tabla de rutas: solo al grupo y a
  # la subred, que existen antes que sus reglas. Sin este depends_on,
  # Terraform puede arrancar la instancia mientras todavía no hay salida a
  # internet, y cloud-init muere en el primer `apt-get install` con
  # "Network is unreachable". Pasó en el primer apply real.
  #
  # El síntoma es traicionero: la instancia queda encendida, responde por
  # SSH con el usuario `ubuntu`, y lo único que falla es todo lo que el
  # user_data tenía que dejar instalado. Como cloud-init corre una sola vez,
  # no se recupera solo: hay que reemplazar la instancia.
  depends_on = [
    aws_vpc_security_group_egress_rule.todo,
    aws_route_table_association.publica,
  ]

  root_block_device {
    volume_size = var.tamano_disco_gb
    volume_type = "gp3"
    encrypted   = true
    tags        = { Name = "${var.nombre}-raiz" }
  }

  # IMDSv2 obligatorio. El metadata service es de donde salen las
  # credenciales temporales del instance profile; en su versión 1 alcanzaba
  # un GET simple para leerlas, lo que convertía cualquier SSRF de la
  # aplicación en un robo de credenciales de AWS. V2 exige un token PUT
  # previo, que un SSRF no puede hacer.
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = {
    Name = "${var.nombre}-servidor"
    # La etiqueta por la que la política DLM lo encuentra (ver
    # almacenamiento.tf). Sin ella no hay snapshots, y en silencio.
    Snapshot = "diario"
  }
}

# ─── IP elástica ───────────────────────────────────────────────────────
#
# La IP pública que asigna AWS por defecto CAMBIA cada vez que la instancia
# se apaga y se enciende. Con un registro A en Namecheap apuntándole, eso
# significa que un reinicio deja el dominio apuntando a una IP ajena hasta
# que alguien lo note.
#
# Ojo con el costo: desde febrero de 2024 AWS cobra ~USD 4/mes por cada
# IPv4 pública, esté en uso o no. Ese cargo aparece igual con o sin IP
# elástica; acá al menos compramos estabilidad con él.
resource "aws_eip" "servidor" {
  domain   = "vpc"
  instance = aws_instance.servidor.id

  depends_on = [aws_internet_gateway.principal]
  tags       = { Name = "${var.nombre}-eip" }
}
