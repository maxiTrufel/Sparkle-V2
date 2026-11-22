# ─── Presupuesto y alertas (parte del paso C.1) ────────────────────────
#
# El plan lo pone como un paso manual de la consola. Va en Terraform por el
# mismo motivo que todo lo demás: en la cuenta nueva del runbook de
# recuperación, un paso manual es un paso que alguien se olvida — y este en
# particular se olvida sin dar ninguna señal, hasta que llega la factura.
#
# Tres avisos, no uno. El de PROYECCIÓN es el que más vale: los otros dos
# te enteran de que ya gastaste; ese te avisa a mitad de mes que a este
# ritmo vas a pasarte, cuando todavía se puede hacer algo.

resource "aws_budgets_budget" "mensual" {
  name         = "${var.nombre}-mensual"
  budget_type  = "COST"
  limit_amount = tostring(var.presupuesto_mensual_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.email_alertas]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.email_alertas]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.email_alertas]
  }
}
