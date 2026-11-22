# Recuperación

> **Este es el documento que se lee bajo presión.** Está escrito para eso: pasos
> concretos, en orden, sin explicaciones de fondo. El *por qué* de cada decisión
> está en `Plan_Despliegue.md`; acá está el *cómo*, y nada más.

## Antes que nada: ¿qué se rompió?

| Síntoma | Andá a |
|---|---|
| El sitio no responde, pero la instancia existe y entra por SSH | [1. El stack está caído](#1-el-stack-está-caído) |
| Un deploy dejó el sistema mal | [2. Rollback](#2-rollback) |
| Datos borrados o corrompidos, servidor sano | [3. Restaurar datos](#3-restaurar-datos) |
| La instancia no arranca, o no entra por SSH | [4. Perdí el servidor](#4-perdí-el-servidor) |
| Se perdió la cuenta de AWS entera | [5. Cuenta nueva desde cero](#5-cuenta-nueva-desde-cero) |
| Vexa no transcribe | [6. Vexa](#6-vexa) — *no es una emergencia, ver abajo* |

**Antes de tocar nada**, dos comandos que ahorran diagnosticar a ciegas:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.sparkleedu.me/
ssh -i ~/.ssh/sparkle_deploy deploy@api.sparkleedu.me 'cd /opt/sparkle && docker compose ps'
```

---

## 1. El stack está caído

```bash
ssh -i ~/.ssh/sparkle_deploy deploy@api.sparkleedu.me
cd /opt/sparkle
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 100
```

| Lo que ves | Qué hacer |
|---|---|
| Un contenedor `Exited` | `docker compose ... up -d` y mirá los logs de ese servicio |
| `db` en `unhealthy` | Suele ser disco lleno: `df -h`. Si es eso, `docker image prune -af` |
| Caddy loguea errores de certificado | Confirmá el DNS: `dig +short api.sparkleedu.me`. **No reinicies Caddy en loop** — Let's Encrypt permite 5 fallos por hora |
| Todo "corriendo" pero da 502 | El backend arranca y muere. `docker compose ... logs backend`; casi siempre es un `.env` incompleto |
| No entra por SSH | Ver [4](#4-perdí-el-servidor) |

**Disco lleno** es la causa más probable de una caída sin que nadie haya tocado nada:

```bash
df -h /
docker system df
docker image prune -af          # ⚠️ -a borra también la imagen anterior: pierde el rollback rápido
sudo journalctl --vacuum-time=7d
```

---

## 2. Rollback

Volver a la versión anterior. **~40 segundos.**

```bash
gh workflow run deploy.yml -f version=v0.1.0
gh run watch
```

La imagen vieja sigue en GHCR y el workflow no la reconstruye: despliega
exactamente el binario que estaba corriendo antes.

> ⚠️ **El rollback NO revierte el esquema de la base.** Las migraciones son
> forward-only: el código viejo va a correr contra una base ya migrada. Si el
> release que estás revirtiendo traía una migración *no* compatible hacia atrás,
> el rollback no alcanza — hay que restaurar datos ([3](#3-restaurar-datos)).
>
> Por eso toda migración tiene que ser compatible hacia atrás. La regla y cómo
> partir cada tipo de cambio están en `backend/migrations/README.md`.

---

## 3. Restaurar datos

```bash
ssh -i ~/.ssh/sparkle_deploy deploy@api.sparkleedu.me
cd /opt/sparkle/backups

./restaurar.sh                          # lista los backups disponibles
./restaurar.sh 2026-09-05T06-00-00Z     # restaura ese
./restaurar.sh --local <fecha>          # desde el disco, sin bajar de S3 (más rápido)
```

El script pide confirmación escrita, baja el backend, restaura la base **y** los
PDFs de la misma corrida, levanta todo y aplica las migraciones pendientes.

**Verificá a mano antes de darlo por bueno:** abrí una clase que tenga un PDF
adjunto y confirmá que el documento está. Es el punto del ejercicio — si la base
lista un archivo que no está en disco, el backup no servía.

---

## 4. Perdí el servidor

### Primero: ¿es solo el SSH?

El puerto 22 está abierto **solo a la IP declarada en `var.mi_ip`**, y una
conexión hogareña cambia de IP. Antes de dar el servidor por muerto:

```bash
curl -s https://checkip.amazonaws.com     # ¿cambió tu IP?
```

Si cambió: actualizá `mi_ip` en `infra/terraform/terraform.tfvars` y `terraform
apply`. Cambia una regla del security group, no toca la instancia.

Si no podés correr Terraform, entrá por **SSM Session Manager** (no usa el 22 ni
clave): consola de AWS → EC2 → la instancia → *Connect* → *Session Manager*.

### Si la instancia está muerta de verdad

**Opción A — desde un snapshot** (más rápido, recupera la máquina entera):
consola de AWS → EC2 → Snapshots → el más reciente con la etiqueta
`Snapshot=diario` → *Create volume* → desasociar el volumen viejo de la instancia
y asociar el nuevo como `/dev/sda1`.

**Opción B — recrear con Terraform** (más limpio, pierde lo que no esté en el
backup):

```bash
cd infra/terraform
terraform apply -replace=aws_instance.servidor
```

La IP elástica se reasocia sola, así que **el DNS no hay que tocarlo**. Después:
esperá el cloud-init, reautenticá Tailscale, restaurá el backup y redesplegá.

```bash
ssh -i ~/.ssh/sparkle_deploy deploy@api.sparkleedu.me 'cat /opt/sparkle/.cloud-init-ok'
ssh -i ~/.ssh/sparkle_deploy deploy@api.sparkleedu.me 'sudo tailscale up'
gh workflow run deploy.yml -f version=vX.Y.Z
# y después: restaurar.sh, sección 3
```

---

## 5. Cuenta nueva desde cero

El escenario completo: se acabaron los créditos, se perdió la cuenta, o hay que
mudarse. **~20 minutos**, más la propagación del DNS.

### Lo que necesitás tener a mano (todo esto vive en Bitwarden)

- Credenciales de la cuenta de AWS nueva
- `~/.ssh/sparkle_deploy` (la clave privada)
- El último backup — **si el bucket de S3 se fue con la cuenta vieja, se fue con
  ella.** Es el único paso de esta lista que no se puede improvisar.

### Los pasos

```bash
# 1 · Credenciales de la cuenta nueva
aws configure

# 2 · Levantar todo. ~4 min.
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # completar mi_ip, clave, mail
terraform init
terraform apply
terraform output                               # anotá ip_publica y bucket_backups

# 3 · DNS en Namecheap: el registro A de `api` → la IP nueva. TTL 5 min.
#     ⚠️ ESPERAR a que propague antes de desplegar:
dig +short api.sparkleedu.me
#     Tiene que devolver la IP nueva. Si Caddy pide el certificado antes,
#     gastás intentos del rate limit de Let's Encrypt (5 fallos/hora).

# 4 · Actualizar los secretos que cambiaron
gh secret set EC2_HOST --body "<ip-nueva>"
gh secret set BUCKET_BACKUPS --body "<bucket-nuevo>"

# 5 · Tailscale: aprobar el nodo nuevo en la consola, y
ssh -i ~/.ssh/sparkle_deploy deploy@<ip-nueva> 'sudo tailscale up'
#     ⚠️ Y desactivá la expiración de clave del nodo. Si no, a los 180 días
#     el backend deja de ver Vexa sin ninguna señal clara.

# 6 · Desplegar
gh workflow run deploy.yml -f version=vX.Y.Z
gh run watch

# 7 · Restaurar el backup (sección 3), subiéndolo primero al bucket nuevo si
#     lo tenías bajado a mano.
```

### Lo que NO hace falta rehacer

Los secretos de la aplicación (OpenAI, Vexa, la clave de la API, las contraseñas
de la base) viven en GitHub Actions, **no en AWS**. Una cuenta nueva de AWS no
los toca. Fue el motivo de elegir GHCR sobre ECR y GitHub Secrets sobre SSM
Parameter Store: que "mudarse de cuenta" no implique rotar nada.

---

## 6. Vexa

**Que Vexa esté caído no es una emergencia.** El sistema tiene un modo degradado
conocido y previsto:

| Sigue andando | Deja de andar |
|---|---|
| Detección de atención, alertas individuales y grupales | Transcripción en vivo |
| WebSocket, roles, listado de alumnos | Recuperar contenido |
| Subida y análisis de PDF | Resumen de clase |
| Mapas de calor, reportes, PDF del docente | Generación de preguntas con IA |

Diagnóstico, en orden:

```bash
# ¿La notebook está en la tailnet?
tailscale status

# ¿El EC2 la ve?
ssh deploy@api.sparkleedu.me 'ping -c2 sparkle-vexa'

# ¿Vexa responde?
ssh deploy@api.sparkleedu.me 'curl -s -m5 http://sparkle-vexa:8056/ -H "X-API-Key: $VEXA_BOT_API_KEY"'

# En la notebook:
make -C deploy/lite up LOCAL_STT=1 WHISPER_MODEL=Systran/faster-whisper-small
```

**La causa número uno, y no da ninguna señal clara:** la clave del nodo de
Tailscale expiró (por defecto lo hace a los 180 días). Miralo en la consola de
Tailscale antes que cualquier otra cosa.

---

## Lo que hay que tener en Bitwarden

Si algo de esta lista falta, el runbook no funciona. Revisalo hoy, no el día que
haga falta.

- [ ] Credenciales de la cuenta de AWS
- [ ] `~/.ssh/sparkle_deploy` — la clave privada
- [ ] `infra/terraform/terraform.tfstate` — copia después de cada `apply`
- [ ] Todos los secretos de GitHub Actions
- [ ] La `key` privada de la extensión (`.pem`), si existe
- [ ] Acceso a Namecheap
- [ ] Acceso a la cuenta de developer de la Chrome Web Store

---

## J.2 — Ensayarlo

**Un runbook sin ensayar es ficción.** El ensayo mínimo, en un momento en que no
haya nada en juego:

```bash
cd infra/terraform
terraform apply -replace=aws_instance.servidor    # ~4 min
# esperar el cloud-init, tailscale up, desplegar, restaurar el backup
```

Cronometralo y anotá acá abajo lo que no coincidió con lo que dice este
documento. Lo que sale mal en un ensayo es gratis.

**Última vez ensayado:** _(sin ensayar todavía — J.2)_
