# Infraestructura

Todo lo que corre en AWS está descrito acá. La idea es que "volver a hostear
en otra cuenta" sea `terraform apply` y no media jornada de SSH.

```
infra/
  terraform/
    versions.tf         provider y versiones fijadas
    variables.tf        lo que hay que completar
    red.tf              VPC, subred, internet gateway, security group
    compute.tf          la instancia, el disco y la IP elástica
    iam.tf              rol de la instancia (S3 sin credenciales, SSM)
    almacenamiento.tf   bucket de backups y snapshots diarios del disco
    presupuesto.tf      alertas de gasto por mail
    outputs.tf          lo que hay que copiar a otros lados
    user_data.sh        cloud-init: Docker, Tailscale, swap, ufw
```

## Qué levanta

Una instancia EC2 en **sa-east-1** con Docker y Docker Compose, detrás de una
IP elástica, con el disco encriptado y con snapshot diario. Un bucket S3 para
los backups al que la instancia escribe **sin ninguna credencial en disco**
(instance profile). Alertas de presupuesto por mail.

**No levanta la aplicación.** El stack (Caddy + backend + MariaDB) lo despliega
el workflow de GitHub Actions de la fase E, que copia el compose y escribe los
`.env` desde los secretos. Terraform deja la máquina *lista para recibir* un
deploy, y nada más.

---

## Primera corrida

```bash
brew install hashicorp/tap/terraform      # si no lo tenés

cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Completá los tres valores de `terraform.tfvars`:

```bash
# tu IP pública (va con /32 al final)
curl -s https://checkip.amazonaws.com

# la clave SSH dedicada al deploy — NO uses tu clave personal (paso E.7)
ssh-keygen -t ed25519 -f ~/.ssh/sparkle_deploy -C "deploy sparkle v2"
cat ~/.ssh/sparkle_deploy.pub
```

Y las credenciales de AWS del usuario IAM (nunca las de la cuenta root):

```bash
aws configure
```

Después:

```bash
terraform init
terraform plan      # LEELO. Tiene que decir "10 to add" y nada de "destroy".
terraform apply
```

`terraform output` te dice qué hacer a continuación.

## Costo

~USD 32/mes: la instancia (~24), el disco (~3), la IPv4 pública (~4, la cobran
esté en uso o no desde febrero de 2024) y S3 más snapshots (~1). El desglose y
las tres palancas para bajarlo están en `Plan_Despliegue.md` §4.

**El reloj arranca con el `apply`.** `terraform destroy` lo para: borra todo lo
que este módulo creó. El bucket de backups también, así que si querés
conservarlos, bajalos antes.

---

## Las cinco cosas que hay que saber

### 1. El state es sensible y no está en git

`terraform.tfstate` guarda en texto plano todo lo que Terraform sabe, incluidos
datos que no querés en un repositorio. Está gitignoreado. **Copia en Bitwarden
después de cada `apply`**: sin él, Terraform no sabe qué recursos son suyos y un
`apply` intentaría crear todo de nuevo, en paralelo con lo que ya existe.

No hay backend remoto en S3 a propósito: son dos personas y solo una corre
`apply`. Y si el state se pierde igual, el escenario de recuperación es
exactamente el runbook de la fase J.

### 2. Editar `user_data.sh` REEMPLAZA la instancia

`user_data_replace_on_change = true`, y es deliberado: cloud-init corre una sola
vez, en el primer arranque, así que sin esa opción editar el script no haría
absolutamente nada y el servidor quedaría distinto de lo que dice el código.

La contrapartida es que **con el sistema en producción, tocar ese archivo destruye
y recrea el servidor**. Los volúmenes de Docker se van con él. Antes de tocarlo:
backup, y leé el `plan` completo.

Para un cambio puntual en una máquina que ya corre, entrá por SSH y hacelo a
mano — y después reflejalo en el script para que el próximo `apply` lo tenga.

### 3. Tu IP cambia

`var.mi_ip` es lo único que puede llegar al puerto 22. Una conexión hogareña
argentina cambia de IP cada tanto, y el día que pase te vas a encontrar con un
SSH que no responde.

El arreglo es actualizar la variable y correr `terraform apply` de nuevo: solo
cambia una regla del security group, no toca la instancia.

Si estás lejos de la máquina que tiene el state, la red de emergencia es **SSM
Session Manager**: consola desde la web de AWS, sin puerto 22 y sin clave. Ya
está habilitado. EC2 → la instancia → Connect → Session Manager.

### 4. Los secretos no pasan por acá

`user_data.sh` es legible desde adentro de la instancia con un `curl` al metadata
service — **cualquier proceso de la máquina, no solo root**. Por eso ahí no hay
ni una contraseña, ni la clave de Tailscale, ni nada.

Las credenciales las escribe el workflow de deploy por SSH en cada deploy, desde
los secretos de GitHub Actions. `tailscale up` se corre a mano, una vez.

### 5. Snapshot y backup no son lo mismo

Están los dos porque cubren cosas distintas:

- **El snapshot del disco** (diario, retiene 7) restaura la **máquina entera**:
  sistema, Docker, volúmenes, configuración. Sirve cuando lo que se rompe es el
  servidor.
- **El backup a S3** (fase I) restaura los **datos**: el dump de MariaDB y el tar
  de los PDFs. Sirve cuando lo que se rompe son los datos, y es lo único que
  sobrevive a que se pierda la cuenta de AWS entera.

---

## Problemas frecuentes

| Síntoma | Qué pasó |
|---|---|
| `terraform apply` no termina nunca en la instancia | Normal la primera vez: la instancia se crea rápido, pero el cloud-init tarda ~3 min más. Terraform no lo espera. |
| SSH da "Connection refused" o cuelga | El cloud-init no terminó todavía, o tu IP pública cambió (ver punto 3). |
| SSH entra pero `/opt/sparkle/.cloud-init-ok` no existe | El cloud-init se cortó a la mitad: `sudo tail -50 /var/log/user-data.log`. |
| El `plan` dice que va a destruir la instancia y vos no tocaste nada | Casi seguro cambiaste `user_data.sh` (ver punto 2), o Canonical publicó una AMI nueva y `most_recent = true` la tomó. |
| `Error: creating EC2 Instance: InvalidAMIID` | Cambiaste `tipo_instancia` a `t4g.*` sin poner `arquitectura_ami = "arm64"`. |
| Alertas de presupuesto que no llegan | AWS manda un mail de confirmación de suscripción la primera vez. Buscalo, incluido spam. |
