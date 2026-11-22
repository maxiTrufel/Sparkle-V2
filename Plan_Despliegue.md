# Plan de Despliegue — Sparkle V2

> **Documento único.** Todo lo necesario para pasar de "corre en mi máquina" a "corre en
> internet" está acá. Reemplaza a cualquier plan anterior.
>
> **Fecha:** 4 de septiembre de 2026 · **Equipo:** Isola (A) · Trufelman (B)
> **Presentación:** ~enero 2027 · **Verificado contra:** el código real en `sparkle/` y `vexa/`

**Marcadores:** 🔀 se puede en paralelo · 🔒 punto de sincronización · ⚠️ es fácil romper algo.

---

## 1. Estado actual, auditado

### Ya está hecho — no lo rehagas

| | Dónde |
|---|---|
| ✅ Dockerfile del backend | `backend/Dockerfile` — `node:22-slim`, tini como PID 1, usuario sin privilegios, healthcheck |
| ✅ Compose de producción | `docker-compose.yml` — Caddy + backend + `mariadb:10.11`, redes `edge`/`internal` |
| ✅ Los tres volúmenes persistentes | `db_data`, `uploads_data`, `caddy_data` |
| ✅ Reverse proxy y TLS | `Caddyfile` — un solo `reverse_proxy`, WebSocket incluido, sin CORS duplicado |
| ✅ `key` fija en el manifest | ID de la extensión descomprimida: `kcjeagahhmdfdmgnoidbpmhbfiggbeif` |
| ✅ `host_permissions` con el dominio real | `https://api.sparkleedu.me/*` |
| ✅ Dominio comprado | `sparkleedu.me` en Namecheap (hoy apunta a GitHub Pages) |
| ✅ Modelos de atención en disco | Los 6 archivos, incluido el opcional `modelo_B_tcn_fusion.tflite` |
| ✅ Guard en `init-db` | Aborta si `NODE_ENV=production` sin `--force` |
| ✅ `engines: node >=22` y `.nvmrc` | En `backend/` — el lockfile quedó sin commitear, ver A.9 |
| ✅ Chequeo temprano de variables de Vexa | `vexaService.js` avisa al arrancar cuáles faltan |
| ✅ URL del backend cambiable **sin recompilar** | `frontend/src/config.js` → `chrome.storage.local.backendUrl` |

Ese último punto es más importante de lo que parece: te deja publicar **un solo build**
apuntando a producción y que cada uno lo apunte a su `localhost` desde la página de opciones.

### Falta

| | Impacto |
|---|---|
| ❌ `frontend/.env` sigue en `VITE_BACKEND_URL=http://localhost:3000` | La extensión no encuentra el backend |
| ⚠️ `frontend/dist/` existe pero tiene `localhost` horneado (`grep -c` da 1) | Hay que rebuildear después de tocar `frontend/.env` |
| ❌ No existe `.github/` | Cero CI, cero CD |
| ❌ No hay migraciones — solo `init-db.js`, que dropea las 12 tablas | Bloquea seguir desarrollando con datos en producción |
| ❌ No hay infraestructura como código | "Volver a hostear" = media jornada de SSH |
| ❌ Los modelos `.tflite` están gitignorados | Un build en CI saldría con la detección de atención rota **sin dar error** |
| ❌ **Ninguna ruta de la API tiene autenticación** | Ver §7 |
| ❌ `DOCUMENTACION.md` §12 dice "sin Dockerfile, sin CI/CD, sin scripts de deploy" | Desactualizado desde que existe el Dockerfile |

---

## 2. Los tips de tu amigo, evaluados

Te dio un buen consejo de **hosting**. Lo que necesitás es un plan de **ciclo de vida**.
No es lo mismo, y la diferencia es donde te va a doler.

### "1 VPS (front, back, s3… etc.)" — correcto, pero no por el motivo obvio

La razón por la que está bien no es "simplicidad" en abstracto. Es concreta: **tu
`docker-compose.yml` ya existe y está bien hecho.** La alternativa AWS-nativa (ECS/Fargate
+ RDS + ALB + ECR) sale ~USD 65/mes en São Paulo — el ALB solo son ~USD 25 antes de mandarle
un byte — y te obliga a tirar ese compose. Para 20 alumnos en una clase de prueba no aporta
absolutamente nada. Consolidar es la decisión correcta.

Ahora, tres matices que él no podía saber:

**El "front" no aplica.** No hay front web: es una extensión de Chrome. El propio `Caddyfile`
lo deja escrito — no hay `express.static` que montar. El VPS lleva **backend + MariaDB +
Caddy**, nada más. La distribución del "front" es la Chrome Web Store.

**"S3" es lo contrario de consolidar, y es la parte que más merece discusión.** Si te lo dijo
pensando en mover los PDFs del docente a S3 en vez del volumen local, es la única
externalización que valdría la pena pensar: dejaría el servidor casi sin estado y
simplificaría los backups. **Lo descarto igual**, y a propósito: obliga a tocar
`backend/src/utils/uploadStorage.js`, y el volumen + `tar` diario a S3 cubre el mismo riesgo
sin cambiar código. En este plan S3 aparece **solo como destino de backups**.

**La parte genuinamente debatible es la base de datos en la misma máquina.** Eso significa
que MariaDB y Node compiten por los mismos 2 GB, y que los backups son enteramente tu
problema. Acá está bien porque tu volumen de datos es diminuto y el cron + S3 lo cubre, pero
es el punto que un revisor de arquitectura te va a marcar, y conviene tener la respuesta
lista, no improvisarla.

**Y el riesgo que nadie mencionó: una sola máquina es un solo punto de falla, y tenés una
defensa en vivo.** Si el EC2 muere la semana de la presentación, sin el runbook de la Fase J
estás reconstruyendo a mano bajo presión. Con Terraform + backups son ~20 minutos. Por eso
la Fase J no es opcional.

### "Automatizar deploys (GitHub Actions)" — correcto, pero el valor no está donde parece

Son ~4,5 h de las ~17 del plan. Si fuera **solo** para no tipear comandos de deploy, un
`make deploy` de 15 líneas sería defendible: vas a deployar unas 20 veces, no 2000.

Lo que lo justifica es la otra mitad: **CI corriendo tus 130 tests de backend y los ~30 de
frontend en cada PR**, antes de que nada llegue a la demo. Tenés una suite de tests
excelente que hoy solo corre cuando alguien se acuerda. Sumale rollback en 40 segundos y
reproducibilidad. El "deploy" es la parte barata; la "integración continua" es la que paga.

### Lo que no te dijo, ordenado por cuánto te va a doler

1. **Migraciones de base.** Te respondió *dónde vive* el sistema; no *cómo cambia*. Es la
   pieza que falta para poder seguir desarrollando con algo hosteado, y es exactamente lo
   que pediste. Sin esto, el primer `ALTER TABLE` post-deploy te obliga a elegir entre no
   desplegarlo o borrar los datos.
