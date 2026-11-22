# ─── Red (paso C.2) ────────────────────────────────────────────────────
#
# VPC propia y no la default de la cuenta: la default trae subredes en
# todas las zonas y reglas que nadie escribió, y no está en el código. Una
# VPC propia hace que "volver a hostear en otra cuenta" sea un `apply` y no
# una arqueología.
#
# Una sola subred pública. No hay subred privada ni NAT gateway a propósito:
# el NAT gateway cuesta ~USD 32/mes —tanto como todo el resto junto— y acá
# no protege nada, porque la única máquina tiene que hablarle a internet
# igual (Let's Encrypt, OpenAI, GHCR). El aislamiento real de la base lo da
# la red `internal` de Docker Compose, que no tiene ruta hacia afuera.

resource "aws_vpc" "principal" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.nombre}-vpc" }
}

resource "aws_internet_gateway" "principal" {
  vpc_id = aws_vpc.principal.id
  tags   = { Name = "${var.nombre}-igw" }
}

# La primera AZ disponible de la región. No se fija a mano ("sa-east-1a")
# porque el mapeo de esos nombres a hardware real es distinto en cada
# cuenta de AWS — hardcodearlo es justo lo que rompería el `apply` en la
# cuenta nueva del runbook de recuperación.
data "aws_availability_zones" "disponibles" {
  state = "available"
}

resource "aws_subnet" "publica" {
  vpc_id                  = aws_vpc.principal.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = data.aws_availability_zones.disponibles.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${var.nombre}-subnet-publica" }
}

resource "aws_route_table" "publica" {
  vpc_id = aws_vpc.principal.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.principal.id
  }

  tags = { Name = "${var.nombre}-rt-publica" }
}

resource "aws_route_table_association" "publica" {
  subnet_id      = aws_subnet.publica.id
  route_table_id = aws_route_table.publica.id
}

# ─── Security group (paso C.3) ─────────────────────────────────────────
#
# Tres puertos entrantes y nada más. Tailscale NO necesita ninguno: hace
# NAT traversal saliente, que es precisamente por qué se eligió en vez de
# abrirle un puerto a Vexa.

resource "aws_security_group" "servidor" {
  name        = "${var.nombre}-servidor"
  description = "Sparkle V2: SSH solo desde la IP del equipo, HTTP y HTTPS abiertos."
  vpc_id      = aws_vpc.principal.id

  tags = { Name = "${var.nombre}-sg-servidor" }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.servidor.id
  description       = "SSH, solo desde la IP declarada en var.mi_ip"
  cidr_ipv4         = var.mi_ip
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

# El runner de GitHub Actions no tiene IP fija, asi que la regla de arriba
# no lo deja entrar: el deploy del paso E.4 muere en `ssh-keyscan` sin
# llegar a intentar la conexion. Ver var.ssh_desde_actions para el porque
# y para como volver a cerrarlo cuando el deploy pase por Tailscale.
resource "aws_vpc_security_group_ingress_rule" "ssh_actions" {
  count             = var.ssh_desde_actions ? 1 : 0
  security_group_id = aws_security_group.servidor.id
  description       = "SSH desde el runner de GitHub Actions: sin IP fija, no se puede acotar por CIDR"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.servidor.id
  # El 80 no es opcional aunque todo el tráfico real sea HTTPS: Let's
  # Encrypt valida el dominio por HTTP-01 contra este puerto. Cerrarlo
  # deja a Caddy sin poder sacar ni renovar el certificado.
  # Solo ASCII y sin apostrofes: EC2 valida las descripciones de reglas
  # contra "a-zA-Z0-9._-:/()#,@[]+=&;{}!$*" mas el espacio. El guion
  # largo, las tildes y el apostrofe de "Let's" la hacen fallar.
  description = "HTTP: redireccion a HTTPS y desafio ACME de Lets Encrypt"
  cidr_ipv4   = "0.0.0.0/0"
  from_port   = 80
  to_port     = 80
  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.servidor.id
  description       = "HTTPS y WebSocket sobre TLS (wss)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "https_quic" {
  security_group_id = aws_security_group.servidor.id
  # `docker-compose.yml` publica "443:443/udp" para HTTP/3. Sin esta regla
  # el stack levanta igual y todo anda —los clientes caen a TCP— así que
  # el síntoma sería un HTTP/3 que nunca conecta y nadie mira. Se abre para
  # que el compose y la infraestructura digan lo mismo.
  description = "HTTP/3 (QUIC): Caddy publica 443/udp"
  cidr_ipv4   = "0.0.0.0/0"
  from_port   = 443
  to_port     = 443
  ip_protocol = "udp"
}

resource "aws_vpc_security_group_egress_rule" "todo" {
  security_group_id = aws_security_group.servidor.id
  description       = "Salida libre: Lets Encrypt, GHCR, OpenAI, Tailscale, apt"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
