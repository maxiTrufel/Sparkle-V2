# Versiones fijadas a propósito.
#
# `terraform apply` corre pocas veces al año en este proyecto. Sin un pin,
# la corrida de dentro de seis meses —la que va a ser de recuperación, con
# el servidor caído y bajo presión— usaría un provider mayor distinto, con
# recursos renombrados y atributos que cambiaron de nombre. El pin es
# barato ahora y es la diferencia entre "20 minutos" y "una tarde" después.
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.region

  # Todo lo que cree este módulo queda etiquetado. Sirve para dos cosas
  # concretas: encontrar qué borrar si algo queda huérfano, y ver el gasto
  # desglosado en Cost Explorer en vez de un total sin abrir.
  default_tags {
    tags = {
      Proyecto    = "sparkle-v2"
      Entorno     = "produccion"
      Gestion     = "terraform"
      Repositorio = "maxiTrufel/Saprkle_V2_Codigo"
    }
  }
}
