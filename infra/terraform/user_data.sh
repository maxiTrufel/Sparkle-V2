#!/bin/bash
# cloud-init de la instancia de Sparkle V2 (paso C.5).
#
# ⚠️ ACÁ NO VA NINGÚN SECRETO. El user_data es legible desde adentro de la
# instancia con un simple `curl` al metadata service — cualquier proceso de
# la máquina lo puede leer, no solo root. Las credenciales (base de datos,
# OpenAI, Vexa, la clave de Tailscale) las escribe el workflow de deploy por
# SSH, en cada deploy, desde los secretos de GitHub Actions.
#
# Este script deja la máquina LISTA para recibir un deploy, y nada más. Es
# idempotente en la práctica pero corre una sola vez, en el primer arranque.
set -euxo pipefail

# Todo lo que imprime queda en /var/log/user-data.log además del log de
# cloud-init. Cuando algo no funcione después del apply, ese archivo es lo
# primero que hay que mirar.
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

export DEBIAN_FRONTEND=noninteractive

# ─── Swap (4 GB) ───────────────────────────────────────────────────────
# Con 2 GB de RAM, MariaDB + Node + Caddy + un `docker compose pull` en
# simultáneo puede tocar el techo. Sin swap, el OOM killer elige una
# víctima —y suele elegir MariaDB, que es la que más memoria tiene
# reservada— y la clase se cae. Con swap el sistema se pone lento, que es
# muchísimo mejor que caerse.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Ubuntu viene con swappiness 60, que empieza a swapear con memoria libre
  # de sobra. 10 hace que la swap sea la red de emergencia que queremos y
  # no una fuente de lentitud permanente.
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-sparkle-swap.conf
fi

apt-get update
apt-get install -y ca-certificates curl gnupg unzip

# ─── Docker + plugin de compose ────────────────────────────────────────
# Del repositorio oficial de Docker y no del de Ubuntu: el `docker.io` de
# Ubuntu viene sin el plugin `docker compose` (v2), y `docker-compose` (v1,
# el script de Python) está discontinuado y no entiende parte de la sintaxis
# del compose de este proyecto.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Sin límite, los logs de Docker crecen hasta llenar los 30 GB del disco y
# el servidor se cae por "disco lleno" — un modo de falla lento, silencioso
# y muy fácil de evitar.
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker

# ─── Usuario `deploy` ──────────────────────────────────────────────────
# El workflow entra como `deploy`, no como `ubuntu` ni como root. La clave
# pública se copia de la que cloud-init ya le puso a `ubuntu` (la de
# `var.clave_publica_ssh`), así que es la misma clave con otro usuario.
if ! id -u deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
  usermod -aG docker deploy
  install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
  cp /home/ubuntu/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
fi

# Donde vive el stack. El workflow de deploy escribe acá el
# docker-compose.yml, el Caddyfile y los dos .env.
install -d -o deploy -g deploy /opt/sparkle

# ─── Tailscale ─────────────────────────────────────────────────────────
# Se instala pero NO se autentica: `tailscale up` necesita una clave de
# autenticación, y una clave de autenticación es un secreto — no puede
# estar acá (ver el aviso del encabezado). Queda para el paso F.2, a mano,
# por SSH, una sola vez.
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled

# ─── Firewall ──────────────────────────────────────────────────────────
# Redundante con el security group a propósito: son dos capas, y la de
# adentro sigue valiendo si alguien afloja el security group "un minuto
# para probar algo".
#
# `tailscale0` se permite entera: es la interfaz de la red privada, y es
# por donde el backend le habla a Vexa.
apt-get install -y ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow in on tailscale0
ufw --force enable

# ─── Actualizaciones de seguridad automáticas ──────────────────────────
# La máquina va a estar meses sin que nadie le entre. Solo `security`, que
# es lo que casi nunca rompe nada.
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# ─── AWS CLI (la usa el cron de backups de la fase I) ──────────────────
# Del instalador oficial y no de apt: el `awscli` de Ubuntu sigue siendo la
# versión 1, que no entiende parte de la configuración moderna. No necesita
# credenciales: las saca del instance profile.
ARCH_AWS="x86_64"
[ "$(dpkg --print-architecture)" = "arm64" ] && ARCH_AWS="aarch64"
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH_AWS}.zip" -o /tmp/awscli.zip
unzip -q /tmp/awscli.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscli.zip /tmp/aws

# Marca de que el arranque terminó bien. Si este archivo no existe después
# de un `apply`, el user_data se cortó a la mitad: mirá
# /var/log/user-data.log.
date -Is > /opt/sparkle/.cloud-init-ok
chown deploy:deploy /opt/sparkle/.cloud-init-ok

echo "user_data completo."
