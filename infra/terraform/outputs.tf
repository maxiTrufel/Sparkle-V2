# ─── Salidas (paso C.8) ────────────────────────────────────────────────
#
# Es lo que hay que copiar a otros lados después del apply. Volvé a verlas
# cuando quieras con `terraform output`.

output "ip_publica" {
  description = "La IP elástica. Va al registro A de `api` en Namecheap (paso G.1) y al secreto EC2_HOST de GitHub Actions (paso E.3)."
  value       = aws_eip.servidor.public_ip
}

output "ssh" {
  description = "Comando para entrar al servidor."
  value       = "ssh -i ~/.ssh/sparkle_deploy deploy@${aws_eip.servidor.public_ip}"
}

output "bucket_backups" {
  description = "Bucket de backups. Va en el script de la fase I."
  value       = aws_s3_bucket.backups.id
}

output "id_instancia" {
  description = "ID de la instancia. Sirve para SSM Session Manager si te quedás afuera por SSH."
  value       = aws_instance.servidor.id
}

output "que_sigue" {
  description = "Los pasos inmediatos después del apply, para no tener que volver al plan."
  value       = <<-TXT

    ── Terminó el apply. En orden: ────────────────────────────────────

    1. Esperá ~3 minutos a que termine el cloud-init, y confirmalo:
         ssh -i ~/.ssh/sparkle_deploy deploy@${aws_eip.servidor.public_ip} 'cat /opt/sparkle/.cloud-init-ok'
       Si ese archivo no existe, el arranque se cortó a la mitad:
         ssh ... 'sudo tail -50 /var/log/user-data.log'

    2. Tailscale (paso F.2), a mano porque la clave es un secreto:
         ssh ... 'sudo tailscale up'
       Seguí el link que imprime, y después desactivá la expiración de
       clave del nodo en la consola de Tailscale (paso F.3) — si no, a los
       180 días el backend deja de ver Vexa sin ninguna señal clara.

    3. Namecheap (paso G.1): registro A, host `api`, valor
       ${aws_eip.servidor.public_ip}, TTL 5 min.

    4. ⚠️ NO despliegues hasta que el DNS propague:
         dig +short api.sparkleedu.me
       tiene que devolver ${aws_eip.servidor.public_ip}. Si Caddy pide el
       certificado antes, gastás intentos del rate limit de Let's Encrypt
       (5 fallos por hora).

    5. Secretos de GitHub (paso E.3), empezando por:
         gh secret set EC2_HOST --body ${aws_eip.servidor.public_ip}

    6. Guardá terraform.tfstate en Bitwarden. Tiene datos sensibles, está
       gitignoreado, y sin él Terraform no sabe qué recursos son suyos.

  TXT
}
