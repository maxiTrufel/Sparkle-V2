variable "region" {
  description = "Región de AWS. São Paulo por latencia desde Argentina (~25-40 ms contra ~120 de Virginia); el sistema son alertas de atención en tiempo real."
  type        = string
  default     = "sa-east-1"
}

variable "nombre" {
  description = "Prefijo de todos los recursos. Cambiarlo permite levantar un entorno paralelo (ej. 'sparkle-staging') sin tocar el existente."
  type        = string
  default     = "sparkle"
}

variable "tipo_instancia" {
  description = <<-TXT
    t3.small = 2 vCPU / 2 GB. 1 GB (t3.micro) queda apretado con MariaDB +
    Node + Caddy juntos; con 2 GB más los 4 GB de swap que arma el
    user_data va sobrado.

    Alternativa más barata: t4g.small (ARM Graviton, ~20% menos). Debería
    andar —@napi-rs/canvas publica prebuild linux-arm64-gnu— pero
    confirmalo con un `docker buildx --platform linux/arm64` local ANTES de
    cambiarlo acá, y acordate de que la AMI también tiene que ser arm64
    (ver `filter` en compute.tf).
  TXT
  type        = string
  default     = "t3.small"
}

variable "arquitectura_ami" {
  description = "amd64 para t3.*, arm64 para t4g.*. Tiene que coincidir con tipo_instancia o la instancia no arranca."
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["amd64", "arm64"], var.arquitectura_ami)
    error_message = "Solo 'amd64' o 'arm64'."
  }
}

variable "tamano_disco_gb" {
  description = "EBS gp3 raíz. 30 GB entra en el free tier de EBS y sobra: la base y los PDFs de una tesis son megabytes, el resto son las imágenes de Docker."
  type        = number
  default     = 30
}

variable "mi_ip" {
  description = <<-TXT
    Tu IP pública, en formato CIDR /32 (ej. "181.23.45.67/32"). Es lo ÚNICO
    que puede llegar al puerto 22.

    Averiguala con:  curl -s https://checkip.amazonaws.com

    Si tenés IP dinámica (lo normal en una conexión hogareña argentina) va a
    cambiar cada tanto y vas a tener que actualizar esta variable y correr
    `terraform apply` de nuevo. Es molesto y es a propósito: la alternativa
    es dejar el 22 abierto a internet, y un puerto 22 abierto recibe
    intentos de login a los pocos minutos de existir.

    La red de emergencia si te quedás afuera es SSM Session Manager, que ya
    está habilitado (ver iam.tf) y no usa el puerto 22 en absoluto.
  TXT
  type        = string

  validation {
    condition     = can(cidrhost(var.mi_ip, 0)) && endswith(var.mi_ip, "/32")
    error_message = "Tiene que ser un CIDR /32, por ejemplo \"181.23.45.67/32\"."
  }
}

variable "ssh_desde_actions" {
  description = <<-TXT
    Abre el puerto 22 a 0.0.0.0/0, además de `mi_ip`.

    Hace falta porque el deploy entra por SSH desde un runner de GitHub
    Actions, y ese runner sale por una IP cualquiera de Azure que cambia en
    cada corrida. Acotarlo por CIDR no es una opción: el rango `actions` de
    https://api.github.com/meta son 5625 bloques IPv4 y un security group
    admite 60 reglas.

    Qué queda expuesto: sshd con autenticación por clave pública únicamente
    —la imagen de Ubuntu viene con `PasswordAuthentication no`—, así que
    hace falta la clave privada de deploy, no una contraseña. Lo que sí
    aparece son los intentos de login automatizados de siempre, en el log.

    Cómo cerrarlo: cuando la fase F esté hecha, el servidor va a estar en la
    tailnet y el runner puede entrar por ahí con una authkey efímera. Ese
    día esto pasa a `false` y el 22 deja de existir para internet.
  TXT
  type        = bool
  default     = true
}

variable "clave_publica_ssh" {
  description = <<-TXT
    Contenido de la clave PÚBLICA (.pub) que va a poder entrar por SSH.

    ⚠️ Que sea una clave DEDICADA al deploy, no tu clave personal (paso E.7
    del plan): la privada va a vivir en los secretos de GitHub Actions, y
    una clave que usa un servicio automatizado no debería ser la misma con
    la que entrás vos a todos lados.

    Generala con:
      ssh-keygen -t ed25519 -f ~/.ssh/sparkle_deploy -C "deploy sparkle v2"

    Y pegá acá el contenido de ~/.ssh/sparkle_deploy.pub (una línea).
  TXT
  type        = string

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2) ", var.clave_publica_ssh))
    error_message = "Tiene que ser el contenido de un archivo .pub, empezando por ssh-ed25519 / ssh-rsa / ecdsa-sha2."
  }
}

variable "presupuesto_mensual_usd" {
  description = "Techo mensual para la alerta de presupuesto. El plan estima ~USD 32/mes de AWS; 50 deja margen sin volverse ruido."
  type        = number
  default     = 50
}

variable "email_alertas" {
  description = "Adónde llegan las alertas de presupuesto (al 50%, al 80% y cuando la proyección del mes supera el techo)."
  type        = string
}

variable "dias_retencion_backups" {
  description = "Días que sobreviven los backups en S3 antes de borrarse solos."
  type        = number
  default     = 30
}

variable "snapshots_a_retener" {
  description = "Cantidad de snapshots diarios del disco que mantiene la política DLM."
  type        = number
  default     = 7
}