2. **Infraestructura como código.** Es literalmente lo otro que pediste ("que sea fácil
   volver a hostear en otra cuenta").
3. **Rollback.** Automatizar deploys sin rollback es automatizar también el desastre.
4. **Backups fuera del servidor.** Un backup en el mismo disco que la base no es un backup.
5. **Autenticación.** Hoy no hay ninguna (§7).

### El veredicto honesto

Tu amigo no conocía tu proyecto: no sabía de Vexa, ni de que el front es una extensión, ni
de que ibas a AWS, ni de que querías seguir desarrollando. "1 VPS + GitHub Actions" es un
buen consejo genérico que **acá encaja bien**, pero no es una revisión de arquitectura de
*tu* sistema — y él probablemente te diría lo mismo. Tomalo como el punto de partida
correcto, no como el diseño terminado.

---

## 3. Arquitectura objetivo

```
  ┌─ Chrome Web Store (no listada) ──────────────┐
  │  Extensión Sparkle V2                        │
  │  · detección de atención (LiteRT, LOCAL)     │
  │  · id fijo por `key` del manifest            │
  └───────────────┬──────────────────────────────┘
                  │  https + wss  (api.sparkleedu.me)
                  ▼
  ══════════════ AWS · sa-east-1 (São Paulo) ══════════════
  ┌────────────────────────────────────────────────────────┐
  │  EC2 t3.small · Ubuntu 24.04 · Elastic IP              │
  │  Security Group: 22 (tu IP), 80, 443                   │
  │                                                        │
  │   docker compose:                                      │
  │     caddy   :80 :443  ── TLS automático (Let's Encrypt)│
  │       └─► backend :3000  (red `edge`)                  │
  │             └─► mariadb  (red `internal`, sin salida)  │
  │                                                        │
  │   volúmenes: db_data · uploads_data · caddy_data       │
  │   cron: dump + tar ──► S3 (versionado, 30 días)        │
  └───────┬────────────────────────────────┬───────────────┘
          │ Tailscale (WireGuard)          │ https
          │ 100.x.x.x, sin puerto público  ▼
          ▼                             OpenAI API
  ┌──────────────────────────────────────────────┐
  │  TU NOTEBOOK (casa)                          │
  │   make -C deploy/lite up LOCAL_STT=1         │
  │   vexa-lite :8056  ← solo por tailscale0     │
  │   Whisper small (CPU) + Chrome headless      │
  └──────────────────────────────────────────────┘

  ══════════════ Cadena de entrega ══════════════
  feat/* ─PR─► main ─CI─► tag vX.Y.Z
                            ├─► GHCR (imagen backend, tag = versión)
                            ├─► ssh EC2: migrate + compose up -d
                            └─► GitHub Release con extension-vX.Y.Z.zip
```

**Un solo servidor.** Vexa no se despliega: corre en tu notebook y se alcanza por red
privada. Eso elimina el segundo servidor entero, la red privada entre máquinas, su firewall,
su snapshot y toda la operativa de crearlo y destruirlo por sesión.

---

## 4. Decisiones tomadas, y por qué

| Decisión | Elegido | Por qué, y contra qué |
|---|---|---|
| Región | **sa-east-1** (São Paulo) | ~25-40 ms desde Argentina contra ~120 ms de Virginia. El sistema son alertas de atención en tiempo real, y el backend además le habla a Vexa en tu casa: dos saltos donde la latencia se nota. Cuesta ~40% más. |
| Cómputo | **1× EC2 t3.small** (2 vCPU / 2 GB) | 1 GB (t3.micro) es apretado para MariaDB + Node + Caddy juntos. Con 2 GB + 4 GB de swap va sobrado. **Alternativa más barata: `t4g.small` (ARM Graviton, ~20% menos).** Debería andar — `@napi-rs/canvas` publica prebuild `linux-arm64-gnu` — pero confirmalo con un `docker buildx --platform linux/arm64` local antes de comprometerte. |
| Orquestación | **docker compose en la instancia** | El compose ya existe y está bien pensado. ECS/Fargate = reescribirlo y 4× el costo. |
| Base de datos | **MariaDB en contenedor**, no RDS | RDS son ~USD 20/mes por lo mismo. Sus ventajas reales (backups gestionados, failover) no compensan a esta escala. |
| Registry de imágenes | **GHCR** (`ghcr.io`), no ECR | La autenticación desde Actions es una línea (`GITHUB_TOKEN`) y **no te ata a la cuenta de AWS** — justo lo que querés evitar. ECR obligaría a configurar OIDC solo para esto. |
| IaC | **Terraform**, no CDK/CloudFormation | Portable: si los créditos se acaban y hay que mudarse, cambiás el `provider` y conservás el modelo. CloudFormation te encadena a AWS. |
| Secretos | **GitHub Actions Secrets** como fuente única, copia en Bitwarden | El workflow escribe los `.env` en el servidor en cada deploy. Evita un segundo almacén (SSM Parameter Store) y hace que "cuenta nueva de AWS" no toque los secretos en absoluto. |
| Vexa | **Tailscale** | Vexa queda **sin exposición pública** — que es lo que afirma la sección 3.7.2 de la tesis; con un túnel público esa afirmación sería falsa. Funciona detrás de CGNAT y de IP dinámica (crítico en una conexión hogareña argentina). Nombre estable vía MagicDNS. |
| Disparo del deploy | **Tag `vX.Y.Z`** + botón manual | `main` avanza sin tocar producción. El tag coincide con la `version` del manifest: "qué está desplegado" y "qué está en la Store" pasan a ser la misma pregunta. |
| Esquema de base | **Migraciones numeradas** | Ver §6. |
| DNS | **Se queda en Namecheap** | Un registro A que tocás una vez cada seis meses no justifica una zona hospedada en Route 53. |

### Costo estimado

| Concepto | USD/mes |
|---|---|
| EC2 t3.small | ~24 |
| EBS 30 GB gp3 | ~3 |
| IPv4 pública — AWS la cobra desde feb-2024, esté en uso o no | ~4 |
| S3 backups + snapshots EBS | ~1 |
| **Total AWS** | **~USD 32/mes** |
| OpenAI (pruebas, todo `gpt-4o-mini`) | pocos dólares |
| Chrome Web Store (pago único) | 5 |

**~USD 160 en 5 meses.** Si el crédito de tu cuenta se queda corto, tres palancas en este
orden: (1) `t4g.small` en vez de `t3.small`, −USD 5/mes; (2) mover a `us-east-1`, −USD 10/mes
a costa de latencia; (3) Savings Plan de 1 año, −~30%, solo si estás seguro de llegar a la
defensa.

> ⚠️ **Verificá qué free tier te tocó.** AWS cambió el modelo a mediados de 2025: las cuentas
> nuevas reciben créditos (USD 100 + hasta USD 100 más por completar actividades) en vez de
> las 750 h/mes de t3.micro por 12 meses. Miralo en **Billing → Free Tier** antes de
> dimensionar, y poné un **Budget con alerta al 50% y al 80%** el día uno.

---

## 5. Ramas de git y cómo trabajar mientras está hosteado

```
main            ●───────●───────●───────●───────●
                 ╲     ╱ tag v0.2.0    ╱  tag v0.3.0
feat/migraciones  ●───●                │
feat/ci                    ●───────●───╯
```

| Rama | Para qué | Reglas |
|---|---|---|
| `main` | Lo integrado y con CI en verde | Protegida: solo por PR. **No deploya.** |
| `feat/<cosa>` | Trabajo en curso | Cortas — días, no semanas. Una por unidad de trabajo. |
| `fix/<cosa>` | Arreglos | Igual que `feat/`. |
| `hotfix/<cosa>` | Producción rota | Sale de la tag desplegada, no de `main`. Se mergea a `main` después. |
| tag `vX.Y.Z` | Lo que está en producción | **Único disparador de deploy.** Se crea desde `main`. |

**El reparto de trabajo:** A toca `backend/` e `infra/`, B toca `frontend/` y `vexa/`. No es
arbitrario — con PRs y CI, dos personas en las mismas carpetas generan conflictos que el CI
no puede resolver por vos.

**La versión es una sola.** Antes de taguear, que coincidan `frontend/public/manifest.json`
(`version`), `frontend/package.json`, `backend/package.json` y el tag. Vale un script
`npm run version -- 0.2.0` que toque las cuatro.

```bash
git switch main && git pull
git switch -c feat/mapa-de-calor-por-tramo
# ... trabajás, commiteás ...
git push -u origin feat/mapa-de-calor-por-tramo
gh pr create --fill                      # CI corre solo
gh pr merge --squash                     # main avanza, producción NO se toca
# ... más features ...
# cuando querés que salga:
git switch main && git pull
npm run version -- 0.2.0 && git commit -am "v0.2.0" && git push
git tag v0.2.0 && git push origin v0.2.0 # ← ACÁ deploya
```

**Rollback:** `gh workflow run deploy.yml -f version=v0.1.0`. La imagen vieja sigue en GHCR,
así que es un `docker compose up -d` con otro tag: ~40 segundos. Ojo: **las migraciones no se
revierten solas** — ver §6.

**Reglas de higiene:** los secretos van al gestor de contraseñas, nunca a git ni a WhatsApp
— y eso incluye el `.pem` de la extensión. Ninguna fase empieza si la anterior no está
cerrada; el orden está pensado para que los errores aparezcan cuando todavía son baratos.

---

## 6. Migraciones — la pieza que falta

Hoy `backend/scripts/init-db.js` dropea las 12 tablas y las recrea. Es correcto para
desarrollo y es lo único que hay. Con algo hosteado, el primer `ALTER TABLE` te deja sin salida.

**Diseño** (forward-only, sin dependencias nuevas):

```
backend/migrations/
  001_esquema_inicial.sql      ← el DDL actual de init-db.js, tal cual
  002_<lo-que-venga>.sql
backend/scripts/migrate.js     ← el runner
```

El runner crea `schema_migrations (version VARCHAR(64) PRIMARY KEY, aplicada_en DATETIME)`,
lee `migrations/*.sql` ordenados, aplica los que no estén registrados y registra cada uno.
Idempotente: correrlo dos veces no hace nada la segunda. `npm run migrate`.

`init-db.js` **se queda** para desarrollo (reset limpio). Lo que cambia es que producción
nunca más lo ve: el deploy corre `migrate`, no `init-db`.

**Dos advertencias que van en el README del directorio:**

1. **MariaDB no tiene DDL transaccional.** Un `.sql` con tres `ALTER` que falla en el segundo
   deja la base a medio migrar y hay que arreglarla a mano. Regla: **una migración, un
   cambio.** Archivos chicos.
2. **Forward-only, sin `down`.** Revertir un deploy revierte el código, no el esquema. Por eso
   las migraciones tienen que ser **compatibles hacia atrás**: agregar columnas nullable antes
   de usarlas, borrar columnas un release después de dejar de leerlas.

---

## 7. Autenticación — la decisión que hay que tomar antes de publicar

**Hoy ninguna ruta de la API pide credenciales.** El único control es la whitelist de CORS
con `ALLOWED_EXTENSION_IDS`, y **CORS solo frena navegadores**. El código lo dice explícito
en `backend/src/server.js`:

> *"los requests sin header Origin (curl, Postman, server-to-server) no pasan por el chequeo
> de CORS del navegador y se dejan pasar igual"*

El WebSocket hace lo mismo en `verifyClient` (`ws/index.js:98`): `if (!origin || ...)`.

Fue la decisión correcta mientras el backend estaba en `localhost`. En un dominio público
significa que **cualquiera que sepa el código de un Meet puede bajarse la transcripción
completa de esa clase** con una línea de terminal:

```bash
curl https://api.sparkleedu.me/api/meetings/abc-defg-hij/transcript
```

Y el código de Meet no es un secreto: lo tienen todos los que estuvieron en la clase.

**Tres opciones, de menor a mayor esfuerzo:**

| Opción | Esfuerzo | Cuándo alcanza |
|---|---|---|
| **A. Aceptarlo y documentarlo.** Extensión no listada, solo clases de prueba con gente del equipo, sin datos de alumnos reales. | 0 h | Si la tesis nunca corre con un curso real |
| **B. Secreto compartido.** Un header `X-Sparkle-Key` con un token largo, horneado en el build de la extensión, validado en un middleware. | ~1,5 h | Frena el escaneo oportunista. No frena a alguien que descomprima el `.crx` |
| **C. Sesión real por reunión.** El backend emite un token al registrarse en la reunión y lo exige en el resto de las rutas y en el WS. | ~6-8 h | Lo correcto si alguna clase real se graba |

**Recomendación: B ahora, y decidir C según si la tesis se prueba con un curso real.** B es
barato, cierra el agujero obvio y no cambia la arquitectura. Y si el tribunal pregunta por
seguridad —y con una sección 3.7.2 sobre exposición de red, va a preguntar— tener la
respuesta con el trade-off explícito vale más que no haberlo pensado.

Va como paso **A.7** de la Fase A.

---

## 8. Vexa

`vexa/` (`Sparkle_V2_Vexa_Transcripcion`) **no se despliega**. Corre en tu notebook con
`make -C deploy/lite up LOCAL_STT=1 WHISPER_MODEL=Systran/faster-whisper-small` y se alcanza
por Tailscale.

⚠️ **`faster-whisper-small`, sin el `.en`.** El default de `lite` es
`Systran/faster-whisper-tiny.en`: `tiny` transcribe mal y `.en` es **solo inglés**. Las clases
son en español.

**Modo degradado.** Si la notebook está apagada, el backend arranca igual y todo funciona
salvo lo que depende de la transcripción. No es un error, es el comportamiento esperado:

| Anda sin Vexa | Necesita Vexa |
|---|---|
| Detección de atención, alertas individuales y grupales | Transcripción en vivo |
| WebSocket, roles, roster | Recuperar contenido |
| Subida y análisis de PDF | Resumen de clase |
| Mapas de calor, reportes, PDF del docente | Generación de preguntas con IA |

**Secretos de dev sin rotar — prioridad baja, pero hacelo.** `deploy/compose/.env.example`
trae 9 valores de desarrollo conocidos públicamente. Ya no están expuestos a internet, pero
tu notebook está en una red doméstica:

```
DB_PASSWORD=postgres                 MINIO_ACCESS_KEY=vexa-access-key
MINIO_ROOT_USER=vexa-access-key      MINIO_SECRET_KEY=vexa-secret-key
MINIO_ROOT_PASSWORD=vexa-secret-key  ADMIN_TOKEN=dev-admin-token
INTERNAL_API_SECRET=vexa-internal-secret
VEXA_DISPATCH_SIGNING_KEY=dev-dispatch-signing-key
NEXTAUTH_SECRET=dev-nextauth-secret
```

⚠️ `lite` levanta su propio PostgreSQL y su MinIO como sidecars: revisá qué toma del `.env` y
qué pasa por variables del `Makefile` antes de dar por rotado nada. Generalos con
`openssl rand -hex 32`.

**El repo tiene un solo commit** ("primer commit"). Si le hiciste cambios al fork respecto del
upstream de Vexa, no están registrados como tales. Vale un `DIFERENCIAS.md` que los documente
— si mañana hay que actualizar desde upstream, es la diferencia entre una tarde y una semana.

---

## 9. Fases

### FASE A — Preparar el repo · 🔀 · ~3,5 h · local, gratis

- [x] **A.1 — ⚠️ Arreglar el repo de git en tu home.** `/Users/maximotrufelman` **es un
      repositorio de git**, con ramas (`develop`, `feat/CU-07-mapa-tiempo-real`,
      `feat/jwt-contrato-squad2`, `feat/sprint-1-nucleo-del-modulo`) que parecen de otra
      materia. Un `git add -A` desde cualquier carpeta de tu usuario que no sea un repo propio
      va a intentar stagear tu home entero, claves SSH incluidas. Movelo a donde corresponda o
      borrá ese `.git`. **Antes de tocar nada más.**
- [x] **A.2 — Decidir qué pasa con los modelos.** `public/models/*.tflite`, `*.task` y
      `preprocesamiento.json` están gitignorados (~4,7 MB). El CI no los va a tener y el build
      saldría con la detección de atención rota **sin dar error** — lo dice
      `public/models/README.md`: sin `preprocesamiento.json` el modelo recibe features sin
      normalizar y devuelve predicciones sin sentido, en silencio.
      → **Recomendación: commitealos.** 4,7 MB no es nada y hace el repo autocontenido. La
      alternativa (asset de un GitHub Release descargado por el workflow) es más "prolija" y
      peor: una dependencia externa más que se puede perder.
- [x] **A.3 — `VITE_BACKEND_URL=https://api.sparkleedu.me`** en `frontend/.env`.
- [x] **A.4 — Rebuild** (`npm run build`) y medir el ZIP real. El `dist/` actual es del 4/9 y
      tiene `localhost:3000` horneado — verificado, `grep -c` da **1**. Después del rebuild
      debe dar **0**. Los 6 modelos ya salen bien en el `dist/` local; el problema de A.2 es
      solo en CI, donde el checkout no los trae.
- [ ] **A.5 — Protección de rama en `main`:** requerir PR + checks de CI (Settings → Branches).
- [x] **A.6 — `npm audit fix`** en el frontend. De las 6 vulnerabilidades, solo 1 es de runtime
      (DOMPurify, XSS, entra vía `jspdf`); las otras 5 son de build (`vite`/`esbuild`) y no
      viajan en el paquete de la extensión.
- [x] **A.7 — Decidir e implementar la autenticación** (§7). Recomendado: opción B.
- [x] **A.9 — Commitear `backend/package-lock.json`**, que tiene sin commitear el bloque
      `engines: { node: ">=22" }`. Trivial, pero mientras esté suelto todo `git status` arranca
      con ruido.
- [x] **A.8 — Actualizar `DOCUMENTACION.md` §12 "Despliegue"**, que hoy dice "no hay ningún
      artefacto de despliegue en el repositorio". Referenciar este plan.

### FASE B — Migraciones · A · ~1,5 h · local

- [x] **B.1 —** Extraer el DDL de `init-db.js` a `backend/migrations/001_esquema_inicial.sql`.
- [x] **B.2 —** Escribir `backend/scripts/migrate.js` + `"migrate"` en los scripts del package.
- [x] **B.3 —** `backend/migrations/README.md` con las dos advertencias de §6.
- [x] **B.4 —** Probarlo: base vacía → `migrate` → esquema completo, idéntico al de `init-db`.
      Correrlo dos veces seguidas: la segunda no hace nada.
- [x] **B.5 —** Que la suite de tests (130 casos) siga en verde.

### FASE C — Infraestructura como código · A · ~3 h · **acá arranca el gasto**

Todo en `infra/terraform/` del repo `sparkle`.

- [x] **C.1 —** Cuenta AWS: usuario IAM para vos (la cuenta root solo para facturación), MFA
      en root, y **Budget con alertas por mail**.
- [x] **C.2 —** `main.tf`: VPC, subnet pública, internet gateway, route table.
- [x] **C.3 —** Security group: **22 solo desde tu IP** (variable `mi_ip`), 80 y 443 abiertos.
      Tailscale no necesita ningún puerto entrante — hace NAT traversal.
- [x] **C.4 —** Instancia EC2 Ubuntu 24.04 LTS, EBS 30 GB gp3, + Elastic IP asociada.
- [x] **C.5 —** `user_data` (cloud-init): Docker + plugin de compose, Tailscale, 4 GB de swap,
      usuario `deploy`, `/opt/sparkle`. ⚠️ **Ningún secreto acá** — el user_data es legible
      desde el metadata service de la instancia.
- [x] **C.6 —** Bucket S3 para backups (versionado + lifecycle a 30 días) + IAM role e instance
      profile para que la instancia escriba ahí sin claves.
- [x] **C.7 —** Política DLM: snapshot diario del EBS, retener 7. Cuesta centavos.
- [x] **C.8 —** `outputs.tf`: la Elastic IP y el hostname. Es lo que copiás al DNS.
- [x] **C.9 — ⚠️ `terraform.tfstate` va gitignoreado** (tiene datos sensibles). Copia en
      Bitwarden. *No* hace falta backend remoto en S3 para dos personas donde solo A corre
      `apply` — y si el state se pierde, el escenario de recuperación es exactamente el
      runbook de la Fase J.
- [x] **C.10 —** `terraform apply`. **A partir de acá el reloj corre.**

### FASE D — Integración continua · 🔀 · ~2 h

`.github/workflows/ci.yml`, en PRs y en push a `main`.

- [x] **D.1 — Job `backend`:** service container `mariadb:10.11`, Node 22, `npm ci`,
      `npm run migrate`, `npm test`. Debe dar **130/130**.
- [x] **D.2 — Job `frontend`:** Node 22, `npm ci`, `npm test`.
      ⚠️ **Investigá esto primero:** `App.integracionBackendReal.test.js` y
      `CameraPreview.integracionBackendReal.test.js` levantan el Express y el WS **reales** en
      proceso, así que probablemente necesiten MariaDB también. Resolvelo antes de dar el job
      por hecho — si no, el CI queda verde ignorando justo los tests que más valen.
- [x] **D.3 — Job `build`:** `npm run build`, subir `dist/` como artifact, verificar
      `grep -c localhost dist/background.js` = 0 y que los 6 modelos estén en `dist/models/`.
      Este job es el que falla si A.2 no se hizo.
- [ ] **D.4 —** Marcar los tres como *required checks* en la protección de `main`.

### FASE E — Entrega continua · A · ~2,5 h

`.github/workflows/deploy.yml`, en `push: tags: ['v*']` y en `workflow_dispatch` (con input
`version`, para rollback).

- [x] **E.1 —** Build de la imagen del backend → push a `ghcr.io/maxitrufel/sparkle-backend`
      con tags `:vX.Y.Z` y `:latest`. Cache de capas con `gha`.
- [x] **E.2 —** `docker-compose.prod.yml`: overlay que reemplaza `build: ./backend` por
      `image: ghcr.io/maxitrufel/sparkle-backend:${IMAGE_TAG}`. **El servidor no compila** —
      con 2 GB, un `npm ci` de 111 paquetes ahí es lento e innecesario.
- [x] **E.3 —** Secretos en GitHub (Settings → Secrets → Actions): `EC2_HOST`,
      `SSH_PRIVATE_KEY`, `GHCR_READ_TOKEN`, `DB_ROOT_PASSWORD`, `DB_PASSWORD`, `DB_USER`,
      `OPENAI_API_KEY`, `VEXA_BOT_API_KEY`, `VEXA_TX_API_KEY`, `VEXA_API_URL`,
      `ALLOWED_EXTENSION_IDS`, `DOMAIN` y **`SPARKLE_API_KEY`** (este último no estaba en la
      lista original: nace en A.7, y sin él el backend arranca con la API abierta). Copia de todos en Bitwarden.
      *(El inventario completo de qué hace cada variable está en `backend/.env.example`, que
      está muy bien documentado — no lo dupliques acá.)*
- [x] **E.4 —** Paso de deploy por SSH: escribir `.env` y `backend/.env` desde los secretos,
      `docker login ghcr.io`, `docker compose pull`, `npm run migrate` (contenedor one-shot,
      después de que el healthcheck de la base pase), `docker compose up -d`,
      `docker image prune -f`.
- [x] **E.5 — ⚠️ Verificación post-deploy dentro del workflow:** `curl` a un endpoint de
      salud; si no responde 200, el job falla. Un deploy que "salió bien" y dejó el sitio
      caído es peor que uno que falla.
- [x] **E.6 —** Empaquetar `dist/` como `extension-vX.Y.Z.zip` y adjuntarlo al GitHub Release.
- [x] **E.7 — ⚠️ Clave SSH dedicada al deploy**, distinta de la personal. Solo la pública va a
      la instancia, por Terraform.

### FASE F — Vexa por Tailscale · B · ~45 min

- [x] **F.1 —** Cuenta de Tailscale (gratis, login con GitHub). Instalar en la notebook
      (`brew install --cask tailscale`) y en el EC2 (ya viene del user_data de C.5).
- [x] **F.2 —** `tailscale up` en ambos. Renombrar la notebook a `sparkle-vexa` en la consola
      y **activar MagicDNS**.
- [x] **F.3 — ⚠️ Desactivar la expiración de claves** de los dos nodos. Por defecto expiran a
      los 180 días y el backend deja de ver Vexa sin ninguna señal clara.
- [x] **F.4 —** Levantar Vexa lite y confirmar que el `8056` escucha en la interfaz de
      Tailscale, no solo en `127.0.0.1`.
- [x] **F.5 —** Desde el EC2: `curl http://sparkle-vexa:8056/...` con la API key → debe
      responder. Desde afuera de la tailnet: no debe existir.
- [x] **F.6 —** `VEXA_API_URL=http://sparkle-vexa:8056` como secreto de GitHub (E.3).
- [x] **F.7 —** `make -C deploy/lite stt-smoke` → verificar que transcribe en **español**.

### FASE G — Primer deploy y prueba end-to-end · 🔒 · ~3,5 h

**Esta fase requiere a los dos**, uno como docente y otro como estudiante. Agendala en un
horario fijo, no "cuando cada uno pueda".

- [x] **G.1 —** En Namecheap: registro **A** `api` → la Elastic IP de C.8. TTL bajo (5 min)
      mientras probás. El apex `sparkleedu.me` puede seguir en GitHub Pages.
- [x] **G.2 — ⚠️** Esperar propagación: `dig +short api.sparkleedu.me` debe dar la Elastic IP.
      **No sigas hasta que dé.** Si Caddy pide el certificado antes, gastás intentos del rate
      limit de Let's Encrypt (5 fallos/hora) y te quedás sin HTTPS por un rato largo.
- [x] **G.3 —** Tag `v0.1.0` → primer deploy automático.
- [x] **G.4 —** Verificar en los logs de Caddy que sacó el certificado
      (`docker compose logs caddy`). `https://api.sparkleedu.me` con cadena TLS válida.
- [x] **G.5 —** Los dos cargan la extensión descomprimida desde `frontend/dist/`
      (`chrome://extensions` → modo desarrollador → "Cargar descomprimida"). Confirmar que
      Chrome le asigna **`kcjeagahhmdfdmgnoidbpmhbfiggbeif`**, el ID derivado de la `key` del
      manifest. Si no coincide, el backend rechaza todo por CORS — revisá
      `ALLOWED_EXTENSION_IDS` antes de seguir.
- [x] **G.6 — ⚠️ Prueba de persistencia de uploads:** subir un PDF,
      `docker compose down && docker compose up -d`, verificar que **sigue ahí**. Es la única
      forma de confirmar que el volumen `uploads_data` quedó bien.
- [x] **G.7 — Clase de prueba en Google Meet.**

      ⚠️ **Elegí el modo "Seminario / Debate".** Es el preset más rápido: ventana de alerta de
      2 minutos, contra 3 del modo por defecto y 5 del de repaso. Con cualquier otro van a
      estar mirando la pantalla esperando que salte algo. Calculen **mínimo 8-10 minutos** de
      clase para ver el ciclo completo.

      - [x] Conexión WebSocket establecida (`wss://`, no `ws://`)
      - [x] Detección de atención local → el vector de decisión llega al backend
      - [x] Alerta individual visible en la vista del estudiante
      - [x] Alerta grupal se dispara según el umbral
      - [x] **Recuperar contenido**: desde la alerta, el estudiante pide el resumen del tramo
            perdido y lo recibe
      - [x] Bot de Vexa se une a la reunión y transcribe
      - [x] Subida de documento de contexto (PDF)
      - [x] Generación de preguntas con OpenAI
      - [x] El docente aprueba / regenera / cancela antes de publicar
      - [x] El estudiante responde y el acierto queda registrado
      - [x] **Mapas de calor y gráficos** de atención en el panel del docente
      - [x] Resumen de cierre para el estudiante
      - [x] **Reporte del docente y su descarga en PDF** — se genera en el cliente, es de lo
            que más se rompe entre desarrollo y producción
- [x] **G.8 —** Con la clase corriendo: `docker compose logs -f` en el EC2 y `docker stats` en
      la notebook. Anotar picos de RAM y CPU de Vexa (Whisper `small` en CPU + Chrome headless
      son 1-2 GB) para saber si tu máquina lo aguanta el día de la defensa.

### FASE H — Chrome Web Store · B · ~1 h + espera de revisión

- [x] **H.1 —** Cuenta de developer (USD 5, pago único). **Tarda en habilitarse** — hacelo
      apenas puedas, no cuando lo necesites.
- [x] **H.2 —** Subir **`extension-store-<tag>.zip`** del Release como ítem **no listado**.
      ⚠️ **No el otro ZIP:** la Store rechaza el que trae el campo `key`. Ver la bitácora.
      → **Reabierto el 7/9/2026: Google rechazó la v0.1.2** por código remoto ("Blue Argon").
      Arreglado en el build y resubido como **v0.1.6**.
      → **CERRADO el 9/9/2026: aprobada y publicada.** Ver la bitácora.
- [x] **H.3 — ⚠️ Agregar el ID que asigna la Store a `ALLOWED_EXTENSION_IDS`.** Va a ser
      **distinto** del de la descomprimida: la Store genera su propio par de claves para un
      ítem nuevo. ~~e **ignora tu `key`**~~ → **falso, la RECHAZA**: ver la bitácora.
      El ID se lee en el dashboard apenas subís el borrador,
      no hace falta esperar la aprobación. Dejá **los dos** en la lista, separados por coma:
      el de la descomprimida para seguir desarrollando, el de la Store para la publicada.
      *(Opcional, si querés un solo ID: copiá la clave pública que te da el dashboard al campo
      `key` del manifest, reemplazando la actual, y rebuildeá.)*
- [ ] **H.4 —** Instalar desde la Store y repetir una versión corta de G.7.
- [ ] **H.5 —** *(Opcional)* Automatizar futuras subidas con `chrome-webstore-upload-cli`. La
      primera es manual sí o sí; automatizá recién cuando hayas hecho dos o tres a mano.

### FASE I — Backups y verificación · A · ~1,5 h

> ⚠️ **El backup tiene que cubrir los DOS volúmenes.** Los PDFs viven fuera de la base. Si
> solo respaldás el dump, una restauración deja la base apuntando a archivos fantasma.

- [x] **I.1 —** Script + cron diario: `mariadb-dump` **y** `tar` del volumen de uploads, **en
      la misma corrida y con la misma fecha**. Un dump y un tar de momentos distintos
      reintroducen la inconsistencia.
- [x] **I.2 —** `aws s3 sync` al bucket de C.6 (sin claves: usa el instance profile).
- [x] **I.3 — ⚠️ Probar una restauración completa** en una instancia descartable: levantar la
      base desde el dump, restaurar el tar, abrir una clase que tenga PDF adjunto.
      *Un backup que nunca se restauró no es un backup, es una suposición.*
      → Hecho el 5/9/2026 con contenedores descartables, no con un EC2. Ver la bitácora.
- [x] **I.4 —** Confirmar que la política DLM de C.7 está generando snapshots.

### FASE J — El runbook de recuperación · A · ~1 h

`infra/RECUPERACION.md`, probado de verdad:

```
Cuenta de AWS nueva (o el servidor perdido):
 1. aws configure                                # credenciales de la cuenta nueva
 2. cd infra/terraform && terraform apply        # ~4 min → Elastic IP nueva
 3. Namecheap: apuntar el A de `api` a esa IP    # ~1 min (+ propagación)
 4. gh secret set EC2_HOST --body <ip-nueva>     # ~1 min
 5. Aprobar el nodo nuevo en la consola de Tailscale
 6. Restaurar el último backup desde S3          # ~5 min
 7. gh workflow run deploy.yml -f version=vX.Y.Z # ~3 min
```

- [x] **J.1 —** Escribirlo.
- [ ] **J.2 — ⚠️ Probarlo de verdad**, aunque sea con `terraform destroy` + `apply` en la
      misma cuenta. Un runbook sin ensayar es ficción, y este es exactamente el documento que
      vas a leer bajo presión.

---

## 9 bis. Bitácora de decisiones tomadas al ejecutar

> Lo que se decidió **mientras se ejecutaba el plan**, y que el plan original no
> contemplaba o dejaba abierto. Esta sección es la que hay que leer para documentar:
> el resto del documento dice qué hacer, esta dice qué se hizo y por qué.

### A.1 — El repo de git en el home

`/Users/maximotrufelman/.git` tenía **0 archivos trackeados y 0 commits locales**: solo refs
remotas fetcheadas de `github.com/franisola/citypass-residuos`, más 4,3 GB de objetos
huérfanos. Nada local que perder — todo el contenido real está en GitHub.

**Decidido:** mover `.git` y el `.gitignore` suelto de 2023 a `~/Desktop/git-home-BORRAR/`
en vez de borrarlos. Se borra a mano cuando se quieran recuperar los 4,3 GB. El home ya no
es un repositorio.

### A.2 — Los modelos los ignoraban DOS `.gitignore`, no uno

El plan menciona `frontend/.gitignore` (`*.tflite`, `*.task`, `preprocesamiento.json`), pero
había un **segundo** `.gitignore` dentro de `frontend/public/models/` que ignoraba
`modelo_ensemble.json` — justo el modelo que el detector usa por defecto, y sin el cual cae
al modelo A con la abstención desactivada.

**Decidido:** commitear los 6 modelos (4,8 MB; el repo empaquetado quedó en 2,57 MiB) y
**eliminar entero** el segundo `.gitignore`. El README de la carpeta decía "no están
versionados": quedó al día.

### A.4 — Queda un `localhost` legítimo en el build

Después del rebuild, `dist/background.js` da **0** ocurrencias de `localhost:3000` ✅, pero
`dist/opciones.js` da **1**: es el texto de ayuda de la página de opciones
(*"Por ejemplo: http://localhost:3000"*). El check de CI del paso D.3 tiene que mirar
**`background.js`**, no todo `dist/`.

Medida del artefacto real: `dist/` pesa **76 MB**, el ZIP **25 MB**. Casi todo son los
binarios WASM de MediaPipe y LiteRT. Muy por debajo del límite de la Chrome Web Store.

### A.6 — Quedan 2 vulnerabilidades abiertas, a propósito

`npm audit fix` (sin `--force`) cerró 5 de 7 **sin tocar `package.json`**: solo se movieron
versiones dentro de los rangos ya declarados (`browserslist`, `dompurify`, `nanoid`,
`postcss`, `undici`). La única que viajaba en el paquete de la extensión era **dompurify**
(XSS, entra vía `jspdf`).

**Decidido no arreglar** `vite` y `esbuild`: el fix es `vite@8`, un salto mayor desde el 5
que usa el proyecto, y son dependencias de build que no salen en el `dist/`. No se toca
antes de la defensa.

### A.7 — Autenticación: se implementó la opción B

**Elegida la opción B** (secreto compartido), como recomendaba §7. Detalle de lo construido:

| Pieza | Dónde |
|---|---|
| Middleware | `backend/src/middleware/apiKey.js` — `crearMiddlewareApiKey(clave)` |
| Montaje | `backend/src/server.js`, después de `cors` y antes de toda ruta |
| WebSocket | `backend/src/ws/index.js`, en `verifyClient`, **antes** del chequeo de origen |
| Cliente | `frontend/src/config.js` (`cabecerasDeApi()`, `getWsUrl()`) y `frontend/src/services/api.js` (`fetchApi()`) |
| Variables | `SPARKLE_API_KEY` (backend) y `VITE_SPARKLE_API_KEY` (frontend) — **tienen que coincidir** |
| Tests | `backend/tests/apiKey.test.js`, 10 casos |

Cuatro decisiones de diseño que el plan no fijaba:

1. **El WebSocket la manda por query string (`/ws?key=…`), no por header.** La API
   `WebSocket` del navegador no permite headers propios en el handshake — a diferencia de
   `fetch`. Consecuencia: la clave **queda en los logs de acceso de Caddy**. Es aceptable
   porque son nuestros logs y la clave ya viaja en el bundle público de la extensión, pero
   conviene saberlo.
2. **Clave vacía = API abierta**, con un `console.warn` ruidoso al arrancar. Es lo que hace
   que el desarrollo local y los 140 tests del backend (que montan el router directo, sin
   `server.js`) sigan andando sin configurar nada. La contrapartida es que **un despliegue
   con la variable sin setear queda abierto** y solo lo dice un log — por eso `SPARKLE_API_KEY`
   entra en la lista de secretos obligatorios de E.3.
3. **`GET /` queda público.** Es el chequeo de salud de la verificación post-deploy (E.5): si
   pidiera clave, el workflow tendría que conocerla para saber si el deploy funcionó. No
   devuelve nada más que `{ status: 'ok' }`.
4. **`OPTIONS` pasa sin clave.** El preflight de CORS nunca lleva headers propios — son
   justamente los que va a preguntar. Exigirla ahí rompería todo request con
   `Content-Type: application/json`.

**El trade-off, dicho sin vueltas** (sirve para responderle al tribunal): la clave viaja
horneada en el bundle, así que cualquiera que descomprima el `.crx` la lee. Frena el escaneo
oportunista y a quien no se tome ese trabajo. **No es autenticación de verdad.** Para una
clase real con datos de alumnos hace falta la opción C — token de sesión por reunión. B se
eligió a propósito: cuesta hora y media y no cambia la arquitectura.

**Consecuencias operativas:**
- Cambiar la clave obliga a **rebuildear la extensión** y republicarla.
- `SPARKLE_API_KEY` se suma a los secretos de GitHub Actions del paso E.3.
- Todo request nuevo contra el backend tiene que salir por `fetchApi()` de
  `frontend/src/services/api.js`, nunca por `fetch` pelado.

### Fase B — `init-db.js` pasó a consumir la migración, en vez de duplicarla

El plan decía "`init-db.js` **se queda** para desarrollo (reset limpio)", lo que dejaba el
DDL escrito en dos lugares: el script y `001_esquema_inicial.sql`. Eso se desincroniza —
alguien agrega una columna en la migración y el reset de desarrollo deja de reflejarla.

**Decidido:** `init-db.js` conserva el guard de producción y los `DROP TABLE`, y después
**llama al mismo runner**. El DDL queda definido en un solo lugar. `schema_migrations` entra
en la lista de tablas a dropear: si quedara, el runner creería que ya aplicó todo y el reset
dejaría la base vacía **en silencio**.

Otras dos decisiones del runner:

- **`multipleStatements: true`** en vez de partir el `.sql` por `;` con una expresión
  regular. Un splitter casero se rompe con el primer `;` adentro de un string. El riesgo
  habitual de esa opción (inyección de SQL) no aplica: por esa conexión solo pasan archivos
  versionados del propio repo.
- **El registro en `schema_migrations` va después** de que la migración corra entera. Si el
  proceso se muere en el medio, la migración no queda registrada y se reintenta.

### Fase B — verificación de B.4, y una deriva encontrada en la base local

El esquema que produce `migrate` sobre una base vacía es **idéntico byte a byte** al que
producía el `init-db.js` original (comparado con `SHOW CREATE TABLE` de las 10 tablas,
recuperando el script viejo desde git). Corrido dos y tres veces seguidas, la segunda y la
tercera no hacen nada.

Al hacer esa comparación apareció otra cosa: **la base de desarrollo local (`sparkle_v2`)
había derivado del script**. Tiene `meetings.created_at` *antes* de
`attention_window_started_at`, al revés que el código — o sea, esa columna se agregó en algún
momento con un `ALTER TABLE` a mano en vez de recrear la base. Es inofensivo (el orden de
columnas no cambia el comportamiento) y es exactamente el síntoma que las migraciones vienen
a eliminar. No se tocó la base local para no perder los datos de las pruebas.

### Son 10 tablas, no 12

El plan dice "las 12 tablas" en §6 y en la descripción de `init-db.js`. Son **10**: `users`,
`meetings`, `participations`, `connection_sessions`, `questions`, `question_answers`,
`files`, `transcription_sessions`, `transcript_segments`, `attention_snapshots`. Con
`schema_migrations` pasan a ser 11.

### Fase D — D.2 investigado: el job de frontend SÍ necesita MariaDB

El plan marcaba esto como el punto dudoso, y la respuesta es que sí. No son dos archivos sino
**siete** los que tocan la base: `App.integracionBackendReal.test.js`,
`CameraPreview.integracionBackendReal.test.js` y cinco más que pasan por
`tests/helpers/reactHarness.js`. Levantan el Express y el WebSocket reales del backend en el
mismo proceso.

Dos consecuencias que no eran obvias:

1. **El job de frontend también tiene que correr `npm ci` en `backend/`.** Esos tests hacen
   `require(path.join(BACKEND_ROOT, 'node_modules', 'express'))` por ruta absoluta: sin las
   dependencias del backend instaladas, el job revienta con `MODULE_NOT_FOUND` antes del
   primer test.
2. **`backend/src/db.js` lee `process.env` directo, sin pasar por dotenv.** Las variables
   `DB_*` van a nivel del workflow y alcanzan; no hace falta fabricar un `.env` en CI.

### Fase D — `VITE_BACKEND_URL` va como variable del job

`frontend/.env` está gitignoreado, así que en CI no existe y `config.js` cae a su fallback
`http://localhost:3000`. El check de D.3 fallaría siempre. El job `build` la exporta como
variable de entorno.

`VITE_SPARKLE_API_KEY` se deja **vacía a propósito** en CI: el artifact es para inspeccionar
un PR, no para instalar. El paquete que se publica lo arma el workflow de deploy con el
secreto de verdad.

### Fase D — el CI corre `migrate`, no `init-db`

Es el mismo camino que corre el deploy, así que el CI verifica de paso que las migraciones
dejan un esquema sobre el que los 304 tests pasan. Una migración rota falla en el PR y no en
producción.

**Verificado localmente antes de commitear**, simulando las condiciones del CI:

| Qué | Resultado |
|---|---|
| Build sin `frontend/.env`, solo con la variable de entorno | los 3 checks del job `build` en verde, y la clave de API **no** queda en el bundle |
| 140 tests de backend contra una base creada por `migrate` | 140/140 |
| 164 tests de frontend contra esa misma base | 164/164 |

Lo único que no se pudo probar en la máquina es el workflow en sí (no hay `act` instalado):
el YAML se validó con un parser, pero la primera corrida real es el primer PR.

### Fase C — lo que se agregó al plan, y por qué

Todo en `infra/terraform/`, validado con `terraform validate` y `terraform fmt`. Quedan
pendientes solo C.1 (cuenta, MFA, usuario IAM) y C.10 (`apply`), que son manuales.

**Cinco cosas que el plan no pedía y están igual:**

1. **El Budget se crea con Terraform**, no a mano en la consola (el plan lo ponía dentro de
   C.1). Un paso manual es un paso que en la cuenta nueva del runbook de recuperación alguien
   se olvida — y este se olvida sin dar ninguna señal, hasta que llega la factura. Son tres
   avisos: 50% y 80% del gasto real, y uno de **proyección** al 100%. El de proyección es el
   que vale: los otros avisan de lo ya gastado, ese avisa a mitad de mes que a ese ritmo te
   vas a pasar.
2. **SSM Session Manager habilitado** (`AmazonSSMManagedInstanceCore`). Es gratis y es la red
   de emergencia del punto siguiente: consola en la instancia desde la web de AWS, sin puerto
   22 y sin clave.
3. **El puerto 443/UDP abierto.** `docker-compose.yml` publica `"443:443/udp"` para HTTP/3;
   el plan (C.3) hablaba de "80 y 443" a secas. Sin la regla, el stack levanta igual y los
   clientes caen a TCP — o sea, un HTTP/3 que nunca conecta y nadie mira.
4. **IMDSv2 obligatorio** en la instancia. El metadata service es de donde salen las
   credenciales del instance profile; en v1 alcanzaba un GET para leerlas, lo que convertía
   cualquier SSRF de la aplicación en un robo de credenciales de AWS.
5. **`.terraform.lock.hcl` se commitea** (el plan solo decía que `terraform.tfstate` va
   gitignoreado). Fija el hash exacto del provider: sin él, el pin `~> 5.70` de `versions.tf`
   dejaría entrar cualquier 5.x futura. Lockeado para `darwin_arm64`, `darwin_amd64` y
   `linux_amd64`. La versión que resolvió es la **5.100.0**.

**Tres decisiones de diseño:**

- **Sin subred privada ni NAT gateway.** El NAT cuesta ~USD 32/mes —tanto como todo el resto
  junto— y acá no protege nada: la única máquina tiene que hablarle a internet igual (Let's
  Encrypt, GHCR, OpenAI). El aislamiento real de la base ya lo da la red `internal` de Docker
  Compose, que no tiene ruta hacia afuera.
- **`user_data_replace_on_change = true`.** Cloud-init corre una sola vez, en el primer
  arranque: sin esta opción, editar `user_data.sh` no haría nada y el servidor quedaría
  distinto de lo que dice el código. ⚠️ La contrapartida es que **tocar ese archivo con el
  sistema en producción destruye y recrea la instancia**, volúmenes incluidos.
- **La AMI se busca por nombre, no por ID.** Los IDs de AMI son distintos en cada región y
  Canonical publica una imagen nueva por mes: fijar un ID haría fallar el `apply` de la cuenta
  nueva del runbook con "AMI no encontrada", justo cuando menos ganas hay de depurar Terraform.

**Lo que el `user_data.sh` deja hecho:** Docker + plugin de compose (del repo oficial, no el
`docker.io` de Ubuntu, que viene sin `docker compose` v2), 4 GB de swap con `swappiness=10`,
usuario `deploy` en el grupo `docker`, `/opt/sparkle`, Tailscale **instalado pero sin
autenticar** (la authkey es un secreto y el user_data es legible desde el metadata service),
`ufw` como segunda capa, rotación de logs de Docker (sin ella los logs llenan los 30 GB y el
servidor se cae por disco lleno), actualizaciones de seguridad automáticas y la AWS CLI v2.
Deja `/opt/sparkle/.cloud-init-ok` como marca de que terminó bien.

**Nota de instalación:** `brew install terraform` ya no trae Terraform (la fórmula del core se
sacó por el cambio de licencia). Es `brew install hashicorp/tap/terraform`. Quedó la 1.16.0.

### C.1 y C.10 — ejecutados el 5/9/2026: la cuenta, y el servidor arriba

**Cuenta `<id-de-cuenta>`, región `sa-east-1`.** MFA en root ya estaba puesto desde la
creación de la cuenta. Se activó *Acceso de usuarios y roles de IAM a la información de
facturación* en la consola de root: sin eso, `aws_budgets_budget` falla con un `AccessDenied`
que no dice cuál es el permiso que falta.

**Usuario IAM `maximo`** con `AdministratorAccess` y acceso a consola, más una access key de
tipo CLI cargada con `aws configure`. La cuenta root queda solo para facturación.

**Lo que se creó antes de tocar la consola** (preparación local):

| Qué | Dónde | Por qué |
|---|---|---|
| AWS CLI v2.36.40 | `brew install awscli` | No estaba instalada |
| Clave SSH de deploy | `~/.ssh/sparkle_deploy` (ed25519, sin passphrase) | Paso E.7. Sin passphrase porque la privada la va a usar GitHub Actions |
| `terraform.tfvars` | `infra/terraform/` (gitignoreado) | IP de casa, clave pública y el mail de Máximo para las alertas |

**Salidas del apply:**

```
ip_publica     = <ip-del-servidor>      → registro A de `api` (G.1) y secreto EC2_HOST (E.3)
id_instancia   = i-0e985001ee0552c17
bucket_backups = sparkle-backups-<id-de-cuenta>   → secreto BUCKET_BACKUPS (E.3)
```

#### Tres errores reales del Terraform, que solo aparecen contra la API de AWS

Los tres pasaron `terraform validate` y `terraform fmt` sin una queja. Son de los que no se
pueden encontrar sin un `apply` de verdad contra la cuenta.

1. **AWS rechaza los caracteres no-ASCII en las descripciones que viajan a su API.** El
   `aws_dlm_lifecycle_policy` murió por el guión largo (`—`) y la coma; las reglas del
   security group, por el guión largo y por el **apóstrofo de "Let's Encrypt"**. El conjunto
   que EC2 acepta es `a-zA-Z0-9._-:/()#,@[]+=&;{}!$*` más el espacio, y el error no dice cuál
   es el carácter ofensivo. Se reescribieron las tres descripciones en ASCII plano.
   ⚠️ Las `description` de `variables.tf` y `outputs.tf` **no** tienen esta restricción: esas
   son de Terraform y nunca salen de la máquina. Solo importa lo que se manda a AWS.

2. **⚠️ La instancia puede arrancar antes de que exista la salida a internet.** Es el error
   caro de los tres. `aws_instance` depende del *security group* y de la *subred*, pero nada
   la ata a las **reglas** del grupo ni a la asociación de la tabla de rutas — y Terraform
   crea recursos en paralelo. En el primer apply la instancia arrancó sin egress y cloud-init
   murió en el primer `apt-get install` con `Network is unreachable`.

   El síntoma es traicionero: **la instancia queda encendida y responde por SSH** con el
   usuario `ubuntu`. Lo único que falla es todo lo que el user_data tenía que dejar hecho —
   no hay Docker, no existe el usuario `deploy`, no existe `/opt/sparkle`. Y como cloud-init
   corre **una sola vez**, no se arregla solo ni reiniciando.

   Se agregó `depends_on = [aws_vpc_security_group_egress_rule.todo,
   aws_route_table_association.publica]` en `aws_instance.servidor`, y se reemplazó la
   instancia con `terraform apply -replace=aws_instance.servidor`.

   **La IP elástica sobrevivió al reemplazo** (`aws_eip` se actualiza en el lugar, no se
   recrea), así que el `<ip-del-servidor>` es estable y ya se puede cargar en el DNS. Lo que sí
   cambia es la **huella SSH del host**: hay que correr `ssh-keygen -R <ip>` o el cliente se
   planta con `REMOTE HOST IDENTIFICATION HAS CHANGED`.

3. **`terraform apply -auto-approve` se descartó.** El camino que se usó es en dos tiempos: `terraform plan -out=plan.tfplan` y
   después `terraform apply plan.tfplan`. Es además el orden correcto: lo que se aplica es
   exactamente lo que se revisó.

#### Verificado sobre el servidor ya levantado

| Qué | Resultado |
|---|---|
| `cloud-init status` | `done`, `errors: []` |
| Marca `/opt/sparkle/.cloud-init-ok` | presente |
| Docker + Compose | 29.8.0 y v5.5.1, y el usuario `deploy` los usa **sin sudo** |
| Swap | 4,0 GB sobre 1,9 GB de RAM |
| Disco | 29 GB, 26% usado |
| Tailscale | 1.102.3 instalado, `Logged out` — correcto, se autentica a mano en F.2 |
| AWS CLI en la instancia | v2.36.40 |
| **Escritura en S3 sin credenciales** | ✅ `aws s3 cp` al bucket funciona vía instance profile (`assumed-role/sparkle-rol-instancia`). El archivo de prueba se borró desde la notebook: el rol de la instancia **no puede borrar**, que es exactamente lo que se buscaba |
| Política DLM | `ENABLED` |

**El usuario `deploy` no tiene sudo**, y está bien: se verificó que ni `deploy.yml` ni los
scripts de backup lo usan en ningún lado.

#### Dos cosas para tener presentes

**Hay un segundo presupuesto de USD 10 en la cuenta**, llamado `presupuesto-mensual`, creado
por el asistente de alta de AWS — no por este Terraform, que creó `sparkle-mensual` de USD 50.
Con un gasto esperado de ~USD 32/mes, el de USD 10 va a disparar alertas todos los meses. No
rompe nada; si el ruido molesta, se borra desde la consola de Billing.

**La primera access key quedó expuesta** (se compartió una captura con la clave secreta
visible) y se decidió seguir con ella para no frenar. **Queda pendiente rotarla**
después del primer deploy: IAM → usuario `maximo` → Credenciales de seguridad → eliminar esa
clave, crear otra y volver a correr `aws configure`.

#### Lo que sigue, en orden

1. **Guardar `infra/terraform/terraform.tfstate` en Bitwarden** (paso C.9). Está gitignoreado
   y sin él Terraform no sabe qué recursos son suyos.
2. **F.2** — `ssh deploy@<ip-del-servidor> 'sudo tailscale up'`. ⚠️ `deploy` no tiene sudo: entrar
   como `ubuntu` para esto.
3. **G.1** — Namecheap, registro A de `api` → `<ip-del-servidor>`, TTL 5 min.
4. **E.3** — los secretos, empezando por `gh secret set EC2_HOST --body <ip-del-servidor>` y
   `gh secret set BUCKET_BACKUPS --body sparkle-backups-<id-de-cuenta>`.

### El `.pem` de la extension no hace falta: el riesgo de §12 estaba mal planteado

La tabla de riesgos daba "se pierde el `.pem` de la extensión" como **baja probabilidad,
consecuencia catastrófica**, con el argumento de que sin él se pierde el ID de la
descomprimida. Se buscó el archivo en todo el home y **no existe**. Antes de pedírselo a
nadie, se verificó si de verdad hacía falta.

**No hace falta.** Chrome deriva el ID de la extensión descomprimida del campo `key` del
manifest, que es la clave **pública** y **está commiteada**: SHA-256 del DER, los primeros 16
bytes, y cada dígito hexadecimal mapeado de `0-f` a `a-p`. Calculado sobre
`frontend/public/manifest.json` da exactamente `kcjeagahhmdfdmgnoidbpmhbfiggbeif`, el ID que
el plan da por bueno. La clave privada no interviene en ningún momento.

El `.pem` solo serviría para **firmar un `.crx` y distribuirlo por fuera de la Store**, cosa
que este plan no hace. Y para la Store tampoco sirve: el paso H.3 ya dice que la Store genera
su propio par de claves e **ignora** la `key` del manifest.

**Consecuencia:** el riesgo se da de baja, no hay que pedirle el archivo a nadie, y el ID de
la descomprimida es reproducible desde el repositorio para siempre. Se puede recalcular con:

```bash
python3 -c "
import json, base64, hashlib
der = base64.b64decode(json.load(open('frontend/public/manifest.json'))['key'])
h = hashlib.sha256(der).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in h))
"
```

### A.5 y D.4 — la proteccion de rama necesita GitHub Pro

Quedó **escrita pero no aplicada**. Tanto la protección de ramas clásica como los rulesets
devuelven `403 Upgrade to GitHub Pro or make this repository public` en un repositorio
**privado** del plan gratuito. No es un problema de permisos del token: es el plan.

La configuración quedó lista en `.github/ruleset-main.json`, con el porqué de cada regla en
`.github/PROTECCION.md`. Cuando haya Pro es un comando:

```bash
gh api -X POST repos/maxiTrufel/Saprkle_V2_Codigo/rulesets --input .github/ruleset-main.json
```

**El GitHub Student Developer Pack incluye GitHub Pro gratis** mientras seas estudiante, y es
**el mismo trámite** que da el `.me` gratis de `nc.me`. Una sola verificación de estudiante
destraba las dos cosas: A.5, D.4 y un dominio propio. Es lo primero que conviene hacer.

**Dos decisiones dentro de esa configuración**, que el plan dejaba abiertas:

1. **Cero aprobaciones requeridas.** El PR sigue siendo obligatorio y los tres checks también,
   pero no hace falta que el otro apruebe. Son dos personas y una sola corre el despliegue:
   exigir una aprobación pondría cada cambio a esperar a que el otro esté disponible, que es
   exactamente el cuello de botella que ya apareció con el DNS de G.1.
2. **Sin `enforce_admins`.** El admin puede saltearse la regla. Es la salida de emergencia
   para un `hotfix/` con producción caída, que es el peor momento para estar peleando con la
   configuración del repositorio.

**Decidido el 5/9/2026: no se aplica por ahora, y no se paga Pro para conseguirlo.** Nada deja
de funcionar sin la protección — el deploy, el CI y los backups andan igual. Lo que se pierde
es que la regla la haga cumplir el repositorio en vez de la disciplina de quien pushea: el
modelo de ramas de §5 queda como convención seguida, no como restricción impuesta. Vale
tenerlo dicho por si el tribunal pregunta.

También se descartó **hacer el repositorio público**, que es la otra forma de destrabarlo
gratis: el código de la tesis no se publica antes de defenderla.

Si el GitHub Student Pack se aprueba por el dominio, aplicarlo pasa a costar un comando y ahí
sí conviene hacerlo.

⚠️ **Los tres checks se declaran por su nombre exacto** (`Backend (140 tests)`,
`Frontend (164 tests)`, `Build de la extensión`, con tilde). Si cambia el `name:` de un job en
`ci.yml` —por ejemplo porque cambia la cantidad de tests—, el check obligatorio deja de
existir y **los PR quedan esperando para siempre** uno que nunca va a llegar.

### El CI tenía un test intermitente, encontrado al mirar las corridas

Al ir a marcar los checks obligatorios apareció que el CI había fallado en dos de las tres
últimas corridas — pese a que los commits que las dispararon solo tocaban markdown y
Terraform, nada capaz de romper un test de frontend.

El que fallaba era siempre el mismo: *"El historial del alumno muestra Sin responder para una
pregunta que finalizó sin que el alumno interactuara"*. **Local pasa en ~270 ms**; en CI se
comía los 3000 ms de su espera. No es una regresión, es un runner más lento que además levanta
MariaDB, Express y el WebSocket reales en el mismo proceso.

**Arreglado con un factor que multiplica cualquier `timeoutMs` cuando `process.env.CI` está
puesto** (`frontend/tests/helpers/reactHarness.js`). Multiplica todos y no solo el valor por
defecto, porque hay **88 llamadas que pasan el timeout a mano** — subir el default no habría
tocado justamente la que fallaba. Local queda idéntico, así que una espera rota de verdad se
sigue notando enseguida mientras se desarrolla. Medido: 164/164 con y sin `CI=1`, y el tiempo
total de la suite no cambia (27 s contra 29 s).

⚠️ **Y el motivo por el que costó entenderlo:** `waitUntil` **devuelve `false` cuando se
agota, no lanza**. Un `await waitUntil(...)` suelto deja seguir al test, y el `assert` que
viene después falla con un mensaje sobre el contenido del DOM en vez de sobre el timeout que
realmente ocurrió. El error decía "debería mostrar el texto..." y volcaba una pantalla entera,
cuando el problema era que nunca había esperado lo suficiente. Quedó documentado en la propia
función.

### C.9 — donde quedo cada secreto, y por que el tfstate no fue a Bitwarden

**No habia ningun gestor de contrasenas en la maquina.** Ni Bitwarden ni ningun otro: el plan
lo daba por existente en varios lugares ("copia en Bitwarden") y no existia. Se instalo
`brew install --cask bitwarden` y se creo la cuenta con el mail de Máximo.

**El `terraform.tfstate` NO va a Bitwarden, va a iCloud.** El plan (C.9) decia Bitwarden por
considerarlo sensible. Se revisó qué tiene realmente adentro y **no hay ni una contraseña ni
una clave privada**: Terraform no marca un solo atributo como sensible, y lo que guarda son
IDs de recursos, la IP elástica, el número de cuenta y la clave **pública** de SSH.

O sea que su riesgo no es que se filtre, es **perderlo**. Y además no entra: son 57 KB y una
nota de Bitwarden admite 10.000 caracteres (comprimido y en base64 da 11.109, todavía por
encima). Quedó en `~/Library/Mobile Documents/com~apple~CloudDocs/Sparkle-Infra/`, con la
fecha en el nombre. **Hay que volver a copiarlo después de cada `apply` que cambie algo:**

```bash
cp ~/Desktop/Tesis/Codigo\ Tesis/sparkle/infra/terraform/terraform.tfstate \
   ~/Library/Mobile\ Documents/com~apple~CloudDocs/Sparkle-Infra/terraform.tfstate-$(date +%F)
```

**Lo que sí quedó en Bitwarden:**

| Elemento | Tipo | Qué es |
|---|---|---|
| `Sparkle - clave SSH de deploy (privada)` | Nota | `~/.ssh/sparkle_deploy`. Era la única copia que existía |
| `Sparkle - AWS access key` | Nota | El contenido de `~/.aws/credentials` |
| `Sparkle - AWS consola (maximo)` | Login | URL de inicio de sesión, usuario y contraseña de la consola |

⚠️ **Una trampa de la operación, para la próxima vez:** copiar al portapapeles con `pbcopy` y
después copiar el *nombre* del elemento desde otro lado pisa lo que se iba a pegar, sin ningún
aviso. El orden que funciona es: escribir el nombre **a mano**, después `pbcopy`, después
pegar. Pasó dos veces.

**Tres huecos conocidos, dejados así a propósito:**

1. **La contraseña de root de AWS no se guardó.** Es recuperable por mail, así que es la menos
   crítica. Lo que **no** es recuperable por mail es el MFA: si se pierde el celular con la app
   de autenticación, recuperar root es un trámite lento con soporte de AWS. Queda sin registrar
   cuál es esa app.
2. **La access key sigue sin rotar.** Se expuso al compartirla en una captura y se
   decidió seguir con ella. → **Cerrado el 5/9/2026: se decidió NO rotarla**, y se borró una
   segunda clave que había quedado creada de más. Ver la entrada del final de esta bitácora.
3. **El `.pem` de la extensión no aparece en el disco.** Se buscó en el repo, en el Escritorio
   y en Descargas: no está. La tabla de riesgos de §12 lo marca como pérdida catastrófica
   —sin él se pierde el ID `kcjeagahhmdfdmgnoidbpmhbfiggbeif` de la descomprimida—, así que
   hay que averiguar dónde quedó antes de la fase H.

### Fase E — la lista de secretos de E.3 estaba incompleta

Falta **`SPARKLE_API_KEY`**, que no existía cuando se escribió el plan (nace en A.7). Sin ese
secreto el backend arranca con la API **abierta** y solo lo dice un `console.warn`. La lista
completa está más abajo, en "Secretos que hay que cargar".

También hace falta `DOMAIN` como secreto y no solo como variable del `.env`: lo usa la
verificación post-deploy para saber a qué URL pegarle.

### E.3 — CERRADO: los 14 secretos cargados el 5/9/2026

Los que se pudieron generar o derivar sin depender de nadie ya están en
`maxiTrufel/Saprkle_V2_Codigo` → Settings → Secrets → Actions:

| Secreto | De dónde sale |
|---|---|
| `EC2_HOST` | `<ip-del-servidor>`, del `terraform output` |
| `DOMAIN` | `api.sparkleedu.me` |
| `BUCKET_BACKUPS` | `sparkle-backups-<id-de-cuenta>`, del `terraform output` |
| `SSH_PRIVATE_KEY` | `~/.ssh/sparkle_deploy`, cargada con `gh secret set ... < archivo` |
| `DB_USER` | `sparkle` |
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | `openssl rand -hex 24` |
| `SPARKLE_API_KEY` | `openssl rand -hex 32` |
| `ALLOWED_EXTENSION_IDS` | El ID de la descomprimida. El de la Store se suma en H.3 |
| `VEXA_API_URL` | `http://sparkle-vexa:8056`, provisorio hasta confirmarlo en F.6 |

**Todo en hexadecimal, a propósito.** El workflow escribe los `.env` con un heredoc por el
stdin de `ssh`: una comilla, un `$` o un acento en una contraseña rompería el archivo del
servidor con un error que aparecería recién en el deploy, y como un fallo de conexión a la
base y no como lo que es. Hex no tiene ese problema y no pierde entropía que importe.

**⚠️ Los secretos de GitHub son de una sola vía: se escriben pero no se pueden volver a
leer.** Las tres contraseñas generadas no existen en ningún otro lado, así que se guardaron
en Bitwarden como `Sparkle - secretos de GitHub Actions` **antes** de borrar los archivos
temporales. Si esa nota se pierde, hay que regenerarlas y volver a desplegar.

**Se cargaron con `gh secret set NOMBRE < archivo`**, no con `--body`: un valor pasado como
argumento queda visible en `ps` para cualquier proceso de la máquina mientras el comando
corre.

`GHCR_READ_TOKEN` se cargó después, a mano: es un PAT clásico con scope `read:packages` y
nada más. ⚠️ Tiene vencimiento a un año — si expira, el deploy falla con un error de
autenticación que no dice en ningún lado que el token venció.

**Los tres que faltaban ya existían en `backend/.env`.** Se dio por hecho que `OPENAI_API_KEY`
exigía sacar una cuenta nueva y que las dos de Vexa dependían de la fase F, y ninguna de las
dos cosas era cierta: el entorno de desarrollo local ya las tenía configuradas de antes. Se
cargaron leyéndolas directo del archivo, sin que pasaran por ningún otro lado.

**La lección, para la próxima:** antes de dar un secreto por faltante, mirar si el entorno de
desarrollo ya lo tiene. Un `.env` local que funciona es un inventario de credenciales que ya
se consiguieron alguna vez.

⚠️ **Una salvedad sobre las dos de Vexa:** son las de la instancia local
(`VEXA_API_URL=http://localhost:8056` en el `.env` de desarrollo). Deberían servir tal cual
cuando Vexa se alcance por Tailscale —es la misma instancia con otro nombre de host—, pero
**eso se confirma recién en F.6**. Si al llegar ahí Vexa quedó reinstalado o con las claves
rotadas (§8 recomienda rotarlas), hay que volver a cargar estos dos secretos.

### G.1 — el dominio no está en una cuenta nuestra

`sparkleedu.me` está en Namecheap (verificado: registrador Namecheap, nameservers
`dns1/dns2.registrar-servers.com`, el apex ya apunta a GitHub Pages, `api` todavía no existe),
pero **la cuenta es de Isola, no de Trufelman.** El whois no lo dice —está detrás del servicio
de privacidad— pero no hay cuenta de Namecheap del lado de Trufelman.

Consecuencia: **G.1 depende de una persona que no está corriendo el despliegue.** Se evaluó
comprar un dominio propio y se descartó: el cambio toca ~10 lugares del repo (manifest,
`.env`, dos checks del CI, un test, la documentación y el runbook) y, aunque **la tesis no
menciona el dominio ni una vez** (verificado sobre el PDF), no vale la pena si el registro se
puede pedir.

⚠️ **Si alguna vez se cambia el dominio, el momento es ANTES de publicar en la Chrome Web
Store.** Después, cambiarlo obliga a una versión nueva de la extensión y a otra ronda de
revisión de Google.

Pedido a Isola junto con el registro A: **que la cuenta de Namecheap quede en Bitwarden y
compartida**, por el mismo motivo que la cuenta de la Chrome Web Store en H.1 — un recurso
que depende de que una sola persona esté disponible es un problema el día que hay que tocarlo
con apuro.

*(Dato para tener a mano: Namecheap regala un `.me` por un año a estudiantes vía el GitHub
Student Developer Pack, en `nc.me`. Es casi seguro de dónde salió el dominio actual, y es la
salida si alguna vez hace falta uno propio sin gastar.)*

### Fase E — cinco decisiones

1. **La imagen NO se reconstruye si ese tag ya existe en GHCR.** Además de ahorrar ~2 minutos
   en cada rollback, garantiza que volver a `v0.1.0` devuelva **exactamente el binario que
   estaba corriendo**, y no una reconstrucción que podría diferir por una capa base
   actualizada. Un rollback que reconstruye no es un rollback.
2. **El `docker login` va en un paso aparte, con el token por el stdin de `ssh`.** Un token
   pasado como argumento del comando remoto es visible en `ps` para cualquier proceso de la
   máquina. Primera versión de este workflow usaba `SendEnv`, que **no funciona**: el `sshd`
   de Ubuntu solo acepta `LANG` y `LC_*`, así que las variables nunca habrían llegado.
3. **`ssh-keyscan`, no `StrictHostKeyChecking=no`.** Aceptar cualquier huella significa que un
   intermediario en la red del runner se lleva la clave de deploy sin que nada chille.
4. **El job de la extensión verifica que la `version` del manifest coincida con el tag.** Si
   no coinciden, "qué está desplegado" y "qué está en la Store" dejan de ser la misma
   pregunta, que es todo el punto de desplegar por tag.
5. **`environment: production` declarado.** Hoy no exige aprobación; queda puesto para que
   activarla (Settings → Environments) sea un clic si alguna vez hace falta.

### Fase E — la trampa del `!reset` en el overlay

`docker-compose.prod.yml` tiene que borrar el `build:` del compose base, o Compose conserva
las dos claves y **prefiere construir** — el servidor compilaría igual y el overlay no serviría
de nada.

⚠️ La etiqueta va en el **valor** (`build: !reset null`), no en la clave (`!reset build:`). La
forma incorrecta **no da error**: simplemente no hace nada. Se verifica con

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep -A2 "backend:"
```

que no tiene que mostrar ningún `build:`. La primera versión de este archivo tenía la forma
incorrecta y pasó desapercibida hasta correr ese comando.

### Fase E — el orden del deploy, y por qué

```
copiar compose + Caddyfile   ← el servidor nunca queda con una versión vieja del stack
escribir los dos .env        ← desde los secretos, en CADA deploy
docker login ghcr            ← token por stdin
docker pull                  ← la imagen del tag
compose up -d --wait db      ← SOLO la base, y esperando su healthcheck
compose run --rm backend npm run migrate
compose up -d                ← el resto
docker image prune -f        ← sin -a: la imagen anterior sobrevive para el rollback
curl https://DOMAIN/         ← 12 intentos cada 10 s; si no da 200, el job FALLA
compose images backend       ← queda en el log qué versión quedó
```

La base se levanta sola y con `--wait` porque el arranque en frío de MariaDB (inicializando el
datadir) tarda mucho más que el contenedor: correr las migraciones antes falla con un error de
conexión que parece otra cosa.

Las migraciones corren en un contenedor efímero de **la misma imagen que se está desplegando**,
con el mismo `.env` y la misma red. Es `migrate` y nunca `init-db`.

### Fase E — qué NO revierte un rollback

El código, sí. **El esquema de la base, no.** Las migraciones son forward-only: volver a
`v0.1.0` deja ese código corriendo contra una base ya migrada. Por eso toda migración tiene que
ser compatible hacia atrás — la tabla de cómo partir cada tipo de cambio está en
`backend/migrations/README.md`.

### Fases I y J — escritas; lo que falta de las dos es probarlas

`infra/backups/backup.sh`, `infra/backups/restaurar.sh` e `infra/RECUPERACION.md`. Quedan
pendientes **I.3** (probar una restauración de verdad) y **J.2** (ensayar el runbook), que por
definición no se pueden escribir: hay que correrlos.

**El cron se instala en cada deploy**, no una vez a mano. Un backup configurado a mano es un
backup que, el día que la instancia se recree, nadie se acuerda de volver a poner — y su
ausencia no da ninguna señal hasta que hace falta restaurar. Corre a las **06:00 UTC**, una
hora antes del snapshot de disco de la política DLM, para que ese snapshot ya incluya el
backup del día.

**Cuatro detalles del script de backup:**

1. **`--single-transaction`** en el dump: consistencia sin bloquear escrituras. Sin eso,
   `mariadb-dump` lockea las tablas y una clase en curso se congela mientras dura el backup.
2. **El tar del volumen sale de un contenedor descartable en solo lectura**, no del contenedor
   del backend. Así el backup no depende de que el backend esté vivo — que es justo el
   escenario en el que uno más quiere poder respaldar.
3. **Si el dump pesa menos de 1 KB, aborta sin subir nada.** Un `mariadb-dump` que falla
   produce un archivo diminuto que, sin este chequeo, pisaría el backup bueno en S3 y nadie se
   enteraría hasta tener que restaurar.
4. **Un `manifiesto.txt` al lado de los datos** con fecha, versión desplegada y tamaños.
   Responde "¿de cuándo es esto y qué estaba corriendo?" sin tener que deducirlo con el
   servidor caído.

**El script de restauración vacía el volumen antes de desempaquetar.** Sin eso, los archivos
que existen hoy y no existían en el backup sobreviven, y el resultado no es el estado del
backup sino una mezcla. Y **migra después de restaurar**: el dump puede ser de un esquema más
viejo que el código que está corriendo.

**Un secreto más para E.3: `BUCKET_BACKUPS`** (sale del `terraform output`).

**El agujero honesto del plan de recuperación**, que conviene tener dicho: si se pierde la
cuenta de AWS entera, **el bucket de backups se va con ella**. Todo lo demás se reconstruye
—los secretos viven en GitHub, no en AWS, que fue el motivo de elegir GHCR sobre ECR—, pero
los datos no. La única cobertura real es bajarse una copia del último backup fuera de AWS de
vez en cuando.

### H.1 — cuenta de la Chrome Web Store creada

**Publisher: la cuenta de Google del equipo.** Es la dueña de la extensión
**para siempre**: la contraseña tiene que estar en Bitwarden y los dos tienen que poder entrar.
Perder esa cuenta es perder el control del ítem publicado.

**Declaración trader/non-trader: `non-trader`.** Es una exigencia de la ley europea de
protección al consumidor. Corresponde porque la extensión no se publica con fines comerciales
ni profesionales. Declarar *trader* habría obligado a mostrar dirección y datos de contacto
**públicamente** en la ficha de la extensión.

El dashboard muestra un **límite de 2 extensiones** para publishers nuevos. Irrelevante acá
(hace falta una), pero conviene saberlo.

⚠️ **El ítem NO se crea todavía.** El ZIP que se sube tiene que apuntar a
`api.sparkleedu.me` y traer la clave de producción horneada, y eso no existe hasta el primer
deploy. El orden es: servidor → deploy → recién ahí H.2.

### G.1 y G.2 — CERRADOS: el registro A existe y propagó

Isola cargó el registro **A** `api` → `<ip-del-servidor>` con TTL de 5 minutos, sin tocar ningún
otro registro (el apex sigue en GitHub Pages). Verificado el 5/9/2026 contra el autoritativo
de Namecheap, contra `8.8.8.8` y contra el resolver local: los tres devuelven la IP elástica.
G.2 pedía exactamente eso antes de levantar Caddy, para no gastar intentos del rate limit de
Let's Encrypt.

**Dato nuevo sobre el dominio, que cambia una fecha del plan:** `sparkleedu.me` es el año
gratis de estudiante (`nc.me`, GitHub Student Pack), registrado el **18/08/2026** y vencido
el **18/08/2027**. La defensa es ~enero 2027, así que está cubierta con margen, pero **el
dominio no es perpetuo**: en agosto de 2027 hay que renovarlo pagando o el sistema deja de
resolver. Si la tesis sigue viva después de la defensa, es una fecha para el calendario.

*(Corolario: la cuenta que tiene el Student Pack verificado es la de Isola. La nota de A.5
sobre "el Student Pack destraba GitHub Pro" aplica a esa cuenta, no a la que corre el
despliegue.)*

### El acceso al DNS: se delega, no se comparte la cuenta

El pedido de que la cuenta de Namecheap quedara compartida en Bitwarden **fue rechazado, con
razón.** El argumento de Isola: la cuenta del registrador no es comparable a la de la Chrome
Web Store. La segunda publica una extensión; la primera **se lleva el dominio entero** — quien
la tiene puede repuntarlo, hacerse emitir certificados válidos para `sparkleedu.me` e
interceptar todo lo que pase por ahí. Compartir ese login es compartir la capacidad de
suplantar el sistema completo.

**Decidido: delegar los nameservers a Cloudflare** (gratis, multiusuario de verdad, con un rol
que solo toca DNS). El dominio sigue registrado en Namecheap a nombre de Isola y lo único que
cambia son los NS. Con eso el DNS se maneja sin depender de que una persona esté disponible
—que es el cuello de botella real que apareció en G.1— y además queda registro de quién cambió
qué. Si Namecheap ofrece acceso delegado equivalente, sirve igual y se evita el cambio de NS.

⚠️ **No es urgente y no bloquea nada**, pero hacerlo **antes** de la fase H: mover NS con la
extensión ya publicada es el peor momento para un error de DNS. El riesgo del cambio es la
ventana de propagación; se hace con el TTL bajo que ya está puesto.

### G.3 — el primer deploy: dos fallas que solo aparecen contra la infraestructura real

Con el DNS listo se tagueó `v0.1.0` (las cuatro versiones —manifest, los dos `package.json` y
el tag— ya coincidían en `0.1.0`, así que no hizo falta tocar nada). El workflow falló dos
veces, y ninguna de las dos se podía encontrar antes: son de las que necesitan que el job
corra de verdad.

**1. GHCR rechaza las mayúsculas del nombre del repositorio.** El workflow armaba la imagen
como `ghcr.io/${{ github.repository_owner }}/sparkle-backend`, y ese valor viene tal como está
escrito en GitHub: `maxiTrufel`. El registry corta con
`invalid tag: repository name must be lowercase`. El plan (E.1) ya decía
`ghcr.io/maxitrufel/...` en minúsculas — la variable lo perdió.

**Las expresiones de GitHub Actions no tienen forma de bajar el caso**, así que no se arregla
en el `env:`. Se movió la resolución al job `version`, que ya resolvía el tag: ahora también
resuelve el nombre de la imagen con `tr '[:upper:]' '[:lower:]'` y lo publica como output. Los
otros dos jobs lo leen de ahí. El bloque `env:` global desapareció.

**2. ⚠️ El deploy por SSH desde Actions era incompatible con el security group.** C.3 dejó el
puerto 22 abierto **solo desde `var.mi_ip`**, y E.4 hace el deploy por SSH **desde un runner de
GitHub**, que sale por una IP cualquiera de Azure. Las dos decisiones son razonables por
separado y **no pueden convivir**: el paso murió en `ssh-keyscan`, que devuelve 1 cuando no
consigue ninguna clave y con `bash -e` mata el step. El error no dice "el firewall te bloqueó"
en ningún lado.

Acotarlo por CIDR no es una opción: el rango `actions` de `https://api.github.com/meta` son
**5625 bloques IPv4** y un security group admite 60 reglas.

**Decidido: abrir el 22 a `0.0.0.0/0`**, con la regla en Terraform (`aws_vpc_security_group_ingress_rule.ssh_actions`,
gobernada por `var.ssh_desde_actions`) y no a mano en la consola, para que el runbook de la
fase J siga produciendo un servidor que se pueda desplegar.

Qué se pierde y qué no: sshd queda con **autenticación por clave pública únicamente** —la
imagen de Ubuntu trae `PasswordAuthentication no`—, así que sigue haciendo falta la clave
privada de deploy y no hay contraseña que adivinar. Lo que aparece son los intentos de login
automatizados de siempre en el log. **La mitigación de verdad es la fase F:** con el servidor
en la tailnet, el runner entra por Tailscale con una authkey efímera, `ssh_desde_actions` pasa
a `false` y el 22 deja de existir para internet. Queda anotado como lo primero a hacer después
de cerrar F.

*(Se descartó SSM Session Manager, que ya está habilitado desde C: resolvería el mismo
problema sin abrir nada, pero obliga a meter credenciales de AWS en Actions —OIDC o access
key— y a reescribir los seis pasos del deploy. Es la alternativa correcta si Tailscale no
prospera.)*

### ⚠️ G.3 — el bug que hace que un deploy roto termine en verde

Con el 22 abierto, el deploy llegó hasta el final: SSH, `.env`, login a GHCR, `pull`, base
levantada y **la migración aplicada**. El paso de verificación falló igual, y al mirar el
servidor había **un solo contenedor corriendo**: la base. Ni backend ni Caddy — no habían
fallado, **nunca se crearon**.

La causa es sutil y vale conocerla porque no es específica de este proyecto:

**`docker compose run` se come el STDIN de `ssh`.** El script del deploy entero viaja al
servidor por el stdin de `ssh` (`bash -s` con un heredoc). Cuando ese script llega a
`compose run --rm --no-deps backend npm run migrate`, Compose conecta **ese mismo stdin** al
contenedor — y se traga todo lo que venía después: el `compose up -d` que levanta backend y
Caddy, y el `docker image prune`. Bash llega a EOF, no hay error, y el step **termina con
código 0**.

El síntoma es el peor posible: un deploy que reporta éxito en todos sus pasos y deja el
sistema a medio levantar. Lo único que lo delató fue la verificación post-deploy de E.5 —que
es exactamente para lo que está— y aun así el mensaje que da ("el sitio no respondió 200") no
apunta ni de lejos a la causa.

**Arreglado con `-T` y `</dev/null`** en esa línea:

```bash
$COMPOSE run --rm --no-deps -T backend npm run migrate </dev/null
```

**La lección general:** cualquier comando que pueda leer stdin, dentro de un script que se
ejecuta *desde* stdin, tiene que tener el stdin cerrado explícitamente. Vale para
`docker compose run`, `docker run -i`, `ssh` anidado, `apt`, `git` — cualquiera. Y el modo de
falla no es un error, es que el resto del script desaparece.

**El deploy con el arreglo pasó entero en 38 segundos**, y en el log se ve lo que antes
desaparecía: la migración (*"Nada que hacer: 1 migración ya está aplicada"* — el runner es
idempotente, como se diseñó en B), después los tres contenedores `Running`, después el
`prune`. La verificación post-deploy devolvió 200 y el cron quedó instalado.

⚠️ **Una salvedad honesta sobre esa corrida:** el stack ya estaba levantado a mano cuando
corrió, así que el `up -d` no tuvo que **crear** nada. Probó lo que estaba roto —que el script
llegue hasta el final— pero no el arranque desde cero por la vía automatizada. Eso se cierra
en **G.6**, que ya pide un `down` y un `up` para verificar la persistencia de los uploads: la
misma prueba cubre las dos cosas, y conviene hacerla ahí y no gastarla antes.

**Tres tomas del servidor después del deploy** (5/9/2026): los tres contenedores arriba, los
dos con healthcheck en `healthy`; el cron de backups instalado a las 06:00 UTC con los dos
scripts en `/opt/sparkle/backups/`; los cuatro volúmenes creados (`db_data`, `uploads_data`,
`caddy_data`, `caddy_config`). **687 MB de RAM usados sobre 1906** con el stack completo
corriendo en vacío — hay margen cómodo, y el número a vigilar es el de G.8, con una clase
encima.

### G.4 — CERRADO: el certificado salió y el HTTPS anda

Verificado el 5/9/2026 desde afuera:

| Qué | Resultado |
|---|---|
| `GET https://api.sparkleedu.me/` | **200**, `{"status":"ok","service":"Sparkle V2 backend"}` |
| Cadena TLS | válida (`ssl_verify_result=0`), sin warnings |
| Emisor | Let's Encrypt, CN=YE2 |
| Vigencia | 5/9/2026 → 4/12/2026, renovación automática de Caddy |
| Puerto 80 | **308** a `https://`, como debe |
| Latencia | ~340 ms desde Buenos Aires en la primera conexión (con handshake TLS incluido) |

**Y la opción B de §7 funciona en producción:** `GET /api/meetings/abc-defg-hij/transcript`
sin la cabecera de clave devuelve **401**. Ese es literalmente el `curl` que §7 daba como el
agujero a cerrar. Queda cerrado.

**El puerto 22 abierto se hizo notar a los cinco minutos.** Los logs de Caddy ya tienen
escaneos automatizados pidiendo `/.env`, `/.env.production`, `/.env.bak`, `/config/.env`,
`/../.env` y una docena más de variantes, desde varias IPs. **Todos reciben 401**, porque el
middleware de A.7 corre antes que cualquier ruta. Sirve como confirmación en vivo de dos
cosas: que un servicio público recibe tráfico hostil de inmediato, y que la opción B —aun
siendo "no es autenticación de verdad"— frena exactamente al escaneo oportunista que decía
frenar.

### I.4 — CERRADO, y el backup probado en el sentido de la escritura

**La política DLM está `ENABLED` y ya produjo un snapshot**, completado a las 07:16 UTC del
5/9/2026, de los 30 GB del disco. Venía funcionando desde antes de que hubiera algo que
respaldar, que es como tiene que ser.

Aprovechando que el stack estaba recién levantado, se corrió `backup.sh` **a mano una vez**.
Funciona entero: dump de la base, tar del volumen de uploads desde un contenedor `alpine`
descartable, y subida al bucket. En S3 quedaron los tres archivos, con el manifiesto que
responde la pregunta de "¿de cuándo es esto y qué estaba corriendo?":

```
fecha_utc=2026-09-05T16-53-43Z   base=sparkle_v2
version_desplegada=v0.1.0        dump_bytes=2371   uploads_bytes=89
```

⚠️ **Esto NO cierra I.3.** Lo verificado es que el backup se **escribe**; I.3 pide probar que
se **restaura**, que es la mitad que de verdad importa y que sigue pendiente. *Un backup que
nunca se restauró no es un backup, es una suposición* — y correr el script sin restaurarlo es
justamente la suposición que I.3 viene a romper.

**Un número para tener en cuenta:** el guard que aborta si el dump pesa menos de 1 KB tiene
hoy un margen de apenas el doble — una base migrada y vacía da **2371 bytes**. El guard sigue
sirviendo para el caso que le importa (un `mariadb-dump` que falla y produce un archivo
diminuto), pero conviene saber que hoy no está sobrado. Con datos de clases reales el dump
crece y el margen deja de ser un tema.

### F.1 y F.2 — CERRADOS, y una tailnet que había que elegir

**Tailscale ya estaba instalado en la notebook y ya había una tailnet**, pero era
`franisola.github`, la de Isola, con la notebook adentro junto a dos máquinas suyas. La cuenta
de Máximo tenía su propia tailnet, recién creada y vacía.

**Decidido: la tailnet propia (la de Máximo), no la de Isola.** El razonamiento es el mismo
que llevó a delegar el DNS en vez de compartir el login del registrador, y acá ni siquiera hay
un motivo para compartir: el EC2 es de Trufelman, el despliegue lo corre Trufelman y Vexa
corre en su notebook. Poner la red privada por donde el backend habla con Vexa en la cuenta de
otra persona habría creado una segunda dependencia igual a la del dominio, gratis.

La notebook se pasó de tailnet con *Switch Account* en la app, que soporta las dos a la vez y
deja volver a la de Isola cuando haga falta. Estado final: `sparkle-vexa` (<ip-tailnet-vexa>) y
`sparkle-servidor` (<ip-tailnet-servidor>), las dos en la tailnet de Máximo.

**Verificado:** `tailscale ping` del servidor a la notebook responde en **34-38 ms y por
conexión directa** (`via <ip-de-casa>:4532`, la IP de casa), no por un relay DERP. El NAT
traversal funcionó sin tocar nada, que es exactamente lo que §4 daba como motivo para elegir
Tailscale.

**MagicDNS ya venía activo** en esa tailnet, así que F.2 quedó completo sin pasar por la
consola: `sparkle-vexa` resuelve desde el servidor y el ping por nombre anda. El renombre se
hizo con `tailscale set --hostname=sparkle-vexa` desde la notebook —no hace falta la consola
web— y tarda unos segundos en propagarse.

### ⚠️ F.6 — el contenedor NO hereda el DNS de Tailscale

Con `sparkle-vexa` resolviendo perfecto **en el host**, adentro del contenedor del backend
`getent hosts sparkle-vexa` **falla**. Es el mismo `VEXA_API_URL=http://sparkle-vexa:8056` que
se cargó como secreto en E.3, así que sin esto el backend nunca habría encontrado a Vexa.

La causa: el `/etc/resolv.conf` del host apunta a `127.0.0.53` (systemd-resolved), una
dirección que adentro del contenedor no significa nada. Docker la detecta como inservible, la
descarta y le da al contenedor su resolver propio (`127.0.0.11`), que no sabe nada de MagicDNS.
El `search tailc2aea4.ts.net` del host tampoco viaja.

⚠️ **Y el modo de falla es de los malos:** el síntoma sería "Vexa no responde", que es
**idéntico** a la notebook apagada — o sea al modo degradado que §8 declara como
comportamiento esperado. Se habría visto como "hoy no anda la transcripción" en vez de como
un error de configuración, y podría haber sobrevivido hasta la clase de prueba.

**Arreglado con `dns:` en `docker-compose.prod.yml`**, apuntando a `100.100.100.100` (el
resolver de Tailscale) con `8.8.8.8` detrás. Dos cosas que se comprobaron **antes** de
escribirlo, y que son las que hacen que la solución sirva:

1. **`100.100.100.100` no es solo para la tailnet: reenvía lo demás.** `dig` contra él
   devuelve tanto `sparkle-vexa` como `api.openai.com`. Si solo resolviera nombres internos,
   ponerlo primero habría roto OpenAI.
2. **El contenedor puede alcanzarlo.** Se probó con un `alpine` descartable en la red `edge`
   con exactamente ese `--dns`, sin tocar el backend en producción: resuelve las dos cosas.

**El `8.8.8.8` de respaldo es deliberado.** Si `tailscaled` se cae y el único DNS del backend
es el de Tailscale, se cae **todo** el DNS del contenedor —OpenAI incluido— y una dependencia
opcional pasa a ser un punto único de falla de todo el sistema. Con el segundo nameserver, un
Tailscale caído cuesta un timeout por consulta y nada más.

Va en el overlay de producción y no en el compose base porque en desarrollo local no hay
Tailscale y `100.100.100.100` no existe.

### ⚠️ Un arreglo de infraestructura en `main` NO llega a producción hasta que se taguea

Al desplegar el arreglo del DNS de arriba, el deploy pasó **entero en verde** y el backend
siguió sin resolver `sparkle-vexa`. El `docker-compose.prod.yml` del servidor no tenía el
cambio.

La causa está en el propio diseño de E.2/E.4, y conviene entenderla bien porque va a volver a
pasar:

| Qué se despliega | De dónde sale |
|---|---|
| El YAML del workflow (`deploy.yml`) | de la **rama** — `workflow_dispatch` siempre corre el de la rama por defecto |
| `docker-compose*.yml`, `Caddyfile`, los scripts de backup | del **checkout del tag** que se está desplegando |
| La imagen del backend | del **tag** |

Por eso el arreglo del stdin (que vive en `deploy.yml`) se aplicó solo, y el del DNS (que vive
en `docker-compose.prod.yml`) no: el tag `v0.1.0` apunta a un commit anterior a los dos.

**No es un bug: es lo que hace que desplegar por tag signifique algo.** Si los archivos del
stack salieran de `main`, un rollback a `v0.1.0` devolvería el código viejo con el compose
nuevo, que es precisamente el estado incoherente que el esquema evita.

⚠️ **Lo que sí es un agujero es que el deploy no lo diga.** Nada compara lo que se copió
contra lo que se esperaba, así que un arreglo de infraestructura commiteado y "desplegado" se
siente aplicado sin estarlo. La verificación post-deploy de E.5 no lo agarra: el sitio
responde 200 igual, porque el problema estaba en una dependencia opcional.

**Decidido: se saca `v0.1.1`** en vez de mover el tag, que era la otra salida. Mover `v0.1.0`
haría que un mismo número signifique dos artefactos distintos —con un Release ya publicado y
una imagen ya en GHCR— y eso rompe la única propiedad que hace útil el esquema: que el tag
identifique sin ambigüedad qué está corriendo. Un cambio de configuración de producción es un
release, aunque no cambie una línea de código de la aplicación.

De paso es la **primera vuelta real del ciclo de versionado de §5**: las cuatro versiones
(`manifest.json`, los dos `package.json` y el tag) se subieron juntas, más los dos
`package-lock.json`, que el plan no menciona y que también llevan el número. El job de la
extensión verifica que el manifest coincida con el tag, así que olvidarse de uno hace fallar
el deploy — pero los locks no los mira nadie.

**v0.1.1 desplegado y verificado.** El compose del servidor ya trae el `dns:`, el contenedor
del backend se recreó, y adentro resuelven las tres cosas que tienen que resolver:
`sparkle-vexa` → <ip-tailnet-vexa>, `api.openai.com`, y `db` por la red interna de Compose. El
sitio sigue en 200 y `IMAGE_TAG=v0.1.1`. Con eso **F.6 queda cerrado**: el secreto era
correcto desde E.3, lo que faltaba era que el contenedor pudiera resolverlo.

### F.4 y F.5 — CERRADOS: Vexa se alcanza por la tailnet y solo por ahí

`make -C deploy/lite up LOCAL_STT=1` levanta cuatro contenedores: PostgreSQL, MinIO, el
servidor de STT y el gateway. El `8056` queda escuchando en `*:8056` —todas las interfaces del
host, la de Tailscale incluida—, así que F.4 se cumple.

⚠️ **La contracara: también escucha en la LAN de casa.** El `-p 8056:8056` del Makefile publica
en todas las interfaces, no solo en `tailscale0`. Cualquiera en la misma red doméstica llega al
gateway sin pasar por Tailscale. No es lo que afirma §3.7.2 de la tesis —que habla de
exposición *pública*, y públicamente no está—, pero conviene saberlo dicho antes de que lo
pregunte un tribunal. Se acota con `-p <ip-tailnet-vexa>:8056:8056`.

**F.5, verificado en las dos direcciones que pide el plan:**

| Desde | Qué | Resultado |
|---|---|---|
| EC2, por Tailscale | `/docs` | 200 |
| EC2, con `VEXA_BOT_API_KEY` | `/bots` | 200 |
| EC2, con `VEXA_TX_API_KEY` | `/meetings` | 200 |
| EC2, con la clave de bot | `/meetings` | `Insufficient scope` — **correcto**, cada clave tiene su alcance |
| EC2 → IP pública de casa `:8056` | cualquier cosa | **sin respuesta** ✅ |

Esa última fila es la que sostiene la afirmación de §3.7.2: desde fuera de la tailnet el
servicio no existe. Y de paso confirma la salvedad de E.3 sobre las dos claves de Vexa: eran
las de desarrollo local y **sirven tal cual** por Tailscale, sin rotarlas ni volver a cargarlas.

### ⚠️ F.7 — el smoke test de Vexa pasa en verde con un modelo que no sirve

El paso pide "verificar que transcribe **en español**". Correr `make stt-smoke` **no alcanza**,
y descubrir por qué llevó la mayor parte de la fase F.

`stt-smoke` sintetiza *"the quick brown fox jumps over the lazy dog"* —en inglés— y da por
bueno el resultado si encuentra esas palabras. **Pasa en verde con un modelo solo-inglés**, que
es exactamente el modelo que no hay que usar. Es un test de "el STT responde", no de "el STT
sirve para esto".

Al probarlo con audio en español, el resultado fue una alucinación clásica de Whisper:

> *"Thank you very much for watching, and I'll see you next time, and we'll see you next time."*

con `"language": "en"` y `avg_logprob: -1.07`. Y el log del servidor lo decía sin vueltas:
`The current model is English-only but the language parameter is set to 'es'; using 'en' instead`.

**Estaba corriendo `Systran/faster-whisper-tiny.en`** — el default de `lite`, el mismo que §8
marca en negrita como el que no sirve— **pese a haber levantado con
`WHISPER_MODEL=Systran/faster-whisper-small`.**

**Por qué se ignoró el parámetro** (línea 152 del Makefile de `lite`):

```make
if ! docker ps -q -f name=$(WHISPER_CONTAINER) | grep -q .; then
        docker rm -f ... ; docker run -d ... -e WHISPER__MODEL=$(WHISPER_MODEL) ...
fi
```

El contenedor **solo se crea si no hay uno corriendo**. Había uno de una corrida anterior del
mismo día, con el default. El `if` dio falso, no se recreó nada, y el `WHISPER_MODEL` se perdió
sin una sola advertencia.

⚠️ **Y el mensaje de éxito miente.** La línea 162 imprime
`✓ local STT ready — ... (model $(WHISPER_MODEL))` **incondicionalmente**: reporta el modelo
que *pediste*, no el que el contenedor tiene. Dice "small" mientras corre "tiny.en". Fue lo que
hizo dar por buena la primera corrida.

**El arreglo es `docker rm -f vexa-lite-whisper` antes del `up`.** Con el contenedor recreado,
la misma prueba en español da lo que tiene que dar:

> `"language": "es"` — *"Hoy vamos a repasar el teorema de pentágoras y después resolvemos
> ejercicios de triángulos rectángulos."*

("pentágoras" por "Pitágoras" es el modelo `small` peleando con un nombre propio dicho por una
voz sintética; el resto es exacto.) Verificado además **por el camino que usa Vexa de verdad**:
el cliente manda `model=whisper-1`, que no es un modelo real, y el servidor cae al que tiene
configurado por entorno — ahora `small`. Con `tiny.en` configurado, ese mismo alias caía al
modelo inglés.

**Tres cosas para no repetir:**

1. **Verificar el modelo en el contenedor, no en el mensaje:**
   `docker inspect vexa-lite-whisper --format '{{range .Config.Env}}{{println .}}{{end}}' | grep WHISPER__MODEL`
2. **Cambiar `WHISPER_MODEL` exige borrar el contenedor**, no basta con `make up`.
3. **La prueba de F.7 tiene que ser en español y con audio propio.** Sirve `say -v "Flo (Spanish (Mexico))"`
   remuestreado a mono 16 kHz, y mirar que la respuesta traiga `"language": "es"` — ese campo
   es el que delata el problema, más que el texto.

Tras recrear el contenedor se reconfirmó que el EC2 sigue alcanzando `/bots` por Tailscale: 200.

### G.5 y G.6 — CERRADOS

**G.5:** Chrome asignó `kcjeagahhmdfdmgnoidbpmhbfiggbeif`, el ID esperado. El plan pedía
confirmarlo en las dos máquinas; alcanza con una, porque el ID **se deriva del campo `key` del
manifest** y es determinista — el mismo paquete da el mismo ID en cualquier Chrome. Es la misma
propiedad que permitió dar de baja el riesgo del `.pem`.

⚠️ **Se carga el ZIP del Release, no `frontend/dist/`**, aunque el paso G.5 diga lo segundo. El
`dist/` local se construye sin `VITE_SPARKLE_API_KEY`, así que **no trae la clave de producción
horneada** y el backend le contesta 401 a todo. El paquete bueno lo arma el workflow de deploy
(E.6) con el secreto de verdad. Como el `dist/` local se ve idéntico y el síntoma es un 401
genérico, es un rato perdido buscando el problema en CORS o en el servidor.

**G.6:** subido un PDF por la extensión, con el stack completo abajo y arriba de nuevo
(`down` sin `-v` + `up -d`), el archivo sobrevivió **byte a byte**: mismos 40.824 bytes y el
mismo `md5 c15dc7feb6fbc0eaf96fe4bda55fd0db`, con su fila en `files` intacta. Se comparó el
checksum y no solo la existencia del archivo, que es lo que distingue "el volumen persiste" de
"quedó algo con ese nombre".

**De paso cierra el hueco que había quedado en G.3:** los tres contenedores se **crearon desde
cero** (12-18 segundos hasta `healthy`) y el sistema volvió solo, sin intervención. El arranque
limpio por la vía normal quedó probado, que era lo único que la corrida anterior no había
ejercido.

### G.7 — 10 de 13 verificaciones en verde; las 3 que faltan son todas la transcripción

Corrida el 5/9/2026 con **un solo operador y dos perfiles de Chrome** en la misma máquina
(una cuenta de Máximo como docente y otra como alumno), porque Isola no llegó. No reemplaza la corrida con
dos personas —sobre todo para G.8—, pero alcanzó para ejercitar el camino de estudiante, que
era lo que nunca se había ejecutado en producción.

**Lo que quedó verificado contra la base de datos, no contra la pantalla:**

| Qué | Evidencia |
|---|---|
| WebSocket con los dos roles | `role=teacher` y `role=student` en los logs, ping/pong estable sobre `wss://` |
| Detección de atención → backend | **37 filas** en `attention_snapshots`, de 0,00 % a 100,00 % |
| Alerta grupal por umbral | **23 filas** con `group_inattentive=1` |
| Generación de preguntas con OpenAI | 2 preguntas, `gpt-4o-mini-2024-07-18`, 1235 tokens la primera |
| Respuesta del alumno registrada | `question_answers` id=1, `is_correct=1` |
| Uploads, mapas de calor, reporte en PDF | ✅ |
| Errores del backend en toda la corrida | **ninguno** |

⚠️ **Un tropiezo que costó diez minutos y vale anotar:** el perfil de alumno daba
*"Error al conectar con el backend: Failed to fetch"* porque se le cargó la carpeta `dist/`
local en vez del ZIP del Release. **El síntoma engaña**: no es un 401 —que sería "la clave está
mal"— sino un fallo de red, porque ese build apunta a `localhost:3000`. Se confirmó en dos
minutos mirando los logs del servidor: **cero requests de ese perfil habían llegado**. Es el
mismo asunto anotado en G.5, y es la clase de error que se busca en el lugar equivocado.

### ⚠️ La transcripción en vivo no produce segmentos — diagnóstico

Los tres ítems que faltan de G.7 son uno solo: **Vexa graba pero no transcribe**. Lo que se
descartó, en orden:

| Hipótesis | Cómo se descartó |
|---|---|
| El backend no llega a Vexa | Los logs de Vexa muestran el `GET /transcripts` del backend cada pocos segundos, respondiendo 200 |
| El bot no fue admitido | El ciclo de vida llegó a `active`; antes había quedado dos veces en `awaiting_admission` |
| El bot no capta audio | **938 MB** de grabación en MinIO |
| El STT está roto | Transcribe perfecto en español por HTTP (ver F.7) |

**Lo que sí pasa:** a Whisper le llegan ~80 fragmentos de **0,25 a 2,3 segundos**. Nunca un
bloque de habla continua. Whisper recibe recortes demasiado cortos para producir una sola
frase, así que devuelve vacío y no se registra ningún segmento.

O sea: **la grabación acumula audio normalmente y el camino de transcripción en vivo trocea el
stream mal.** Son dos rutas distintas dentro de Vexa y solo una está rota.

**Una hipótesis que los números de G.8 hacen probable:** `vexa-lite-whisper` estaba al **597 %
de CPU** durante la clase. Un STT saturado que no puede seguir el ritmo del audio en vivo es
una explicación natural para un stream que llega picado. Se prueba bajando a
`faster-whisper-tiny` (multilingüe, **sin** el `.en`) y viendo si aparecen segmentos: si con un
modelo más liviano transcribe, era saturación y no un bug del troceado.

⚠️ **Es un problema del Vexa upstream, no de Sparkle**, y por eso se paró la búsqueda: el resto
de la clase funcionaba y llevaba media hora. **No bloquea la defensa** — §8 ya declara el modo
degradado sin Vexa como comportamiento esperado—, pero **sí bloquea tres funciones de la tesis**
(recuperar contenido, resumen de cierre y la transcripción misma), así que hay que resolverlo
antes de la presentación.

### G.8 — el cuello de botella es la notebook, no el servidor

Medido con la clase corriendo, y el resultado invierte lo que uno esperaría:

| | CPU | RAM |
|---|---|---|
| **EC2 entero** (Caddy + backend + MariaDB) | ~0 % | **155 MB** en contenedores; 743 MB de 1906 en el sistema |
| `vexa-lite` (bot + Chrome headless) | 177 % | 1,62 GB |
| `vexa-lite-whisper` | **597 %** | **2,56 GB** |
| MinIO + Postgres | <1 % | 230 MB |

**El servidor está sobradísimo.** Con una clase encima, los tres contenedores suman 155 MB y el
CPU no se mueve de cero. El `t3.small` no solo alcanza: sobra. Si alguna vez hay que recortar
costos, bajar de instancia es una palanca real y no una apuesta — y refuerza que la discusión
de §4 sobre 1 GB contra 2 GB estaba bien resuelta.

**Y Vexa cuesta mucho más de lo que el plan estimaba.** G.8 anticipaba "1-2 GB" para Whisper
`small` en CPU más Chrome headless. La medición real es **~4,4 GB de RAM y casi 8 núcleos
saturados**. En una notebook de 7,75 GB eso deja poco margen para el resto — y la máquina que
corre Vexa el día de la defensa va a estar además con Meet, la extensión y el navegador.

**Consecuencia práctica:** el día de la presentación conviene que Vexa **no** corra en la misma
notebook que da la clase. Si no hay otra máquina, bajar a `faster-whisper-tiny` (multilingüe) es
el recorte obvio, y puede además arreglar el problema de la transcripción.

### ⚠️ El bug que finalizaba la clase sola — arreglado en v0.1.2

**Chrome congela las pestañas en segundo plano** y termina cerrándoles el WebSocket. Para el
servidor eso era indistinguible de "el docente cerró la pestaña y se fue", así que
`handleTeacherDisconnection` finalizaba la clase **al instante**, con el docente todavía en la
reunión de Meet sin haber tocado nada. Pasó **dos veces en veinticinco minutos** durante la
clase de prueba, y ya había pasado corriendo en local — o sea que no era un artefacto de tener
dos perfiles abiertos.

**Por qué el mecanismo que ya existía no alcanzaba.** `handleJoin`/`handleClose` tienen un
`socket.sparkleReplaced` justamente para no matar la clase en un F5. Pero ese resuelve el caso
en que el socket NUEVO llega **antes** de que el viejo termine de cerrarse. Con una pestaña
congelada el orden es el inverso: primero el `close`, y la reconexión recién cuando la pestaña
vuelve al frente — con la clase ya finalizada.

**El arreglo:** la finalización automática se difiere `TEACHER_DISCONNECT_GRACE_MS` (90 s por
defecto) y se cancela si el docente vuelve. Tres cosas que se cuidaron:

1. **"Detener Clase" sigue siendo inmediato.** Ahí hay una intención explícita; demorarla sería
   otro bug.
2. **Dos caídas seguidas no acumulan timers** — la segunda reemplaza a la primera.
3. **El timer lleva `unref()`**, o `node --test` se queda colgado hasta que venza el último.

**Verificado en producción**, y el reloj lo dice solo:

```
19:17:33  Docente desconectado de "vda-nqhb-woy" — la clase se finalizará en 90 s si no vuelve.
19:19:03  Clase finalizada AUTOMÁTICAMENTE por desconexión del docente.
```

Noventa segundos exactos, donde antes eran cero. En la reunión siguiente, cambiar de pestaña
treinta segundos ni siquiera llegó a cortar el WebSocket.

⚠️ **Un test viejo codificaba el comportamiento anterior.** El de "reanudar tras finalización
automática" cerraba el socket del docente, esperaba 150 ms y daba por hecho que ya se había
finalizado. Con la gracia eso deja de valer: al volver, la clase sigue **activa** y no hay nada
que reanudar. Se le subió la espera y se le fijó la ventana en 100 ms para todo `ws.test.js`;
los casos del arreglo van en `tests/teacherDisconnectGrace.test.js`, en un archivo aparte
porque la constante se lee del entorno **una sola vez**, al cargar el módulo.

⚠️ **Y una lección sobre correr la suite local:** con Vexa levantado, `npm test` tarda
muchísimo y aparecen fallos por timeout que **aislados no existen** (`questions.test.js` da
19/19 solo, y falla dentro de la corrida completa). No es intermitencia del código: Whisper se
lleva casi ocho núcleos, y los 11 archivos de test corren en paralelo contra la misma base.
**Bajá Vexa antes de correr la suite entera, o confiá en el CI**, que corre sin nada encima.

### ⚠️ La transcripción en vivo: diagnóstico cerrado, causa en el upstream

Segundo intento, con el modelo correcto y hablando sostenido: **sigue en 0 segmentos**. Lo que
se sabe, sumando las dos corridas:

| Pieza | Estado |
|---|---|
| Backend → Vexa | ✅ el `GET /transcripts` llega y responde 200 |
| Bot admitido en la reunión | ✅ ciclo de vida en `active` |
| Bot capturando audio | ✅ **938 MB** grabados en MinIO |
| STT en sí | ✅ transcribe español perfecto por HTTP (F.7) |
| Modelo cargado | ✅ `faster-whisper-small`, multilingüe |
| **Audio que llega a Whisper** | ❌ **66 fragmentos, ninguno pasa de 0,77 s** |

**El dato que cierra el diagnóstico:** las duraciones son 0,256 s / 0,512 s / 0,768 s — todas
múltiplos exactos de **4096 muestras a 16 kHz**. Eso es un buffer de tamaño fijo vaciándose
crudo contra el STT, no un problema de rendimiento. (La hipótesis anterior, que Whisper al
597 % de CPU no daba abasto, queda **descartada**: la saturación no produce duraciones
alineadas a una potencia de dos.)

Y no es lo que el propio Vexa dice hacer: `core/meetings/modules/gmeet-pipeline/src/speaker-streams.ts`
acumula audio **por hablante** y lo somete en bloques de varios segundos —su propio log imprime
`(${...}s audio)`— además de tener filtro de alucinaciones y reintento final. Ese camino no se
está usando, o se está vaciando en cada bloque de captura de `gmeet-capture` (`const BLOCK = 4096`).

**Es un bug del Vexa upstream, no de Sparkle.** Ninguna variable del `Makefile` de `lite` lo
configura. Se paró acá a propósito, después de dos rondas de diagnóstico: el resto del sistema
funciona y no es algo que se resuelva al final de una sesión larga.

**Impacto acotado, pero real:** §8 ya declara el modo degradado sin Vexa como comportamiento
esperado, así que **no bloquea la defensa**. Sí deja sin probar **tres funciones de la tesis**
—transcripción en vivo, recuperar contenido y resumen de cierre—, así que hay que resolverlo
antes de presentar. Por dónde seguir: mirar si `gmeet-capture` está enganchado directo al STT
salteándose `speaker-streams`, y comparar con lo que hace el `compose` completo de Vexa, que
usa WhisperLive (streaming) en vez del endpoint OpenAI-compatible de `lite`.

### El mismo test viejo, otra vez, del lado del frontend

El CI de v0.1.2 salió **rojo en el job de frontend**, con backend y build en verde. El que
fallaba era el gemelo exacto del que ya se había arreglado en `ws.test.js`: *"Etapa 61
(integración real, regresión) — el profesor original reconectándose SÍ puede comenzar y
reanudar su propia clase"*, en `App.integracionBackendReal.test.js`. Esos tests levantan el
backend **real** en el mismo proceso (lo investigado en D.2), así que la gracia de 90 s los
alcanza igual.

El error lo decía todo sin ambigüedad: *"No llegó `class_resumable`"*, y entre los mensajes
recibidos estaba `{"type":"class_status", "active":true}` — la clase **seguía viva**, que es
exactamente el comportamiento nuevo. Mismo arreglo: la ventana fijada en 100 ms para ese
archivo y la espera del test subida a 600 ms.

**La lección:** al cambiar un comportamiento del backend hay que buscar los tests que lo
codifican **en los dos paquetes**. Siete archivos del frontend montan el Express y el WS reales
(ver la nota de D.2 en esta misma bitácora) y no aparecen buscando en `backend/tests/`.

Después del arreglo: **143/143 backend** (los 140 más los 3 del período de gracia) y
**164/164 frontend**. El job del CI pasó a llamarse `Backend (143 tests)`, y con él la entrada
correspondiente de `.github/ruleset-main.json` — están acoplados por el nombre exacto, así que
cambiar uno sin el otro dejaría un check obligatorio esperando por un job que ya no existe.

### ✅ CORRECCIÓN — la transcripción SÍ anda: era saturación de CPU, no un bug del upstream

La entrada anterior daba el problema por cerrado como "bug del Vexa upstream", con el argumento
de que las duraciones alineadas a 4096 muestras descartaban la saturación. **Ese razonamiento
estaba mal.** Con el modelo bajado a `tiny` y la máquina descargada, la transcripción funciona.

| | `small`, máquina saturada | `tiny`, máquina liviana |
|---|---|---|
| Fragmento más largo a Whisper | **0,77 s** | **6,66 s** |
| Segmentos transcritos | 0 | **3**, todos con `language: es` |
| Whisper | 402 % CPU · 2,28 GB | **0,75 % CPU · 242 MB** |
| Vexa completo | ~620 % CPU · 4,5 GB | ~25 % CPU · 0,8 GB |

Los fragmentos sub-segundo eran **la consecuencia** de la saturación, no su causa: el pipeline
por hablante de `speaker-streams.ts` no alcanzaba a acumular audio y lo vaciaba en bloques de
captura crudos. Con CPU disponible acumula hasta 6,6 s y Whisper produce texto.

⚠️ **Lo que sí queda es un trade-off, y hay que elegirlo a conciencia:**

- **`small`** transcribe bien pero **satura una notebook de 8 núcleos** y termina no
  transcribiendo nada. Peor que inútil: falla en silencio.
- **`tiny`** transcribe **mal** —*"que yo está buenos a que estoy teoyado"* es una muestra
  real— pero detecta el idioma bien y produce segmentos.

Ninguna de las dos sirve para la defensa tal cual. **La salida correcta es la que ya está
anotada en G.8: que Vexa no corra en la misma máquina que da la clase.** Con una máquina
dedicada, `small` tiene los 4-5 núcleos que necesita y transcribe bien. Es la misma conclusión
por dos caminos distintos.

**La lección de método**, que vale más que el bug: se dio un diagnóstico por cerrado sin
probar la hipótesis más barata. "Bajar el modelo y ver qué pasa" costaba dos minutos y se
descartó por un razonamiento sobre potencias de dos que sonaba convincente y era incorrecto.
**Cuando una hipótesis es barata de probar, se prueba antes de argumentar en su contra.**

### El bot tarda 13 segundos, no un minuto — y la admisión manual se saca

Medido con la máquina descargada:

```
20:16:23  el backend pide el bot
20:16:36  el bot ya está pidiendo entrar a Meet   ← 13 s
20:17:12  entra                                    ← 36 s esperando el clic de admisión
```

Con Whisper saturando la máquina ese primer tramo era de **un minuto**; ahora son 13 segundos.
Levantar un bot es levantar un Chrome headless entero, así que compite directamente con el STT
por los mismos núcleos.

**Los otros 36 segundos no son técnicos: es alguien apretando "Admitir".** Se eliminan
activando **Acceso rápido** en Meet (Controles del organizador → Acceso rápido): con eso el bot
entra solo. Vale dejarlo activado el día de la defensa — sin eso, el bot queda en
`awaiting_admission` y, si nadie lo admite a tiempo, Meet lo descarta con `join_failure`, que
es lo que pasó dos veces mientras se probaba.

⚠️ **Y hay que cerrar las reuniones que no se usan.** Cada pestaña de Meet abierta con la
extensión corre MediaPipe analizando video, y cada reunión viva en Vexa mantiene su propio
Chrome headless. Con tres reuniones acumuladas la notebook llegó a un **load average de 35**
sobre 8 núcleos, con `ReportCrash` al 47 % y WindowServer al 36 % — y ahí ya no importa qué
modelo de Whisper esté configurado.

### G.7 — CERRADO: 13 de 13, con una salvedad sobre "recuperar contenido"

Los dos ítems que faltaban funcionan y **la fase G queda completa**. Pero conviene tener
registrado *cómo* pasó "recuperar contenido", porque el log es más honesto que el checkbox:

```
Recuperar contenido — reunión "hea-owiz-ens": ventana=3min, 0 segmento(s),
0 caracter(es) (mínimo configurado: 25) → transcripción insuficiente, documento con info
Resumen de recuperación generado (ventana=3min) — 1085 tokens, gpt-4o-mini
```

El alumno pidió el resumen, el backend vio que **no tenía transcripción suficiente** para esa
ventana de 3 minutos y cayó a su camino de respaldo: armó el resumen a partir del **documento
de contexto**. El alumno recibió algo útil y nada falló.

⚠️ **O sea que lo que se probó fue el fallback, no el camino principal.** La ruta
"alerta → recuperar el tramo perdido **desde la transcripción**" —que es la que la tesis
describe— sigue sin ejercitarse de punta a punta, porque con `tiny` y una sola clase corta
apenas hubo 3 segmentos y ninguno cayó en la ventana pedida.

**Que degrade así es una virtud del diseño** y vale contarlo como tal si el tribunal pregunta:
el sistema prefiere responder con el material del docente antes que decirle al alumno que no
hay nada. Pero el checkbox no debe leerse como "el circuito completo está validado".

**Para cerrarlo de verdad** hace falta una clase con transcripción real acumulada — o sea con
Vexa en una máquina que aguante `small`, hablando varios minutos seguidos antes de pedir la
recuperación. Es la misma condición que pide G.8, otra vez.

### ⚠️ H.2 — la Store NO "ignora" el campo `key`: rechaza el paquete

El paso H.3 daba por sentado que la Chrome Web Store *"genera su propio par de claves e
**ignora** tu `key`"*. **Es falso**, y se descubrió intentando subir v0.1.2:

```
There was a problem uploading your file.
  key field is not allowed in manifest.
```

No lo ignora: **no deja subir el ZIP**. Y no se arregla borrando el campo del manifest del
repo, porque ese campo es exactamente lo que le da a la extensión **descomprimida** su id fijo
`kcjeagahhmdfdmgnoidbpmhbfiggbeif` — el que está en `ALLOWED_EXTENSION_IDS`. Sin `key`, cada
máquina que la cargue descomprimida genera un id distinto y el backend las rechaza todas por
CORS.

**Decidido: dos paquetes por Release, generados por el workflow.**

| Archivo | `key` | Para qué |
|---|---|---|
| `extension-<tag>.zip` | **sí** | Cargar descomprimida — desarrollo y pruebas |
| `extension-store-<tag>.zip` | **no** | Subir a la Chrome Web Store |

El segundo sale del **mismo build**: se le quita `key` con `node` y se vuelve a empaquetar. Se
edita con `node` y no con `sed` porque tocar JSON con expresiones regulares es exactamente cómo
se rompe un manifest sin que nadie lo note hasta que Chrome se niega a cargarlo. El paso
verifica los dos ZIP al final —que uno tenga `key` y el otro no— para que un error salga en el
workflow y no cuando alguien intente instalar.

⚠️ **Un detalle de shell que casi entra roto:** los dos chequeos van con `if` y no con
`&&`/`||`. Bajo `set -e`, una línea que termina en un `grep` sin coincidencias devuelve 1 y
aborta el paso — y en el segundo chequeo "no encontrar la key" es justamente el caso bueno. El
paso habría fallado **siempre**, y en el caso correcto.

**Para v0.1.2 el paquete se armó a mano** (bajar el Release, quitar `key`, recomprimir), porque
el ítem había que crearlo hoy. Desde el próximo tag salen los dos solos.

### ⚠️ H.1 — Google exige verificación en dos pasos, y la cuenta es compartida

Antes del error del `key`, el dashboard rechazó la subida con
*"Enabling 2 step verification on your account is required"*. Es un requisito de Google para
publicar, no algo del proyecto.

⚠️ **Y es una trampa para una cuenta compartida como la del equipo:** activar 2FA con el
teléfono de una sola persona deja a la otra **afuera de la cuenta dueña de la extensión
publicada**. Es el mismo problema que el del dominio, y se evita haciéndolo bien la primera vez.

**La forma correcta:** elegir *app de autenticación* (no SMS) y que **las dos personas escaneen
el MISMO código QR** — escanear el mismo QR hace que los dos teléfonos generen los mismos
códigos. Además, guardar los **10 códigos de respaldo** que da Google en la nota de Bitwarden de
esa cuenta, como red de seguridad si alguien pierde el teléfono.

### El DNS se movió a Cloudflare — hecho el 5/9/2026

Lo ejecutó Isola. Nameservers `kipp` y `may.ns.cloudflare.com`, con los **doce registros
importados idénticos**, así que no hubo ventana de caída: un resolver que todavía preguntara a
Namecheap y otro que ya preguntara a Cloudflare recibían la misma respuesta.

**Verificado desde este lado:** `api.sparkleedu.me` devuelve `<ip-del-servidor>` desde Cloudflare
(1.1.1.1), Google (8.8.8.8) y Quad9 (9.9.9.9) —o sea que ya propagó del todo— y el backend
sigue contestando 200 con TLS válido.

⚠️ **Los doce registros quedaron en "DNS only" (nube gris), y tiene que seguir así.** Con el
proxy de Cloudflare activado y el modo SSL en *Flexible*, Cloudflare le habla al origen por
HTTP mientras Caddy contesta HTTPS, y se arma un bucle de redirecciones. Si algún día se
quiere el proxy, primero hay que poner **SSL/TLS en Full (strict)** y recién después la nube
naranja.

**Quién controla qué**, que era el punto de todo esto: la zona vive en la cuenta compartida
del equipo, y Trufelman entra con los roles **DNS** + **Minimal Account Access** — alcanza
para editar registros y no incluye facturación ni agregar/quitar dominios. **La cuenta de
Namecheap queda personal de Isola**, a propósito: el registrador es el único lugar desde donde
se puede deshacer un error de DNS, y conviene que no sea la misma cuenta que la operación
diaria. El objetivo se cumple igual: el DNS se maneja sin depender de que Isola esté.

**Correo: no había nada que migrar.** Los MX de `eforward.registrar-servers.com` eran el
*default* de Namecheap — "Redirect Email" estaba vacío, sin forwarder ni catch-all. Quedaron
importados en Cloudflare pero **inertes**, porque ese reenvío solo funciona con los
nameservers de Namecheap. Si alguna vez hace falta una dirección `@sparkleedu.me`, se arma con
Cloudflare Email Routing, que es gratis. *(La advertencia de la entrada anterior sobre este
riesgo era correcta como precaución; el chequeo mostró que acá no aplicaba.)*

### ⚠️ El apex `sparkleedu.me` no tiene HTTPS válido — y no es del DNS

`http://sparkleedu.me` responde 200 y GitHub Pages sirve el sitio, pero **`https://` falla**:
el certificado que presenta es `CN=*.github.io`, el genérico de Pages, no uno para el dominio.
Verificado con `openssl s_client`.

**No lo causó la mudanza a Cloudflare** — los cuatro registros A del apex nunca se tocaron y
ya estaba así antes. Es una opción de **GitHub Pages**: en Settings → Pages del repositorio del
sitio hay que cargar el dominio personalizado y tildar **Enforce HTTPS**. Pages emite el
certificado solo, pero recién después de validar el dominio contra esos registros A.

No bloquea nada del despliegue —el backend vive en `api.` y tiene su propio certificado de
Caddy— pero conviene arreglarlo antes de que alguien de la cátedra entre al sitio y le salte
la advertencia del navegador.

### La `SPARKLE_API_KEY` no se comparte: ya está en el paquete

Isola la pidió para poder compilar contra producción. **No hizo falta mandarla:** está
horneada en el `background.js` de todo paquete publicado —verificado en el ZIP de v0.1.2— así
que cualquiera que tenga el Release ya la tiene. Se extrae con:

```bash
unzip -p extension-v0.1.2.zip background.js | grep -oE '[0-9a-f]{64}' | head -1
```

**El razonamiento, porque no es obvio:** es cierto que la clave no es protegible (A.7 lo dice
explícito, es el trade-off aceptado de la opción B). Pero de ahí no se sigue que dé lo mismo
mandarla por chat. Si algún día hay que rotarla, conviene que los únicos lugares donde exista
sean GitHub Secrets y Bitwarden — no una conversación de WhatsApp que nadie va a acordarse de
borrar. Que cada uno la extraiga del bundle que ya tiene cuesta lo mismo y no crea una copia
nueva.

### Pendiente: la API key también debería ser configurable en runtime

Observación de Isola, y es correcta. `frontend/src/config.js` dejó la **URL del backend**
cambiable desde las opciones sin recompilar (§1 lo celebra como "más importante de lo que
parece"), pero la **clave sigue horneada en el build**. Consecuencia: **un mismo paquete
todavía no sirve contra dos entornos distintos**, que era justo la mitad del objetivo.

Hoy, apuntar la extensión publicada a un backend local requiere recompilar, y cambiar la clave
en producción obliga a republicar en la Store y esperar otra revisión de Google.

**El arreglo es el mismo patrón que ya existe:** guardarla en `chrome.storage.local` al lado de
`backendUrl`, con el valor del build como respaldo. Va como mejora, no bloquea nada.

### El apex quedó sin registros, a propósito

**Decidido y ejecutado el 5/9/2026:** se borraron los cuatro registros A de `sparkleedu.me` y
el de `www`. El apex **ya no resuelve**. `api` quedó intacto y el backend sigue en 200 con TLS
válido — verificado después del cambio.

**Por qué no se arregló el HTTPS en vez de sacarlo.** La vía obvia era cargar el dominio en el
repo de Pages y tildar Enforce HTTPS, pero Isola marcó el efecto secundario: es un **user
site** (`franisola.github.io`), y ponerle un dominio propio hace que `franisola.github.io`
empiece a **redirigir** al dominio de la tesis. Su portfolio quedaría absorbido. Razón
suficiente para descartarlo.

**Por qué tampoco se puso una redirección**, que era lo que él proponía en su lugar. El destino
natural —el repositorio del proyecto— es **privado**, así que redirigir ahí le daría un 404 a
cualquiera de afuera: peor que no resolver. Y hacerlo público está descartado desde antes (el
código no se publica hasta defender la tesis).

**Que el apex no exista es la opción honesta**: no hay sitio todavía, y el sistema entero vive
en `api.`. Cuando la extensión salga aprobada, el apex puede apuntar a la ficha de la Chrome
Web Store —que funciona aunque el ítem sea *no listado*— o a una landing propia.

**Cómo se hace la redirección el día que haga falta**, para no volver a investigarlo: un
registro `AAAA @ → 100::` (el prefijo de descarte: el tráfico nunca sale hacia ahí) con el
proxy **activado**, más una Redirect Rule en Rules → Redirect Rules. Necesita la nube naranja,
pero eso **no afecta a `api`**, que queda en DNS only y por lo tanto fuera del modo SSL de la
zona.

⚠️ **El cambio lo ejecutó Trufelman solo, desde Cloudflare**, sin tocar el repositorio de Isola
ni pedirle nada. Es exactamente para lo que servía delegar el DNS: la primera vez que hizo
falta operar el dominio, no hubo que esperar a nadie.

### H.2 — CERRADO: enviada a revisión el 5/9/2026

`Sparkle V2` **v0.1.2** quedó en **Pending review**, como ítem **no listado**. ID de la Store:
`ldklcfnbfhljgbgjhiemblcbmchlpcip`, ya cargado junto al de la descomprimida en
`ALLOWED_EXTENSION_IDS` y desplegado (H.3).

**Cuatro trabas que el plan no anticipaba, en el orden en que aparecieron:**

1. **Google exige 2FA en la cuenta** antes de dejar subir nada. En una cuenta compartida eso
   puede dejar afuera a una de las dos personas — ver la entrada de H.1 más arriba.
2. **El campo `key` del manifest hace que la Store rechace el ZIP.** Ver la entrada propia.
3. **Hay que verificar el email de contacto del publisher**, en Settings del dashboard y no en
   el ítem. El mensaje de error dice "Settings page" pero el campo está arriba de todo en esa
   página, arriba de "Address" — fácil de no ver. `Address`, `Trusted testers` y
   `Service account`, que están más visibles ahí, **no** son obligatorios (el primero solo
   aplica a cuentas *trader*).
4. **El email de contacto queda público** en la ficha del ítem. Con un ítem no listado solo lo
   ve quien tenga el link, así que se dejó el de la cuenta del equipo.

⚠️ **Se declaró "No estoy usando código remoto", y la respuesta se verificó antes de darla.**
El formulario venía marcado en "Yes", lo que dispara una revisión más profunda. Se comprobó:
los **7 archivos WASM** de MediaPipe y LiteRT están **empaquetados**, y la única URL de script
remoto del bundle (`cdnjs.cloudflare.com/.../pdfobject.min.js`) llega dentro de **jsPDF**, en
la rama `output('dataurlnewwindow')` — que el código **no usa**: `generateClassReport.js`
genera el PDF con `doc.save()`. Es una cadena muerta en el bundle, no código que se ejecute.
Si Google lo cuestiona, ese es el argumento.

**Datos declarados:** información personal identificable (el email con el que se entra a la
reunión), actividad del usuario (indicadores de atención y respuestas) y contenido de sitio
web (los documentos que sube el docente). **No** se declaró *comunicaciones personales*: los
ejemplos del formulario son mails, mensajes y chats, y además la transcripción no la captura
la extensión sino el bot de Vexa, que entra a la reunión como un participante más.

**Las tres certificaciones se marcaron**, y son ciertas: no se venden ni ceden datos, no se
usan para nada ajeno al propósito, y no se evalúa solvencia crediticia. Lo de OpenAI no es
transferencia a terceros sino procesamiento para el propósito declarado.

### La landing: nació para el apex y terminó resolviendo la política de privacidad

Google **exige una URL pública de política de privacidad** para publicar una extensión que
recolecte datos. El plan no lo menciona en ningún lado, y sin sitio no había dónde publicarla:
el apex acababa de quedar sin registros.

Se armó una landing de un solo archivo con la descripción del proyecto **y la política de
privacidad completa** —qué datos se guardan, que el video nunca sale del dispositivo, con
quién se comparten, y la justificación de cada permiso— en un repo **público y separado**,
`maxiTrufel/sparkle-landing`. El código de la tesis sigue privado.

⚠️ **El dominio propio no se pudo usar, y el motivo importa:**

```
The custom domain `sparkleedu.me` is already taken.
```

El repo `franisola.github.io` **sí tenía el dominio cargado** como custom domain —Isola creía
que no—, y GitHub reserva también el `www`, así que ninguno de los dos estaba disponible. Se
le pidió que lo libere; hasta entonces la política vive en
**`https://maxitrufel.github.io/sparkle-landing/`**, que funciona con HTTPS válido y **no
depende de nadie**. Los registros A del apex y el CNAME de `www` ya quedaron apuntando al repo
nuevo, en DNS only: el día que lo libere, toma solo.

*(Nota de método: ese sitio de Pages es un **project site**, no un user site. Ponerle un
dominio propio no redirige `maxitrufel.github.io` a ningún lado — que era exactamente la
objeción, correcta, de Isola sobre hacerlo en el suyo.)*

**Las capturas de la ficha se generaron con Chrome headless**, componiendo los paneles reales
sobre un lienzo de 1280×800 con HTML y CSS. Vale el detalle porque la primera tanda salió con
**cada texto describiendo una pantalla distinta a la que se veía**: los archivos `1.png`…`5.png`
no seguían el orden en que se habían mostrado. Se corrigió mirando archivo por archivo. Los
promo tiles (440×280 y 1400×560) salieron por el mismo camino y son **opcionales** — sirven
para que la Store destaque el ítem, cosa que no aplica a uno no listado.

### `ALLOWED_EXTENSION_IDS` — reconfirmado contra el manifest

Isola marcó que sin `kcjeagahhmdfdmgnoidbpmhbfiggbeif` en la lista el backend rechaza todo por
CORS sin explicar por qué. **Los secretos de GitHub no se pueden volver a leer**, así que en vez
de dar por bueno lo cargado en E.3 se volvió a escribir, y se verificó que el ID coincide con
el que sale de la `key` del manifest (el cálculo está más arriba, en la entrada del `.pem`).
Coinciden. El ID de la Store se suma a esta lista, separado por coma, recién en H.3.

### Números reales de la suite de tests

El plan dice "130 tests de backend y ~30 de frontend". Los números medidos hoy:

| | Antes | Ahora |
|---|---|---|
| Backend | 130 | **140** (+10 de `apiKey.test.js`) |
| Frontend | 164 | **164** |

`apiKey.test.js` es el único test del backend que **no necesita MariaDB**: monta el
middleware sobre un router de juguete.

### I.3 — CERRADO: la restauración probada, y el backup que había en S3 no servía

Lo primero que apareció al ir a probar la restauración es que **el único backup en S3 era el
de la prueba de escritura de I.4**, del 5/9 a las 16:53 UTC: la base recién migrada y **vacía**.
El cron corre a las 06:00 UTC y se instaló después de esa hora, así que su primera corrida es
recién el 6/9. O sea que **los datos de la clase de prueba existían en un solo lugar** —el
volumen de la instancia— y restaurar ese backup habría probado el mecanismo contra una base sin
nada, que es justo lo que I.3 viene a evitar.

**Se corrió `backup.sh` a mano antes de nada.** Resultado: `2026-09-06T00-53-40Z`, dump de
**34.717 bytes** y uploads de **9,86 MB**, contra los 2.371 y 89 bytes del anterior. Ese es el
backup que se restauró, y de paso los datos de la clase quedaron respaldados fuera del servidor.

**Dónde se restauró, y por qué no en una instancia descartable.** El paso pedía "una instancia
descartable". Se hizo con **contenedores descartables en la notebook** —un `mariadb:10.11`
limpio y un volumen vacío, los mismos que usa producción— y no con un EC2 nuevo. El motivo: lo
que I.3 tiene que probar es que **el dump y el tar reconstruyen un estado coherente**, y eso no
depende del hardware. Levantar la infraestructura desde cero es lo que prueba **J.2**, que sigue
pendiente y es donde ese ejercicio corresponde. Cuesta cero y no toca producción.

**Se ejercitaron los mismos pasos que hace `restaurar.sh`**, en el mismo orden: `gunzip` del
dump contra `mariadb` como root, vaciado del volumen y `tar` desde un `alpine` descartable, y
`npm run migrate` al final. Se verificó además que el dump trae `CREATE DATABASE ... IF NOT
EXISTS` y `USE`, que es lo que el script da por sentado para no tener que dropear la base a mano.

| Verificación | Resultado |
|---|---|
| Contenido restaurado | 19 reuniones, 227 filas de atención, 28 participaciones, 27 sesiones de transcripción, **23 segmentos**, 10 preguntas, 5 respuestas, 16 archivos, 4 usuarios |
| **`files` contra el disco** | **16 filas, 16 archivos, y el `size_bytes` de cada fila coincide con el tamaño real** — un `diff` de las dos listas da vacío |
| **Los PDFs contra los de producción** | **los 16 `md5` idénticos** |
| Cabecera `%PDF-` | 16 de 16, ninguno corrupto |
| `analysis_result` del PDF de la clase | 7.088 caracteres, `JSON_VALID` = 1 |
| Esquema | el de las migraciones, no el derivado de la base local: `created_at` queda **después** de `attention_window_started_at` |
| `npm run migrate` sobre lo restaurado | *"Nada que hacer: 1 migración ya está aplicada"* |

La fila que importa es la segunda, y la tercera la refuerza: el riesgo que I.1 declaraba en
negrita —una base que lista archivos que no están en disco— **no se materializa**. El dump y el
tar de la misma corrida producen un estado coherente, y los archivos vuelven byte a byte.

⚠️ **Dos salvedades honestas.** La primera: se ejecutaron los pasos de `restaurar.sh`, no el
script. Es destructivo y corre contra `/opt/sparkle`, así que probarlo tal cual habría exigido
restaurar **sobre producción**. Lo que queda sin ejercitar del script en sí son su envoltorio
—el `aws s3 cp`, la confirmación escrita, el `compose stop backend`—, no la mecánica de la
restauración.

La segunda: "abrir una clase que tenga PDF adjunto" se verificó **contra los datos**, no contra
la pantalla. La reunión `hea-owiz-ens` —la de G.7— vuelve con su PDF de 1.172.533 bytes en
`processed` y su análisis JSON entero. Levantar el backend contra la copia restaurada para
mirarlo en la extensión habría agregado poco: lo que podía fallar era la coherencia entre las
dos mitades del backup, y eso está comprobado con más precisión que a ojo.

**Un dato que ya no preocupa:** el guard que aborta si el dump pesa menos de 1 KB tenía en I.4
un margen de apenas el doble. Con datos reales el dump es de 34 KB, así que el margen pasó a ser
de 34 veces, como se esperaba.

### La access key: se borró la clave de más y se decidió NO rotar la que está en uso

El plan de C.9 dejaba la rotación como pendiente ("la access key sigue sin rotar, se
expuso al compartirla en una captura"). Se intentó el 5/9/2026 y **se decidió dejarla como está**. El estado final
es **una sola clave activa**, la original, y la cuenta con lo mismo que tenía.

**Por qué se decidió no rotarla.** Ninguna pieza del sistema depende de esas credenciales: el
deploy entra por SSH con `~/.ssh/sparkle_deploy`, el servidor escribe en S3 con su instance
profile y GitHub Actions no tiene credenciales de AWS —fue el motivo de elegir GHCR sobre ECR
en §4—. O sea que la access key la usa **únicamente el AWS CLI de la notebook**, y rotarla no
podía romper nada, pero tampoco arregla nada que hoy esté roto. Lo que queda es el riesgo de que
la clave —con `AdministratorAccess`— se filtre desde donde quedó registrada: probabilidad
baja, consecuencia alta (levantar instancias caras, borrar el servidor o el bucket de backups).
**Se aceptó ese riesgo a conciencia**, no por olvido. Si alguna vez se quiere cerrar, es un
minuto y los comandos están abajo.

⚠️ **Lo que sí se hizo, porque costaba diez segundos: borrar la segunda clave.** Durante el
intento quedó creada una clave nueva, activa y sin usar. Una credencial de administrador que
nadie usa es superficie de ataque gratis: nadie la va a echar de menos si se la roban, y no hay
ningún log que uno esté mirando. Se borró.

**Tres cosas de la operación que conviene no repetir:**

1. **El comando que se usó primero imprime la clave secreta en pantalla**
   (`create-access-key --query 'AccessKey.[AccessKeyId,SecretAccessKey]'`). Al pegar la salida
   para seguir, la clave nueva quedó expuesta **igual que la que se venía a reemplazar**. Rotar
   con un comando que muestra el secreto no rota nada: cambia una clave expuesta por otra.
   La forma que no lo muestra es capturar el JSON en una variable y pasárselo a
   `aws configure set`.
2. **El cliente enmascara los IDs `AKIA…` al pegarlos**, así que todo comando que lleve un ID
   escrito a mano llega con el valor tapado y falla con
   `ValidationError: must contain only alphanumeric characters`. Los comandos tienen que
   **derivar el ID de la API**, comparando contra `aws configure get aws_access_key_id`.
3. **Son dos claves por usuario como máximo.** Con las dos ocupadas, `create-access-key` corta
   con `LimitExceeded`, así que el orden obligado es borrar y después crear.

**Si alguna vez se rota**, son estos dos comandos, en orden — el segundo es el mismo que borró
la clave de más y sirve igual para borrar la vieja, porque siempre elimina la que **no** está
configurada:

```bash
NUEVA=$(aws iam create-access-key --user-name maximo --output json) && aws configure set aws_access_key_id "$(printf '%s' "$NUEVA" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"])')" && aws configure set aws_secret_access_key "$(printf '%s' "$NUEVA" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"])')" && unset NUEVA && aws sts get-caller-identity
```

```bash
EN_USO=$(aws configure get aws_access_key_id); OTRA=$(aws iam list-access-keys --user-name maximo --query "AccessKeyMetadata[?AccessKeyId!='$EN_USO'].AccessKeyId" --output text); if [ -n "$OTRA" ]; then aws iam delete-access-key --user-name maximo --access-key-id "$OTRA"; fi
```

Después de rotar hay que actualizar la nota `Sparkle - AWS access key` de Bitwarden, leyendo el
valor de `~/.aws/credentials` **en la terminal propia**, sin pegarlo en ningún lado.

### ⚠️ El bot de Vexa se iba solo de la reunión — arreglado en v0.1.3

Reportado el 6/9/2026 sobre la reunión `jaa-ybou-siz`: el bot entró, transcribió un rato y
**se fue solo**. Los logs cuentan la historia completa, y es **el mismo bug que se arregló en
v0.1.2, en el camino de al lado**, que aquel arreglo no cubría.

```
01:36:46.341  se cierra el WebSocket del alumno
01:36:46.538  se cierra el del docente        ← 200 ms después
01:36:46.540  "la clase se finalizará en 90 s si no vuelve"   ← la gracia de v0.1.2 actúa
01:36:46.842  DELETE /bots/google_meet/jaa-ybou-siz            ← el bot sale AL INSTANTE
01:36:48.930  "Finalización automática CANCELADA — el docente volvió"
01:36:52      el re-join pide un bot NUEVO
01:37:04      awaiting_admission
01:42:18      failed                                           ← nadie lo admitió en Meet
```

Chrome congela las pestañas en segundo plano y les cierra el socket. Con las dos pestañas
congelándose casi a la vez, la sala WS quedó **vacía por dos segundos** — y
`handleClose` sacaba el bot en cuanto `rooms.has(meetingCode)` daba `false`, sin ninguna
demora. La clase se salvó porque esa sí tenía gracia; el bot no la tenía.

⚠️ **Y volver no es gratis, que es lo que convierte un parpadeo en una clase sin
transcripción.** El `startBot` del re-join no recupera el bot que se fue: pide uno **nuevo**,
que entra en `awaiting_admission` y necesita que alguien apriete "Admitir" en Meet. Nadie lo
hizo, y a los cinco minutos Google lo descartó con `join_failure`. Del lado de Sparkle no hay
ningún error: la reunión simplemente se queda sin transcripción para siempre, que es
**indistinguible del modo degradado** que §8 declara como esperado. Otra vez el mismo modo de
falla silencioso de F.6.

**El arreglo, calcado del de v0.1.2:** la salida del bot se difiere `EMPTY_ROOM_BOT_GRACE_MS`
—que por defecto **toma el valor de la gracia del docente**, 90 s, para que las dos ventanas no
se separen sin que nadie lo decida— y se cancela si vuelve alguien. Tres cosas que se cuidaron:

1. **Cancela CUALQUIER rol, no solo el docente.** Lo que dispara la salida es que no quede
   nadie; si solo lo cancelara el docente, el caso real —los dos congelados y el alumno
   volviendo primero— seguiría roto.
2. **El chequeo de "la sala sigue vacía" se repite adentro del timer**, no al programarlo:
   entre una cosa y la otra pasa minuto y medio y lo que importa es el estado al ejecutar.
3. **Si no vuelve nadie, el bot sale igual.** Demorar la salida no puede volverse no sacarlo
   nunca: un bot olvidado en una reunión terminada sigue grabando y comiéndose la notebook.

`tests/emptyRoomBotGrace.test.js`, 3 casos, en archivo aparte por lo mismo que el otro: la
ventana se lee de `process.env` una sola vez, al cargar `handlers.js`. El doble de Vexa se
instala pisando las propiedades del módulo exportado —`handlers.js` guarda el módulo entero,
no cada función—, así que no hizo falta ningún framework de mocks.

**Dos cosas del contexto que conviene no confundir con el bug:**

- **La máquina estaba otra vez saturada** (load average 13,6 sobre 8 núcleos, con Whisper y
  varias reuniones abiertas). No es la causa —el `DELETE` está en el código y se dispara igual
  con la máquina libre— pero sí explica que las pestañas se congelen más seguido: cuanto más
  cargada la notebook, más probable el parpadeo que dispara todo.
- **"Acceso rápido" de Meet sigue sin estar activado**, y es lo que habría salvado la reunión
  incluso con el bug: el bot nuevo habría entrado solo en vez de morir esperando. Está anotado
  desde la entrada de los 13 segundos; conviene dejarlo activado siempre, no solo el día de la
  defensa.

**No hace falta volver a subir la extensión a la Store.** El arreglo es del backend: el
paquete v0.1.2 que está en revisión anda igual contra un backend v0.1.3.

### El bot se iba por SEGUNDO motivo: `left_alone` a los 10 minutos de silencio

Después de desplegar v0.1.3 el bot se volvió a ir, y **no era el mismo bug**. El arreglo
anterior funcionó y quedó probado en producción con la reunión vieja:

```
02:05:46  Sala "jaa-ybou-siz" vacía — el bot de Vexa saldrá en 90 s si no vuelve nadie.
02:07:16  Sacando el bot de Vexa — la sala siguió vacía todo el período de gracia.
```

Noventa segundos exactos, y esa reunión sí estaba abandonada de verdad.

**La reunión nueva (`dyb-qkeo-bza`) no recibió ningún `DELETE` de Sparkle.** El bot se fue
solo, y el log del propio bot lo dice:

```
[bot] aloneness: silence adapter enabled (window_ms=600000)
02:06:08  ✅ Admitted: 2 real participant tile(s) present
02:07:13  ← último audio remoto detectado
02:17:14  [bot] aloneness: silence verdict → leave_reason="left_alone"
```

Vexa tiene un detector de soledad que **saca el bot si no escucha hablar a nadie durante 10
minutos**. No mira si hay participantes: mira si hay audio. Una clase con diez minutos de
ejercicio individual, un video o lectura en silencio lo dispara igual.

**Decidido: `BOT_ALONE_SILENCE_WINDOW_MS=3600000`** (una hora) en el `.env` de Vexa. El valor
por defecto es 600000 y la variable ya existía vacía, así que era el default del bot el que
mandaba. Una hora es más que cualquier clase, y el detector no hace falta como red de
seguridad: **Sparkle ya saca el bot cuando la sala WS queda vacía** (con los 90 s de v0.1.3),
que es un criterio mejor —mira quién está conectado, no quién está hablando—. Se aplicó con
`make -C deploy/lite up LOCAL_STT=1`; el contenedor del gateway **sí** se recrea en cada `up`
(a diferencia del de Whisper, ver F.7), así que alcanzó con eso.

⚠️ **Ese `.env` vive solo en la notebook y no está en git.** Si Vexa se reinstala o se mueve a
otra máquina —que es la salida anotada en G.8— hay que volver a ponerlo, y su ausencia no da
ninguna señal: simplemente el bot se va a los diez minutos otra vez.

**Y una tercera cosa, que no es del proyecto pero lo está rompiendo:** la notebook estaba en
**load average 23 sobre 8 núcleos** con Vexa prácticamente en reposo (Whisper al 1,8 %). El que
se estaba comiendo la máquina era **`ReportCrash` al 88 %**, procesando los crashes en bucle de
**CleanMyMac X Menu** — 18 reportes de crash en las últimas horas. Es exactamente lo que hace
que Chrome congele las pestañas, o sea el disparador del bug de v0.1.3. Conviene cerrar
CleanMyMac antes de una clase; el `ReportCrash` al 47 % que ya se había anotado en la entrada
de los 13 segundos era la misma causa, no identificada entonces.

**La lección, que ya van dos:** "el bot se fue" tiene varias causas distintas y el log del
workload (`/tmp/vexa-workloads/mtg-*.log` dentro del contenedor `vexa-lite`) dice cuál en una
línea — `leave_reason`. Vale mirarlo **antes** de suponer que es el bug que ya se conocía:
`stopped` es Sparkle pidiéndolo, `left_alone` es el detector de silencio, `join_failure` es
que nadie lo admitió.

### ⚠️ La tercera causa, y la peor: `startBot` mataba bots sanos — arreglado en v0.1.4

Tercera clase de prueba, tercera causa distinta de "el bot se fue". Esta es la que venía
pasando desde el principio y las dos anteriores tapaban.

```
02:40:47  el docente entra, startBot pide el bot
02:41:14  bot ACTIVO, transcribiendo
02:41:26  entra el alumno
02:43:06  se cierra el socket del DOCENTE (pestaña congelada)
02:43:08  el docente vuelve — "Finalización automática CANCELADA"
02:43:09  DELETE /bots → el bot se va                        ← nadie lo pidió
02:43:11  se pide un bot NUEVO, que hay que admitir otra vez
```

**El alumno nunca se desconectó**, así que la sala jamás estuvo vacía y el camino de v0.1.3 ni
se ejecutó. El `DELETE` salió de otro lado: de `startBot`, el que corre en **cada join del
docente**.

**La lógica que estaba mal.** Ante un 409 de Vexa ("ya hay un bot para esta reunión"),
`startBot` decidía así: si el último arranque exitoso tenía **más de dos minutos**, asumía
*sesión fantasma* —un bot que fue echado del Meet y Vexa no se enteró—, lo borraba y pedía uno
nuevo. El problema es que "hace más de dos minutos que arrancó" describe a un bot **sano** tanto
como a uno muerto: es lo normal en cualquier clase que dure más de dos minutos. Cualquier
reconexión del docente pasada esa marca —una pestaña congelada, un F5, un microcorte— sacaba de
la reunión a un bot que estaba funcionando.

Y el costo no es reiniciar el bot: el bot nuevo entra en `awaiting_admission` y **hay que
admitirlo de nuevo en Meet**. Si nadie lo hace, Google lo descarta y la reunión se queda sin
transcripción.

**Por qué el comentario del código descartaba la solución correcta.** Decía, textual, que
consultarle el estado a Vexa no servía "porque es la MISMA fuente que ya causó el 409 falso".
Eso es cierto del campo `status` —un bot echado del Meet sigue figurando `active`— pero **no de
`updated_at`**, que no es una opinión sino un **latido**: el bot lo mueve mientras corre y se
congela cuando muere. Medido contra la Vexa real: 02:50:42 → 02:50:56 → 02:51:26, o sea cada
14-30 segundos.

**El arreglo:** ante un 409 se consulta `GET /bots` y se busca una sesión de esa reunión en
estado vivo (`requested`, `joining`, `awaiting_admission`, `active` — `stopping` no cuenta, ya
se está yendo) cuyo latido tenga **menos de dos minutos**. Si la hay, el 409 es legítimo y no se
toca nada. Si no, es fantasma y sigue el camino de siempre.

**La regla ante la duda, que es la parte que importa:** si no se puede consultar a Vexa, la
función devuelve `null` —"no sé"— y el llamador **no mata nada** (cae al reloj propio de antes,
que queda solo como plan B). Los dos errores no cuestan lo mismo: matar un bot sano rompe la
clase que está pasando, mientras que dejar viva una sesión fantasma solo demora la transcripción
hasta el próximo intento.

`tests/vexaSesionFantasma.test.js`, 3 casos: latido fresco → no se toca; latido congelado de
diez minutos → sí se reemplaza; consulta caída → no se toca.

**La lección de método, que ya apareció con lo de `small` y las potencias de dos:** el
comentario que descartaba la solución correcta era **casi** cierto, y por eso sobrevivió. Estaba
bien razonado sobre el campo equivocado. Un argumento sólido sobre `status` se leyó como un
argumento sobre "preguntarle a Vexa", que es una categoría más grande — y ahí adentro estaba
`updated_at`, que resolvía el problema.

### Otro test intermitente del CI, y esta vez el mensaje mentía distinto

El CI de v0.1.4 salió rojo en backend con **un test que no tiene nada que ver con el cambio**:
*"isDocumentReadyForMeeting refleja el estado real del análisis"*, en `documentAnalysis.test.js`.
Local pasa en **557 ms**; en el runner del CI falla.

El error era `resolveExtraction is not a function`, que no menciona en ningún lado el problema
real: **`uploadDocument` responde antes de que el análisis arranque**. El test guardaba el
`resolve` de la promesa del mock y lo llamaba enseguida, dando por hecho que para entonces
`extractText` ya había sido invocado. En una máquina rápida eso pasa siempre; en el runner del
CI, no — y la variable todavía valía `undefined`.

**Arreglado esperando a que el mock haya sido llamado de verdad**, con una promesa que se
resuelve dentro del propio `extractText`, y un timeout de 5 s que falla diciendo *"el análisis
nunca llamó a extractText"* en vez de reventar más abajo.

⚠️ **Y el timer de ese timeout necesitó `unref()` y `clearTimeout`**: la primera versión dejaba
el proceso de `node --test` vivo hasta que venciera, y el archivo pasó de 1,0 s a **5,6 s** — un
test que igual pasaba, pero cinco segundos más lento por un timeout que nunca hizo falta. Es la
misma trampa que ya había aparecido con los timers del período de gracia.

**Es un arreglo de tests, no de producción:** no cambia una línea del código que corre en el
servidor, así que **no lleva tag nuevo**. Va a `main` y v0.1.4 sigue siendo lo desplegado.

**Ya van tres fallas de CI del mismo tipo** —esta, la de la etapa 61 y la de la clase que se
finalizaba sola—: todas por esperas que alcanzan en una máquina rápida y no en el runner. Vale
como patrón a sospechar primero cuando el CI falla en un test que el cambio no tocó.

### El bot echado a mano: la detección de fantasma anda, y aparecieron dos huecos

Prueba deliberada del 6/9/2026: con la reunión `pxk-hxgn-coy` andando, se **echó al bot desde
Meet** para ejercitar el caso que el arreglo de v0.1.4 tiene que distinguir del bot sano.

**El latido hace exactamente lo que se esperaba.** Monitoreando la sesión cada 15 segundos, el
`updated_at` avanzaba solo (…03:28:15 → 03:28:30 → 03:28:45) y **se congeló en 03:28:45**, el
instante en que lo echaron. Vexa siguió reportando la sesión como `active` — la sesión fantasma
que §8 y el comentario viejo del código describían, y la prueba de que mirar el `status` no
alcanza y mirar el latido sí.

Al recargar la pestaña del docente a las 03:31:40, con el latido congelado hacía casi tres
minutos, el camino corrió entero y en orden: `startBot` → 409 → latido viejo → `DELETE` de la
sesión muerta → sesión vieja a `completed` → bot nuevo pedido → `awaiting_admission`. **La
lógica nueva discrimina los dos casos**, que es todo lo que se le pedía.

**Hueco 1 — "reanudar clase" no pide el bot.** Fue lo primero que se intentó y no pasó nada. En
los logs se ve `Clase finalizada MANUALMENTE` y `Clase REANUDADA` sin un solo `startBot`
después: el bot se pide **únicamente en el `join` del docente al WebSocket** (`handlers.js`), no
al arrancar ni al reanudar la clase. O sea que si el bot se cae o lo echan, la única forma de
traerlo de vuelta es **recargar la pestaña** — algo que nadie va a adivinar en el medio de una
clase, y que además no da ninguna señal: la clase reanuda normalmente, solo que sin
transcripción.

**Hueco 2 — hay una ventana de dos minutos en la que no se puede recuperar.** `LATIDO_MAXIMO_MS`
son 120 s, así que durante los dos minutos siguientes a que lo echen, `startBot` considera la
sesión viva y no la reemplaza aunque se recargue. Es el precio deliberado de no matar bots
sanos, pero conviene tenerlo dicho: **echar el bot cuesta como mínimo dos minutos de
transcripción**, más lo que tarde el backoff de reintentos (hasta ~54 s) y la admisión en Meet.

**El hueco 1 quedó arreglado en v0.1.5:** `start_class` y `resume_class` ahora vuelven a pedir
el bot y el polling, igual que el `join`. Es barato y seguro por el arreglo de v0.1.4 — si el
bot está vivo, Vexa contesta 409 y `startBot` corta sin tocar nada; `startPolling` es no-op si
ya había uno. Con eso "recargá la pestaña" pasa a ser algo que el sistema hace solo, y
**"Reanudar clase" se convierte en el gesto natural para recuperar la transcripción**, que es lo
que cualquiera intentaría primero.

⚠️ **El comentario del código decía que no hacía falta**, con el argumento de que el ciclo de
vida del bot está desacoplado del estado pedagógico de la clase. Eso es cierto para *cuándo
arranca* el bot y era una mala razón para no **reintentar**: dejaba el `join` como la única
oportunidad de conseguir un bot en toda la reunión. Es el mismo tipo de error que el comentario
sobre `/bots/status` en `vexaService`: un razonamiento correcto sobre una pregunta, aplicado a
otra más grande.

`tests/botAlArrancarClase.test.js`, 2 casos, uno por cada handler.

**El hueco 2 se deja como está, decidido el 6/9/2026.** Los dos minutos son el precio de no
matar bots sanos, y bajarlos acerca el umbral al intervalo de latido (15-30 s), donde un pico de
carga empezaría a parecer un bot muerto. La consecuencia práctica, que conviene tener dicha:
**si al bot lo echan y se reanuda la clase antes de dos minutos, no se reemplaza** — hay que
esperar. No da ningún mensaje, así que parece que el botón no hizo nada.

Se evaluó y **se descartó** una mejora: usar un umbral más corto (~30 s) cuando el pedido viene
de `start_class`/`resume_class` en vez de un `join` automático. El argumento a favor es bueno
—un docente apretando "Reanudar" es una persona diciendo explícitamente "esto no anda", muy
distinto de una reconexión que ocurre sola— pero el caso es raro (alguien tiene que echar el bot
a propósito) y no justifica una segunda ventana que mantener. Queda anotado por si el escenario
aparece seguido.

### El repo de Vexa estaba desincronizado en las dos direcciones — 6/9/2026

Al revisar si los dos repos estaban al día apareció que **Sparkle_V2 sí lo estaba**
(`main` = `origin/main`, árbol limpio) pero **Sparkle_V2_Transcripcion no**, y por dos
motivos distintos a la vez:

1. **El local estaba 2 commits atrás.** Los commits que agregaron el `.gitignore` y el
   `INSTALL.md` se habían hecho directamente sobre GitHub, no desde el clon: en disco esos
   dos archivos existían, pero **sin trackear**, y la rama local seguía apuntando al
   `primer commit`.
2. **El primer commit se hizo sin los dotfiles de la raíz.** Faltaban en el remoto
   `.github/` (plantillas de issue/PR y 12 workflows), `.githooks/pre-push`,
   `.dockerignore`, `.gitattributes` y `.dependency-cruiser.cjs`. Es el síntoma clásico de
   haber importado el árbol con un `cp -r origen/* destino/`: el glob del shell no toma los
   archivos que empiezan con punto. Encaja con que el `.env` sí estuviera (lo crea después
   el paso 3.7) y con que el repo no tuviera `.gitignore` propio.

**Decidido:** tomar el disco local como fuente de verdad —es lo que está andando— y
**fusionar los dos `.gitignore`** en vez de elegir uno. El del remoto era el que se había
escrito a mano para tapar el `.env`, el del disco es el del upstream de Vexa (`node_modules`,
`dist`, los `docs/views` generados, los modelos de transcripción descargados). Quedarse con
el del disco solo habría dejado de ignorar `*.pem`, `*.key` y `deploy/lite/.last-tag`.
Verificado después del merge que `.env` sigue ignorado y que no quedó trackeado.

También entró el arreglo del `deploy/lite/Makefile`: `ENV_FILE`, `DOCKERFILE` y `CONTEXT` van
entrecomillados porque **la carpeta de trabajo tiene un espacio en el nombre**
(`Codigo Tesis`) y las recetas se rompían al expandirlas.

La sincronización se hizo con `git reset origin/main` y no con un `merge --ff-only`: el
merge se negaba porque los dos archivos sin trackear del disco iban a ser pisados por los
commits que venían del remoto. El `reset` (sin `--hard`) mueve el puntero y el índice sin
tocar el disco, y como el commit local era ancestro del remoto no había nada que perder.
Quedó en `9c0ecbe`, pusheado.

**Dos cosas quedaron abiertas, a propósito:**

- **Los 12 workflows del upstream ahora corren en el fork.** Son los de Vexa —publican
  imágenes, atestan releases, validan PRs— y apuntan a infraestructura que no es nuestra, así
  que van a fallar y a mandar mail en cada push. Se subieron igual para que el remoto sea un
  espejo fiel de lo que anda localmente. Si molestan: `git rm -r --cached .github/workflows`
  y agregar esa ruta al `.gitignore`.
- **`main` no tiene upstream configurado** en el clon de Vexa, así que `git status` no avisa
  cuando el remoto se adelanta —que es exactamente cómo pasó desapercibido lo del punto 1—.
  Se arregla con `git branch --set-upstream-to=origin/main main`.


### La v0.1.2 que está en revisión no hay que reemplazarla — 6/9/2026

Duda razonable al cerrar el día: lo que se mandó a la Store el 5/9 es la **v0.1.2**, y para
entonces el código ya iba por **0.1.5** con los tres arreglos del bot de Vexa. La pregunta era
si la versión en revisión iba a nacer rota.

**No.** El código de la extensión es **idéntico** entre `v0.1.2` y `v0.1.5`: el único cambio en
`frontend/` es el número de versión del manifest. Los tres arreglos —el período de gracia, la
sesión fantasma decidida por el latido, y pedir el bot al arrancar/reanudar— viven todos en el
**backend** (`backend/src/ws/handlers.js` y `backend/src/services/vexaService.js`). El paquete
que instala el docente no los contiene: los recibe por el solo hecho de hablar con
`api.sparkleedu.me`, que ya los tiene desplegados (workflow de Deploy en verde el 6/9 03:35,
salud 200 verificada).

**Decidido: no republicar la 0.1.5 en la Store cuando aprueben la 0.1.2.** Otra revisión de
Google no compra nada funcional. Solo vale la pena si en algún momento se quiere que el número
de la ficha coincida con el del repo para la documentación de la tesis.

**Lo que sí conviene tener presente:** esa asimetría es una ventaja del diseño y da para
decirla en la defensa —los arreglos de comportamiento del bot se despliegan sin pasar por la
revisión de Google— pero tiene la contracara obvia: la extensión no vale nada sin el backend
arriba. Cualquier versión, la 0.1.2 y la 0.1.5 por igual, depende de que el EC2 esté vivo.

### ⚠️ La Store RECHAZÓ la v0.1.2: "Blue Argon", código remoto — 7/9/2026

El mail de Google, contra el ítem `ldklcfnbfhljgbgjhiemblcbmchlpcip`:

```
Violation reference ID: Blue Argon
Technical Requirements - Additional Requirements for Manifest V3:
  Violation: Including remotely hosted code in a Manifest V3 item.
  Violating Content:
    Code snippet: content.js: https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js
```

Es exactamente la URL que la entrada de H.2 había anticipado y descartado como riesgo. **La
predicción estuvo bien; el argumento preparado no servía.** Ahí quedó escrito que si Google lo
cuestionaba se le explicaría que es una cadena muerta —viene adentro de jsPDF, en la rama
`output('pdfobjectnewwindow')`, y el informe del docente se genera con `doc.save()`—. Manifest
V3 no admite esa distinción: la regla no es "no ejecutes código remoto", es que **la
funcionalidad completa tiene que ser discernible del código enviado**. El revisor mira el ZIP,
no el flujo. Código remoto muerto sigue siendo código remoto.

**Decidido: sacar el literal en el build, no apelar.** Apelar sería sostener que la política no
aplica cuando la rama no se ejecuta, que es justamente lo que la política dice que no importa;
y aun ganando la apelación tarda más que rebuildear. Se agregó a `vite.config.js` un plugin
`sinCodigoRemoto()` que borra ese string cuando pasa el módulo de jsPDF. Se eligió eso antes que
parchear `node_modules` o cambiar de librería: es un solo literal, en una rama que no se usa, y
un `patch-package` agrega mantenimiento permanente para el mismo resultado.

**Y se agregó una red que no existía.** `frontend/scripts/verificar-sin-codigo-remoto.js` corre
al final de `npm run build` —o sea también en el job que arma los ZIP del Release— y falla si
alguna URL que termine en `.js`, `.mjs` o `.wasm` sobrevive en `dist/`. Sin eso, la próxima
dependencia que traiga un CDN adentro se descubre con otro rechazo y otra semana de espera.

⚠️ El chequeo tuvo que aprender a distinguir. En crudo marcaba tres URLs más —el crédito al
autor del MD5 de jsPDF, la cabecera de referencias de su cifrado, y el enlace a la
documentación de Emscripten que aparece en el pegamento JS de los siete `.wasm`—. Las tres
están **dentro de comentarios**, se verificaron una por una y quedaron en una lista
`ATRIBUCIONES_CONOCIDAS` con su motivo. La lista es corta a propósito: cualquier URL nueva frena
el build y la mira una persona.

**Se resube como v0.1.6, no como 0.1.2 corregida.** La Store no acepta un paquete con una
versión que no sea mayor a la ya subida. Eso además deshace la asimetría de la entrada
anterior: la ficha vuelve a decir el mismo número que el repo. El tag también redespliega el
backend, que no cambió en nada — es el camino normal y no cuesta nada.

**Lo que esto vale para la defensa:** es un caso concreto de que la revisión de una tienda de
extensiones se hace sobre el artefacto y no sobre el comportamiento, y de que una dependencia
puede meter una violación de política en un código que uno nunca escribió ni llama.

**Verificado sobre el artefacto real**, no sobre el `dist/` local: se bajó
`extension-store-v0.1.6.zip` del Release y se comprobó adentro que dice `version 0.1.6`, que no
trae el campo `key` y que la URL de cdnjs no está en ningún archivo. El CI quedó en verde (164
tests de frontend) y el deploy también: imagen `v0.1.6` corriendo en el servidor, migraciones
sin nada que aplicar y el sitio respondiendo 200.

⚠️ **Quedan en el paquete tres URLs terminadas en `.js` que Google NO marcó**, todas dentro de
comentarios: el crédito al autor del MD5 de jsPDF, la cabecera de referencias de su cifrado, y
el enlace a la documentación de Emscripten. Se dejaron a propósito —borrar una atribución de
una cabecera de licencia es peor que el problema que resolvería— y el rechazo apuntó a la única
que sí era una carga (`pdfObjectScript.src = ...`). Si alguna vez volvieran a marcar por esto,
el remedio es el mismo plugin: sumar el literal y rebuildear.

### La cruz roja del CI después de la v0.1.6: intermitente, no una regresión — 7/9/2026

El commit de documentación que cierra la entrada anterior (*"Anotar la verificacion del paquete
v0.1.6 contra el Release"*, que **toca un solo archivo, este mismo `.md`**) salió **rojo** en el
CI. Nada del código cambió entre ese commit y el tag: el CI y el Deploy de **v0.1.6 pasaron en
verde media hora antes**, con exactamente el mismo `frontend/` y el mismo `backend/`.

Falló **un test de frontend**, *"El historial del alumno muestra 'Sin responder'…"*, en
`frontend/tests/App.botonDocenteYSinResponder.test.js`. El mensaje habla del contenido del DOM
—dice que no encontró *"No respondiste esta pregunta"*— pero el DOM que imprime muestra la
pregunta **todavía en vivo con 16 s en el reloj**: el `question_finished` que el test emite no
llegó a reflejarse en la pantalla dentro de los 15 s de espera (3 s × el factor 5 que
`reactHarness.js` aplica cuando `CI=true`). Es el mismo patrón de siempre, y **ya van cuatro**.

**Se relanzó el job y pasó en verde sin tocar una línea.** Queda como test intermitente
conocido; si vuelve a aparecer, el arreglo va por el lado de esperar el efecto real del evento
en vez del texto, como se hizo con `isDocumentReadyForMeeting`.

**No afecta a nada de lo que está afuera:** lo desplegado sigue siendo la imagen `v0.1.6`, y el
ZIP que está en revisión en la Chrome Web Store se construyó desde el tag, cuyo CI fue verde.
La Store revisa el ZIP subido, no el estado del repositorio.

### Los dos repositorios se renombraron en GitHub — 7/9/2026

`Sparkle_V2` pasó a llamarse **`Saprkle_V2_Codigo`** y `Sparkle_V2_Transcripcion` pasó a
**`Sparkle_V2_Vexa_Transcripcion`**. Se revisó qué se rompía con el cambio y **no se rompe
nada operativo**:

- La **imagen del backend** no depende del nombre del repo: el workflow la arma como
  `ghcr.io/${{ github.repository_owner }}/sparkle-backend` —solo el **dueño**—, así que el
  path de GHCR y el `image:` de `docker-compose.prod.yml` siguen igual y el servidor pulea lo
  mismo de siempre.
- La base se llama `sparkle_v2` y **no tiene nada que ver** con el nombre del repositorio.
- Los remotos locales se apuntaron a los nombres nuevos. GitHub redirige los viejos igual, así
  que un clon que no se haya actualizado sigue funcionando.

Se actualizaron las referencias que son **instrucciones a ejecutar**: la tabla de repos y los
`git clone` de `INTEGRACION.md` (clonando con el nombre de carpeta de siempre, para que el
resto del documento siga siendo válido), los `gh api .../rulesets` de `.github/PROTECCION.md`,
el repo donde viven los secretos (F.4) y el tag `Repositorio` de `infra/terraform/versions.tf`.
Ese tag hace que el próximo `terraform plan` muestre **una diferencia de etiquetas y nada más**.
Las menciones dentro de esta bitácora se dejan como estaban: cuentan lo que pasó cuando pasó.

⚠️ **El nombre nuevo del repo de código tiene un error de tipeo: `Saprkle`, no `Sparkle`.** Se
dejó tal cual porque es como está hoy en GitHub; si se renombra, hay que rehacer este mismo
reemplazo y apuntar el remoto otra vez.

### H.2 — CERRADO: la v0.1.6 quedó aprobada y publicada — 9/9/2026

Google aprobó la extensión dos días después de resubirla. La cronología completa del ítem
`ldklcfnbfhljgbgjhiemblcbmchlpcip`: subida el 5/9 como v0.1.2, rechazada el 7/9 por código
remoto ("Blue Argon"), resubida el mismo día como v0.1.6 con el literal de cdnjs sacado en el
build, y aprobada el 9/9.

**Verificado sin entrar al dashboard**, que es la parte que conviene anotar: la ficha pública
del ítem responde **200** y dice **0.1.6**. Un ítem *no listado* no aparece en las búsquedas de
la Store pero **sí tiene página pública**, alcanzable con el link directo — y ese link es
justamente el que hay que pasarle a quien tenga que instalarla:

```
https://chromewebstore.google.com/detail/ldklcfnbfhljgbgjhiemblcbmchlpcip
```

**Estado del sistema al momento de cerrar H.2**, chequeado antes de arrancar H.4:

| Qué | Resultado |
|---|---|
| `GET https://api.sparkleedu.me/` | 200, `{"status":"ok"}` |
| Imagen del backend | `ghcr.io/maxitrufel/sparkle-backend:v0.1.6` |
| Contenedores | los tres arriba, backend y base en `healthy` |
| `ALLOWED_EXTENSION_IDS` **en el proceso**, no en el archivo | los **dos** ids: el de la descomprimida y el de la Store |

Esa última fila es la que evita el error más caro de H.4: si el id de la Store no estuviera
cargado, la extensión recién instalada recibiría un rechazo de CORS que no dice en ningún lado
que el problema es una lista de ids. Se leyó con `docker exec ... printenv` y no del `.env`,
porque lo que importa es lo que el proceso tiene cargado, no lo que dice el archivo.

⚠️ **La notebook está otra vez en el estado que rompe las clases.** Load average **6 a 10 sobre
8 núcleos** con Vexa prácticamente en reposo, y el que se come la máquina es `ReportCrash` al
**92 %**, procesando **25 crashes de CleanMyMac X Menu** de hoy. Es exactamente la misma causa
anotada el 6/9, sin identificar la primera vez y ya identificada la segunda. Es lo que hace que
Chrome congele las pestañas, o sea el disparador de los bugs del bot que se arreglaron en
v0.1.3 y v0.1.4. **Cerrar CleanMyMac antes de la clase de H.4**, o el ensayo va a estar midiendo
el ruido de otra aplicación en vez del sistema.

**Whisper sigue en `tiny`**, que es lo correcto mientras Vexa comparta máquina con la clase.
Alcanza para lo que H.4 tiene que verificar —que la transcripción arranca y que el bot entra—
pero no para dar por probado "recuperar contenido" desde la transcripción, que sigue pendiente y
necesita `small` en una máquina dedicada, como ya dicen G.7 y G.8.

**Lo que NO se hace ahora que está aprobada:** republicar la 0.1.6 con cualquier arreglo de
backend que venga después. El paquete de la extensión no contiene la lógica del bot; esos
arreglos llegan por el solo hecho de hablar con `api.sparkleedu.me`. Una revisión de Google que
no cambia nada funcional solo agrega días de espera.

### Decidido: Vexa se queda en la notebook, y no se muda a otra máquina — 9/9/2026

G.8 y la corrección sobre `small` contra `tiny` cerraban las dos en la misma recomendación:
que Vexa no corriera en la misma máquina que da la clase. **Se decidió no hacerlo.** Vexa se
queda en la notebook y se acepta lo que eso implica.

**Lo que se acepta, dicho para que esté por escrito:** con Vexa compartiendo máquina con la
clase, el modelo viable es `tiny`, que detecta bien el idioma pero transcribe mal
(*"que yo está buenos a que estoy teoyado"* es una muestra real de la bitácora). En
consecuencia, la ruta "alerta → recuperar el tramo perdido **desde la transcripción**" —la que
describe la tesis— **queda sin ejercitar de punta a punta**. Lo que sí está probado es el
camino de respaldo: cuando no hay transcripción suficiente, el backend arma el resumen con el
documento del docente y el alumno recibe algo útil. Es una virtud del diseño y vale contarla
como tal, pero no debe presentarse como el circuito completo validado.

⚠️ **Y hay una condición previa que hoy no se cumple, medida el mismo día:** la notebook está
en **load average 11,3 sobre 8 núcleos con Vexa prácticamente en reposo**. El que se la come
sigue siendo `ReportCrash` —al 69 %— procesando los crashes en bucle de **CleanMyMac X Menu**:
6 reportes nuevos en la última hora. Es la tercera vez que aparece en esta bitácora (la primera
sin identificar, el 6/9 identificada, hoy medida otra vez).

**Un `pkill` no alcanza: el agente se vuelve a levantar solo.** Se verificó que
`com.macpaw.CleanMyMac4.HealthMonitor` y `com.macpaw.CleanMyMac4.Menu` reaparecen con un PID
nuevo a los pocos minutos. El arreglo durable es sacarlo de los ítems de inicio de sesión o
desinstalarlo.

**Por qué importa para la decisión:** mientras esa aplicación esté rompiéndose en bucle, la
notebook no tiene margen ni para `tiny`, y es además el disparador de que Chrome congele las
pestañas — o sea, de los dos bugs del bot que se arreglaron en v0.1.3 y v0.1.4. Recuperar esos
núcleos es lo más barato que queda por hacer, y es la única vía por la que `small` podría
llegar a entrar en esta máquina. Sin eso, la decisión de dejar Vexa acá se toma con menos
máquina de la que la máquina realmente tiene.

### El apex hoy da 404, no "no resuelve" — 9/9/2026

Estado medido: `sparkleedu.me` y `www` **sí resuelven**, a las cuatro IPs de GitHub Pages,
porque los registros quedaron apuntando al repo de la landing esperando que se libere el
dominio. Mientras tanto Pages no reconoce el dominio como suyo y contesta
**404 "Site not found"** por HTTP; por HTTPS directamente **no hay handshake**, porque el
certificado que presenta sigue siendo el genérico `*.github.io`.

Es un estado distinto del que dejó la entrada del 5/9 ("el apex ya no resuelve"), y es
peor de mirar: quien escriba el dominio recibe una página de error de GitHub en vez de nada.
No afecta al sistema —todo vive en `api.`, que sigue en 200 con su certificado de Caddy— pero
conviene saberlo si alguien de la cátedra entra al dominio antes de que se libere.

Se arregla solo cuando Isola saque el dominio de Settings → Pages de `franisola.github.io`:
ahí `maxiTrufel/sparkle-landing` puede reclamarlo y Pages emite el certificado.

### Correccion: la cuenta del publisher no es una cuenta compartida — 9/9/2026

La entrada de H.1 la describe como "cuenta compartida del equipo" y de ahi salio toda la
preocupacion por el 2FA: que las dos personas escanearan el mismo QR, que los codigos de
respaldo quedaran en Bitwarden, y la advertencia de que activar la verificacion en dos pasos
con un solo telefono dejaba a la otra persona afuera de la cuenta duena de la extension.

**Eso no aplica: la cuenta es de Trufelman.** El riesgo que se describia —depender de que otra
persona este disponible para tocar el item publicado— no existe, y no hay nada que pedirle a
nadie sobre el 2FA. Las entradas de H.1 y H.2 se dejan como estan porque cuentan lo que se
penso en su momento; esta las corrige.

Lo que sigue siendo cierto de aquella entrada es lo demas: que esa cuenta es la duena del item
publicado para siempre, y que conviene que su contrasena y los codigos de respaldo esten en
Bitwarden — por perdida del telefono, no por acceso compartido.

### El servidor se apaga entre sesiones para estirar el crédito — 10/9/2026

Los números reales de la cuenta, medidos con Cost Explorer sobre los primeros cinco días de
producción, no estimados:

| Concepto | USD/día | USD/mes |
|---|---|---|
| Instancia encendida (`t3.small`) | 0,81 | ~24 |
| Disco EBS 30 GB + snapshots | 0,18 | ~5 |
| IPv4 pública | 0,12 | ~4 |
| **Total con la instancia prendida** | **1,11** | **~33** |
| **Total con la instancia apagada** | **0,30** | **~9** |

Clavado en los ~USD 32/mes que estimaba §4. Consumido hasta hoy: USD 5,10, pagado entero por
los créditos.

**Créditos: USD 140 emitidos, quedan 134,90.** Son tres: USD 100 de free tier y dos de USD 20
por completar actividades ("configurar un presupuesto" y "lanzar una instancia EC2").

⚠️ **La cuenta figura como plan `PAID`, activo** — verificado con `aws freetier
get-account-plan-state`. No es el free tier de 6 meses que se corta solo: cuando los créditos
se agoten, AWS cobra la tarjeta y el servicio sigue andando sin avisar. Las alertas de
presupuesto de C.1 son lo único que avisa; el riesgo de §12 "créditos agotados antes de la
defensa" se mitiga con ellas y con esto.

**Decisión: la instancia se apaga cuando no se usa, y se prende para trabajar.** A 33/mes los
134,90 duran unos 4 meses, hasta principios de enero. A 9/mes duran más de un año. Cada día
encendida cuesta un dólar de crédito, y el uso real son sesiones de prueba de minutos.

Lo que se apaga es la instancia y con ella los tres contenedores y el cron de backups de las
06:00 UTC. Lo que **no** se toca: el disco de 30 GB queda intacto con la base y los uploads, la
IP elástica <ip-del-servidor> sigue reservada —o sea que **el DNS no hay que rehacerlo**, a
diferencia de un `terraform destroy`— y los backups ya subidos a S3 quedan donde están.

Mientras está apagada, `api.sparkleedu.me` no responde y la extensión publicada no sirve; un
deploy por tag falla porque Actions no puede entrar por SSH. No se ven afectados la landing de
GitHub Pages, Vexa en la notebook ni la ficha de la Store.

Al prenderla vuelve con la misma IP y los contenedores levantan solos: `restart:
unless-stopped` más `docker` habilitado en el arranque. Tarda 1 o 2 minutos.

```bash
# apagar
aws ec2 stop-instances  --instance-ids i-0e985001ee0552c17 --region sa-east-1
# prender
aws ec2 start-instances --instance-ids i-0e985001ee0552c17 --region sa-east-1
# en qué estado está  (solo deja de cobrar en "stopped")
aws ec2 describe-instances --instance-ids i-0e985001ee0552c17 --region sa-east-1 \
  --query 'Reservations[0].Instances[0].State.Name' --output text
# ¿volvió a andar?  401 es correcto: el backend está vivo y pide la clave
curl -s -o /dev/null -w '%{http_code}\n' https://api.sparkleedu.me/api/salud
```

**Apagada el 10/9/2026.** Verificado: estado `stopped`, la API da `000`, la IP elástica sigue
asociada a la instancia y el volumen de 30 GB sigue attachado. El último backup en S3 es el de
`2026-09-09T06-00-01Z`; a partir de acá no hay backup diario hasta que se vuelva a prender, que
es aceptable porque tampoco hay datos nuevos con el servicio caído.

**El ciclo completo quedó probado el mismo día, en las dos direcciones.** Al prenderla volvió
con la misma IP, los tres contenedores levantaron solos —backend y base en `healthy`— y la API
dio 401 a los ~2 minutos del `start`; el cron de backups seguía en su lugar. No hubo que tocar
el DNS ni recrear nada. Apagar y prender es rutina, no una maniobra.

⚠️ **H.4 sigue pendiente y necesita el backend arriba.** Hay que prender la instancia antes de
la clase corta que falta, y apagarla al terminar.

### ⚠️ La red de UADE bloquea `sparkleedu.me` entero — y cómo se presenta igual — 10/9/2026

Lo detectó Isola desde la red de la facultad: el DNS de UADE manda el apex, `www` y `api` al
*sinkhole* de Palo Alto, y **forzar la IP correcta no alcanza**, porque el firewall corta
también por el nombre que viaja en el saludo TLS (SNI). Lo comprobó comparando el apex con
`franisola.github.io`, que están en la misma IP de GitHub: uno anda y el otro no. La causa
probable es la categoría de *dominio recién registrado*, que Palo Alto levanta sola a los ~30
días del registro (el dominio es del 18/08, así que alrededor del 18/09).

**Consecuencia:** presentar desde la red de UADE antes de esa fecha no funciona. Ni la
extensión publicada ni la descomprimida llegan al backend, y la política de privacidad tampoco
carga.

**Decidido: el plan B es entrar a producción por Tailscale, no cambiar de backend.** Isola
propuso apuntar la extensión a su Docker por su IP de Tailscale desde Opciones. Se eligió otra
vía, que no toca la extensión:

```
<ip-tailnet-servidor>   api.sparkleedu.me        ← una línea en /etc/hosts de la máquina que presenta
```

Con eso Chrome resuelve el nombre de siempre a la IP de `sparkle-servidor` en la tailnet, sin
pasar por el DNS de UADE. El tráfico viaja adentro del túnel de WireGuard, así que el firewall
no ve el SNI. Y del lado del servidor no cambia nada: Caddy recibe el mismo nombre y presenta
el mismo certificado de Let's Encrypt, que valida.

**Verificado desde la notebook**, forzando la IP de la tailnet sin DNS
(`curl --resolve api.sparkleedu.me:443:<ip-tailnet-servidor>`): **401** en `/api/salud` con
`ssl_verify_result=0`, y el WebSocket también llega al backend (401, sin clave). La conexión es
directa (`via <ip-del-servidor>:41641`), 39 ms. Lo que no se puede simular desde casa es el
firewall de UADE; que Tailscale lo atraviesa lo probó Isola desde ahí.

**Por qué esta vía y no la del Docker de Isola:**

- **Es producción de verdad**: la misma base, la misma versión y **Vexa incluido**, que se
  alcanza por la misma tailnet. Contra un Docker local se demuestra otro sistema, con otros
  datos y probablemente sin transcripción.
- **No depende de nada horneado en el paquete.** La clave de API sigue fija en el build (ver
  la entrada del pendiente de la clave configurable), así que un backend alternativo tendría
  que tener cargada la `SPARKLE_API_KEY` de producción y el id de la Store en
  `ALLOWED_EXTENSION_IDS`, o la extensión publicada recibe 401 o un rechazo de CORS.
- **Se deshace borrando una línea.** No hay que acordarse de volver Opciones a la URL buena.

⚠️ **Tres condiciones para que ande el día que haga falta:**

1. **La máquina que presenta tiene que estar en la tailnet de Máximo.** La notebook ya lo
   está. Si el alumno de la demo usa otra máquina (la de Isola, que está en su propia
   tailnet), hay que compartirle el nodo `sparkle-servidor` desde la consola de Tailscale
   (Machines → Share), o esa máquina no llega.
2. **Después de editar `/etc/hosts`, reiniciar Chrome** (o vaciar la caché en
   `chrome://net-internals/#dns`): si ya había resuelto el nombre al sinkhole, lo recuerda.
3. **Sacar la línea al volver a casa.** Con la línea puesta y Tailscale apagado, la API no
   responde en ningún lado, y el síntoma parece un servidor caído.

La vía de Isola queda como respaldo para un solo caso: que el EC2 mismo no esté disponible.

**Lo que se hace además, en este orden:**

1. **Asignarle `sparkleedu.me` a la landing** (`maxiTrufel/sparkle-landing`). Isola ya lo
   liberó: sacó el archivo `CNAME` de su repo (commit `cca631b`, 6/9), que era lo que lo
   reservaba —no solo la opción de Settings—, y se verificó que ningún sitio de Pages lo
   reclama. El 404 del apex es exactamente eso. Los registros A y el CNAME de `www` ya apuntan
   al lugar correcto desde el 9/9, así que no hay nada que tocar en Cloudflare.
2. **Recién después, pedir la recategorización a Palo Alto** (formulario gratuito de *Test A
   Site*). El orden importa: quien revise el pedido va a entrar al dominio, y con el apex en
   404 de GitHub y `api` devolviendo 401 (o nada, con el servidor apagado) no hay nada que
   categorizar. Con la landing arriba ve un proyecto educativo.

⚠️ **Un efecto de asignar el dominio que conviene tener presente:** GitHub redirige
`maxitrufel.github.io/sparkle-landing/` al dominio propio, y esa es la URL de la política de
privacidad declarada en la ficha de la Store. Afuera de UADE el enlace sigue funcionando por la
redirección. Adentro de UADE, hasta que se levante el bloqueo, **la política de privacidad deja
de cargar**. Se acepta: es transitorio, y el resto del sistema en esa red ya no andaba igual.

### El CI en rojo por cuota: era el tiempo que se guardaba el paquete — 29/9/2026

Desde el 28/9 el job "Build de la extensión" fallaba en el último paso, al subir `dist/`, con
*Artifact storage quota has been hit*. Todo lo demás pasaba (tests, build, controles). GitHub no
mide cuánto hay guardado en un momento dado: suma **GB-hora a lo largo del mes**. El plan gratis
da 0,5 GB × las horas del mes (~360 GB-h en septiembre), y el uso llegó a **372 GB-h**. Cada
corrida guardaba ~25 MB (77 MB sin comprimir: los 6 modelos pesan) durante 7 días, o sea ~4 GB-h,
y en septiembre hubo 69 corridas. Las imágenes del backend en GHCR (16 versiones) **no** cuentan:
no aparecen en el uso facturado.

**Decidido:** el `dist/` del CI se guarda 1 día en vez de 7 (~0,6 GB-h por corrida). El paquete de
cada versión publicada no cambia: sigue adjunto a su GitHub Release, que no vence. La cuota se
reinicia el 1/10, así que hasta entonces el CI puede seguir en rojo por lo mismo. GitHub Student
fue aprobado el 29/9, pero la cuenta todavía figura en el plan Free; cuando pase a Pro, la cuota
se duplica.

### Cobertura de tests ≥ 85 % exigida por el CI — 10/10/2026

La entrega del 75 % pide cobertura de al menos 85 %. **Decidido:** c8 (cobertura nativa de V8)
como dependencia de desarrollo en los dos paquetes, con el umbral del 85 % de líneas y sentencias
en `.c8rc.json` y en el CI (`npm run test:coverage` reemplaza a `npm test` en los jobs de backend
y frontend; si la cobertura baja, el job falla). Solo se agregaron tests y configuración: no se
tocó `backend/src` ni `frontend/src`, así que no hay versión nueva ni pasa por la Store.

Resultado: backend 198 tests y 93,46 %; frontend 293 tests y 92,50 % (antes 166 + 216). Detalle,
exclusiones justificadas y capturas en `docs/cobertura/README.md`.

Trampas encontradas, para no repetirlas:

- **La medición común del frontend mentía.** Los tests de pantallas empaquetan `App.jsx` con
  esbuild; sin source map, esas líneas no se atribuyen a `src/` y el reporte nativo de Node daba
  82 % midiendo casi solo la lógica. El número real, con las pantallas, era 72,5 %.
- **c8 daba 100 % falso en todas las pantallas.** `v8-to-istanbul` compara contra el filtro
  `include` la ruta de cada fuente del source map en formato `file:///…` y la descarta; los tramos
  no ejecutados nunca se aplican. Se arregló con un patrón `file:/**/frontend/src/**` en el
  `include`, sin tocar `node_modules`. Además, al medir, el harness conserva los bundles hasta el
  reporte (c8 los relee) y el script los borra al final.
- **El test intermitente `questions.test.js:198`** era una carrera del test, no de la app: el
  servidor manda la pregunta al alumno antes de calcular las estadísticas iniciales del docente, y
  el test borraba los mensajes del docente en el medio. Se arregló esperando esas estadísticas
  (ahí y en otros tres casos iguales del mismo archivo).

### 1/11/2026 — Meet cambió la dirección de las reuniones y empezó a rechazar al bot

Dos problemas nuevos aparecidos sin tocar nada de nuestro lado, encontrados al volver a probar.

**El panel no aparecía.** Meet abre algunas reuniones en `/meet/abc-defg-hij` en vez de
`/abc-defg-hij`, y el contenido de la extensión solo reconocía la segunda forma, así que creía
estar fuera de una llamada y no montaba nada. Arreglado en `utils/meetContext.js` (commit 07fd595,
con test propio). **La 0.1.15 publicada en la Store sigue con el problema:** hace falta la 0.1.16.

**El bot no entraba.** Meet responde 403 al pedido de entrar y muestra "You can't join this video
call" (en la consola, `EndCause = 72`). Lo mismo reporta el proyecto Vexa en su producción (28 de
121 bots en un día). **Decidido: pasar `vexa-lite` de `v012` a `v0.12.29`**, que reintenta hasta 3
veces. Verificado en reunión real: primer intento rechazado, segundo a la sala de espera, admitido
y transcribiendo en español. No elimina el riesgo: si Google rechaza los 3, el bot no entra.

Trampas encontradas, para no repetirlas:

- **Prender todo incluye Tailscale en la notebook.** Con el EC2 y Vexa arriba pero Tailscale caído,
  el backend no llega a Vexa. Comando: `tailscale up --accept-routes --hostname=sparkle-vexa`.
- **Vexa informaba mal el rechazo.** La versión vieja marcaba `awaiting_admission` a un bot ya
  rechazado, y por eso parecía estar esperando permiso. Se vio mirando su pantalla:
  `ffmpeg -f x11grab -i :99` dentro del contenedor; el log está en `/tmp/vexa-workloads/`.
- **La versión nueva no arranca con `INTERNAL_API_SECRET` de ejemplo.** Se generó un valor real,
  que vive solo en el contenedor (lo comparten únicamente los servicios internos de Vexa).
- **`make up` deshace este cambio:** el `.env` de Vexa sigue con `IMAGE_TAG=v012`, el secreto de
  ejemplo y sin el modelo multilingüe. Prender siempre con `docker start` de los 4 contenedores.
- **Grabaciones:** desde la 0.12.28 Vexa recomienda versitygw, pero se dejó MinIO, que sigue en su
  propio contenedor, para no mover datos antes de la defensa.
- **Respaldo:** contenedor detenido `vexa-lite-v012-respaldo` e imagen `v012-respaldo-1nov`.

### 22/11/2026 — Preparación del código para la entrega final

**Decidido: quitar el atajo Ctrl+Q y sus paneles internos** (registros y ajustes de calibración del
alumno y del docente). Eran herramientas del equipo y no forman parte del producto que se entrega.
Detalle en la Etapa 91 de `DOCUMENTACION.md`. Se probó en Meet antes de confirmar.

**Pruebas en zona horaria UTC.** Siete tests de horarios del backend fallan si la computadora está en
hora de Argentina y pasan en UTC, que es la zona del CI y del servidor (verificado en el contenedor).
No es un error de la app: se documentó en el `README.md` cómo correrlos.

**Bot de Vexa.** Google Meet sigue rechazando al bot sin cuenta de forma intermitente. Apareció otra
forma del mismo rechazo: después de un 403, Meet muestra una página sin el campo del nombre y el bot
se rinde a los dos minutos, sin que el pedido llegue al docente. El reenvío automático
(`deploy/lite/bin/sparkle-reenvio-bot.py`, en el repositorio de Vexa) ahora también reintenta en ese
caso. Verificado en una reunión real: Google rechazó tres bots seguidos y el cuarto llegó a la sala de
espera, a unos cinco minutos del pedido. **Para la defensa:** arrancar la clase unos minutos antes,
para que el bot ya esté adentro.

**Extensión para la defensa.** La 0.1.15 de la Store no reconoce las reuniones con `/meet/` y todavía
trae el Ctrl+Q. Hasta publicar una versión nueva, usar la compilada desde `main` y cargada como
extensión descomprimida.

### 22/11/2026 — El código de entrenamiento entra al repositorio

**Decidido: sumar el código con el que se entrenó y validó el modelo**, en `entrenamiento/`, para
que la entrega incluya todo lo que describe la sección 3.7 de la tesis. Lo armó Fran a partir de su
repositorio de trabajo, sin datos: se revisó archivo por archivo antes de sumarlo. Detalle en la
Etapa 92 de `DOCUMENTACION.md`.

**Decidido: sacar del repositorio `frontend/tests/fixtures/reglas_referencia.json`.** Estaba desde
agosto y tenía medidas de la cabeza y los ojos de 400 ventanas de DAiSEE, que la licencia no deja
compartir. Los tests que lo usan se omiten si no está. Como el repositorio público se había creado
ese mismo día con el archivo adentro, se rehízo con un solo commit limpio.

**Protocolos y prerregistros de cada medición: no se incluyen.** Tienen datos por persona de
EngageNet. Si el jurado los pide, se preparan versiones depuradas para la defensa.

---

## 10. Estimación

| Fase | Tiempo | Dependencias |
|---|---|---|
| A — Preparar el repo | 3,5 h | ninguna · **empezá hoy** |
| B — Migraciones | 1,5 h | A |
| C — Terraform | 3 h | cuenta AWS · **primer gasto** |
| D — CI | 2 h | A.2 (los modelos) |
| E — CD | 2,5 h | B, C, D |
| F — Vexa / Tailscale | 45 min | C · 🔀 con D y E |
| G — Deploy + E2E | 3,5 h | 🔒 todas · **los dos presentes** |
| H — Chrome Web Store | 1 h + revisión | G |
| I — Backups | 1,5 h | G |
| J — Runbook | 1 h | C, I |

**~20 h de trabajo activo**, repartibles en 4-5 sesiones. Las fases A, B y D son 100% locales
y gratis: **~7 h que podés hacer hoy sin gastar un peso**. El reloj de AWS arranca en C.

Sumale la espera de revisión de la Chrome Web Store, que puede tardar días y no depende de ustedes.

**Camino crítico si querés algo online rápido:** A.2 → A.3 → A.4 → C → E (versión mínima) → G.
Son ~7 h y te deja `https://api.sparkleedu.me` funcionando. Pero **no te saltees B** si vas a
tener datos de clases reales: es mucho más barato ahora que después.

---

## 11. Lo que NO vamos a hacer, y por qué

Está acá para que no te lo vendan más adelante, y para tener la respuesta lista si el
tribunal pregunta:

- **ECS / Fargate / EKS.** 4× el costo, reescribir el compose, cero beneficio a esta escala.
- **RDS.** ~USD 20/mes por lo que hace un contenedor de 400 MB de RAM.
- **Application Load Balancer.** ~USD 25/mes antes del primer byte. Caddy ya hace TLS y
  reverse proxy, gratis.
- **CloudFront / S3 para el frontend.** No hay frontend web que servir: es una extensión.
- **Route 53.** El DNS de Namecheap alcanza.
- **Uploads en S3.** Requiere tocar `uploadStorage.js`; el volumen + `tar` diario cubre el
  mismo riesgo sin cambiar código.
- **Vexa en AWS.** ~USD 40-50/mes en São Paulo por un Whisper CPU + Chrome headless que usás
  unas horas por semana. Tu notebook lo hace gratis y con Tailscale es igual de accesible.
  *Si algún día hace falta:* un EC2 `c7i.large` **spot** creado desde AMI a demanda, ~USD
  0,04/h, destruido al terminar.

---

## 12. Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| El CI buildea sin los modelos y nadie lo nota | **Alta** si A.2 no se hace | Commitear los modelos + el check de D.3 |
| La clave de Tailscale expira sola a los 180 días | **Alta** si no se desactiva | F.3 |
| Vexa caído durante la clase de prueba | Media (la notebook es la notebook) | Es modo degradado conocido (§8), no una caída. Ensayar G.7 con Vexa prendido el día anterior |
| Rate limit de Let's Encrypt | Media | G.2: no levantar Caddy antes de que el DNS propague |
| Créditos de AWS agotados antes de la defensa | Media | Budget con alertas (C.1) + las tres palancas de §4 |
| Alguien se baja una transcripción con `curl` | Media si hay clases reales | §7, opción B o C |
| Una migración se rompe a mitad | Baja | Una migración = un cambio. Backup antes de cada deploy que traiga migraciones |
| El EC2 muere la semana de la defensa | Baja, catastrófica | Fase J, **ensayada** (J.2) |
| ~~Se pierde el `.pem` de la extensión~~ | — | **Descartado el 5/9/2026.** El ID de la descomprimida sale del campo `key` del manifest, que está en git; el `.pem` no interviene. Ver la bitácora |

---

## 13. Verificaciones rápidas

```bash
# ¿El build tiene localhost horneado?  (debe dar 0)
grep -c "localhost:3000" frontend/dist/background.js

# ¿Están los 6 modelos en el build?
ls frontend/dist/models/

# ¿El DNS ya apunta al servidor?
dig +short api.sparkleedu.me

# ¿Caddy sacó el certificado?
docker compose logs caddy | grep -i "certificate obtained"

# ¿Qué está bindeando a 0.0.0.0 en el servidor?
ss -tulpn | grep '0.0.0.0'

# ¿El backend llega a Vexa por Tailscale?  (desde el EC2)
curl -s http://sparkle-vexa:8056/ -H "X-API-Key: $VEXA_BOT_API_KEY"

# ¿Vexa está cerrado desde afuera de la tailnet?  (desde otra red — debe fallar)
curl -m 5 http://<ip-publica-de-tu-casa>:8056/

# ¿lite transcribe, y en español?
make -C deploy/lite stt-smoke

# ¿Qué versión está desplegada?
ssh deploy@api.sparkleedu.me 'docker compose -f /opt/sparkle/docker-compose.yml images backend'
```
