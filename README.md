# Sparkle V2

Detección de desatención y personalización del aprendizaje con inteligencia artificial en clases
sincrónicas de educación superior.

Proyecto Final de Ingeniería en Informática, UADE, 2026.
Isola, Francisco · Trufelman, Máximo Elian. Tutora: Cuadrado Estrebou, María Fernanda.

Sparkle V2 es una extensión de Google Chrome que funciona dentro de Google Meet. Estima la atención
del estudiante en su propia computadora, sin guardar ni enviar imágenes de la cámara. Con esa
información ayuda al estudiante a recuperar lo que se perdió, mediante resúmenes, preguntas y alertas,
y le da al docente indicadores agregados del curso y un reporte al final de la clase.

## Organización del código

| Carpeta o archivo | Contenido | Tesis |
|---|---|---|
| `frontend/` | Extensión de Chrome (React y Vite): panel en Meet, pantallas del docente y del estudiante, generación del reporte en PDF. | 3.4, 3.5 |
| `frontend/src/offscreen/` | Módulo de detección de atención: características del rostro, clasificador, reglas geométricas (`reglas.js`), puntaje de cara (`faceScore.js`) y veredicto. | 3.7 |
| `frontend/public/models/` | Modelo entrenado (ensamble de ocho regresiones logísticas, 776 parámetros) y su preprocesamiento. Ver su `README.md`. | 3.7 |
| `entrenamiento/` | Código con el que se entrenó el modelo sobre DAiSEE y se validaron las reglas geométricas con conjuntos públicos. Los datos no se incluyen, por licencia. Ver su `LEEME.md`. | 3.7 |
| `backend/` | Servidor (Node.js, Express y WebSocket) con base MariaDB: clases, preguntas, resúmenes, reporte, indicadores de atención e integración con OpenAI y con Vexa. | 3.5, 3.6, 3.8 |
| `backend/migrations/` | Esquema de la base de datos. | 3.8 |
| `infra/` | Infraestructura en AWS con Terraform, respaldos y guía de recuperación. | 3.6 |
| `docker-compose*.yml`, `Caddyfile` | Despliegue del servidor en contenedores, con HTTPS. | 3.6 |
| `.github/workflows/` | Integración continua (pruebas, cobertura y compilación) y despliegue continuo. | 5.1.3, 6.2 |
| `docs/cobertura/` | Medición de la cobertura de las pruebas automatizadas. | 6.2 |
| `DOCUMENTACION.md` | Documentación técnica completa y el historial de etapas del desarrollo. | 5.1.2 |
| `Plan_Despliegue.md` | Plan de despliegue y bitácora de decisiones (sección 9 bis). | 5.1.2 |
| `INTEGRACION.md` | Cómo levantar el sistema completo, con Sparkle y Vexa conectados. | 3.6 |
| `VERIFICAR_yaw_pitch.md` | Verificación de la orientación de la cabeza entre Python y JavaScript. | 3.7 |

## Pruebas automatizadas

Se necesita Node.js 22 y una base MariaDB 10.11 con el esquema creado (`npm run migrate`). Las
variables de la base son las del CI (`.github/workflows/ci.yml`).

```bash
cd backend && npm ci && npm run migrate && npm run test:coverage
cd frontend && npm ci && npm run test:coverage
```

Las pruebas se ejecutan en UTC, igual que el CI y el servidor. Algunas pruebas de horarios del
backend fallan si la computadora usa otra zona horaria; en ese caso, anteponer `TZ=UTC`.

Estado de esta entrega: **472 pruebas** (198 del backend y 274 de la extensión), con una cobertura
del **92,60 %** de líneas. Pasan 465 y se omiten 7: las que comparan las reglas geométricas con su
referencia en Python, porque su archivo de datos contiene medidas extraídas de DAiSEE y no se
distribuye (ver `entrenamiento/LEEME.md`, sección 4).

La tesis informa 491 pruebas y 92,84 % de cobertura (sección 6.2). Esos valores corresponden a la
versión v0.1.15, sobre la que se hizo la prueba con usuarios. Esta entrega agrega el reconocimiento
de las reuniones con dirección `/meet/` y quita las herramientas internas de calibración que solo
usaba el equipo durante el desarrollo, junto con sus pruebas. Ver `docs/cobertura/README.md` y las
Etapas 91 y 92 de `DOCUMENTACION.md`.

## Compilar la extensión

```bash
cd frontend
npm ci
VITE_BACKEND_URL=https://api.sparkleedu.me npm run build
```

La compilación deja la extensión en `frontend/dist/`, que se carga en `chrome://extensions` con
«Cargar descomprimida». El comando comprueba además los dos requisitos de la Chrome Web Store: que
no haya código remoto ni código ofuscado.

La clave de acceso al servidor (`VITE_SPARKLE_API_KEY`) no se incluye en el repositorio. Las
variables necesarias están documentadas en los archivos `.env.example`.

## Lo que no está en este repositorio

- **Vexa**, el servicio de transcripción. Es un proyecto de código abierto de otros autores, que se
  despliega aparte y se configura según `INTEGRACION.md`.
- **Los conjuntos de datos** con los que se entrenó y validó el modelo, ni las medidas extraídas de
  ellos. Sus licencias no permiten redistribuirlos; `entrenamiento/LEEME.md` indica dónde se pide
  cada uno.
- **Las claves y contraseñas**, que nunca se versionan.
