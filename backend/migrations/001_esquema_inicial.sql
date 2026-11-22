-- 001 — Esquema inicial de Sparkle V2.
--
-- Es el DDL que hasta el paso B.1 del plan de despliegue vivía dentro de
-- `scripts/init-db.js`, movido acá SIN cambios de esquema: mismas columnas,
-- mismos tipos, mismos índices, mismas collations. Se trajeron también los
-- comentarios de POR QUÉ cada columna es como es, que son la parte que más
-- vale de todo esto — el objetivo era que el DDL quedara en UN solo lugar,
-- y dejar los comentarios en un archivo y las tablas en otro habría sido
-- cambiar una duplicación por otra.
--
-- `init-db.js` ahora dropea las tablas y corre este mismo archivo, así que
-- los dos caminos —reset de desarrollo y migración de producción— no se
-- pueden desincronizar.
--
-- Tres cosas que no son obvias y rompen si se tocan:
--
--  1. `DEFAULT CHARSET=utf8mb4` sin `COLLATE` NO hereda la collation de la
--     base: usa la default del charset, que en MariaDB es
--     `utf8mb4_general_ci`. Por eso `meetings.meeting_code` quedó en
--     `general_ci`, y por eso las tres tablas que le tienen FOREIGN KEY
--     declaran `COLLATE=utf8mb4_general_ci` explícito. Sin eso MariaDB
--     rechaza la FK con errno 150 aunque el tipo de columna sea idéntico.
--
--  2. El orden de creación es padre → hijo. No se puede reordenar sin
--     romper las FK.
--
--  3. Tres de estos `CREATE TABLE` venían con `IF NOT EXISTS`, que en
--     `init-db.js` tenía sentido (ese script se corre una y otra vez). Acá
--     se sacó a propósito: el runner ya lleva registro de qué se aplicó, así
--     que una tabla que ya existe es señal de que algo se salió del carril y
--     tiene que fallar ruidosamente, no pasar en silencio.

-- ─── users ─────────────────────────────────────────────────────────────
-- Se crea en orden padre → hijo.
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── meetings ──────────────────────────────────────────────────────────
-- "active" (Etapa 44): estado persistente de la clase para ese
-- meeting_code — false por defecto (recién creada, nadie apretó
-- "Comenzar Clase" todavía), pasa a true cuando el docente inicia la
-- clase (ver backend/src/ws). Vive en la base, no en memoria del
-- servidor WS, para sobrevivir un reinicio del backend: un alumno que
-- se conecta después de un reinicio sigue viendo el estado correcto.
--
-- "last_ended_type"/"last_ended_at" (Etapa 50): solo
-- tienen sentido cuando `active = FALSE` — de qué manera terminó la
-- clase más reciente, y cuándo. Distinguen una finalización MANUAL
-- (botón "Finalizar Clase") de una AUTOMÁTICA (el docente se desconectó
-- — colgó, F5, cerró la pestaña, navegó fuera). Esta distinción es lo
-- que decide si el docente ve el prompt de "¿Reanudar la clase
-- anterior?" al reconectarse: solo tiene sentido ofrecerlo si el corte
-- fue accidental, nunca si el docente la terminó a propósito. Se
-- resetean a NULL cada vez que la clase vuelve a estar activa (iniciar
-- o reanudar) — dejan de ser información válida una vez que hay una
-- clase en curso de nuevo.
--
-- "attention_mode_id" — modo de clase elegido por el docente en la
-- pantalla pre-clase (Por Defecto/Teórica/Práctica/Seminario/Repaso, ver
-- `src/constants/attentionModes.js` — ESA es la fuente de los 9 valores
-- numéricos reales que implica cada modo, acá solo se guarda el id).
-- `TINYINT UNSIGNED`, no una FK a una tabla de modos aparte: los 5 modos
-- son un enum fijo definido en código, no datos que el producto necesite
-- crear/editar desde la base. Default 1 ("Por Defecto") — así una
-- reunión que nunca pasó por `set_attention_mode` ya tiene un modo
-- válido desde que se crea, sin depender de que el docente toque el
-- selector.
CREATE TABLE meetings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_code VARCHAR(64) NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  last_ended_type ENUM('manual', 'automatic') NULL,
  last_ended_at DATETIME NULL,
  attention_mode_id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  attention_window_started_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── participations ────────────────────────────────────────────────────
-- El rol vive acá, por combinación de reunión + usuario (Etapa 17) — no
-- más en "users". El índice único sobre (meeting_id, user_id)
-- es lo que garantiza "un solo rol por persona por reunión" a nivel de
-- base de datos, no solo a nivel de lógica de la ruta.
--
-- "camera_enabled" (Etapa 63): preferencia del toggle de la prueba
-- de preview de cámara (`CameraPreview.jsx`), específica por persona +
-- reunión, igual que el rol — no global por cuenta. Es una herramienta
-- de PRUEBA pensada para eliminarse antes de las funcionalidades reales
-- de IA (ver DOCUMENTACION.md); si se saca esa funcionalidad, esta
-- columna también se puede dropear.
--
-- "name"/"normalized_name" (Etapa 68): el nombre que un alumno
-- ingresa antes de que se le asigne el rol "student" en esta reunión (ver
-- `routes/meetings.js`, `/register-student`) — NULL para las filas de
-- "teacher", que nunca piden nombre. `name` guarda el valor tal cual
-- lo tipeó (trimeado y con espacios internos colapsados a uno solo, pero
-- sin tocar mayúsculas/minúsculas — así se ve en el listado del
-- docente); `normalized_name` es la versión en minúsculas de eso
-- mismo, usada SOLO para comparar unicidad ("Juan" y "juan " deben
-- contar como el mismo nombre dentro de la misma reunión). El único
-- índice `uq_participations_meeting_name` es la garantía a nivel de
-- base de que dos alumnos de la MISMA reunión no puedan compartir
-- nombre — MySQL no cuenta los NULL como iguales entre sí en un índice
-- único, así que las filas de "teacher" (normalized_name NULL) no
-- chocan entre ellas ni con ninguna fila de alumno.
CREATE TABLE participations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT NOT NULL,
  user_id INT NOT NULL,
  role ENUM('teacher', 'student') NOT NULL,
  name VARCHAR(100) NULL,
  normalized_name VARCHAR(100) NULL,
  camera_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_participations_meeting_user (meeting_id, user_id),
  UNIQUE KEY uq_participations_meeting_name (meeting_id, normalized_name),
  CONSTRAINT fk_participations_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_participations_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── connection_sessions ───────────────────────────────────────────────
-- Historial de sesiones de conexión (Etapa 68, Cambio 3): un registro
-- por cada tramo continuo en que un alumno estuvo conectado a la sala WS
-- de una reunión MIENTRAS la clase estaba activa (`meetings.active =
-- TRUE`) — no cualquier conexión a la sala (ver `backend/src/ws/index.js`
-- para el criterio exacto de cuándo se abre/cierra cada fila).
-- `disconnected_at` queda NULL mientras la sesión sigue en curso; se
-- completa apenas se detecta el cierre (desconexión del alumno, o fin de
-- la clase con el alumno todavía conectado). No tiene una FK a
-- `participations` a propósito: identifica al alumno por (meeting_id,
-- user_id), la misma combinación que ya es única en `participations`
-- — evita depender de que esa fila específica no se haya tocado, y sigue
-- siendo trivial de unir con un JOIN cuando hace falta el nombre (ver el
-- endpoint `/history`).
CREATE TABLE connection_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT NOT NULL,
  user_id INT NOT NULL,
  connected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disconnected_at DATETIME NULL,
  CONSTRAINT fk_connection_sessions_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_connection_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── questions ─────────────────────────────────────────────────────────
-- Preguntas en tiempo real estilo Kahoot — una fila por pregunta
-- enviada por el docente a una reunión puntual. Las 4 opciones viven
-- en columnas fijas (no una tabla aparte `question_options`): el
-- enunciado siempre tiene EXACTAMENTE 4 opciones (regla de negocio del
-- producto, ver `services/questionService.js`), así que una tabla
-- relacional de más solo agregaría JOINs sin ganar flexibilidad real.
--
-- "correct_option" nunca se expone al alumno mientras `status='active'`
-- (ver `ws/handlers.js`, `toPublicQuestion`) — vive en la base para que
-- el backend pueda calcular `is_correct` de cada respuesta sin confiar
-- en el cliente.
--
-- "active_meeting_id" es una columna GENERADA (STORED): vale
-- `meeting_id` mientras `status='active'`, o NULL en cualquier otro
-- caso. El índice único sobre esa columna es la garantía, a nivel de
-- base de datos, de que una reunión nunca tenga DOS preguntas activas
-- a la vez — cubre tanto un doble click en "Enviar pregunta" como una
-- carrera genuina entre dos inserciones casi simultáneas (MySQL no
-- cuenta los NULL como iguales entre sí en un índice único, así que
-- cualquier cantidad de preguntas YA finalizadas —con
-- `active_meeting_id` en NULL— nunca chocan entre ellas, mismo criterio
-- ya usado en `uq_participations_meeting_name` más arriba).
CREATE TABLE questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT NOT NULL,
  prompt TEXT NOT NULL,
  option_a VARCHAR(500) NOT NULL,
  option_b VARCHAR(500) NOT NULL,
  option_c VARCHAR(500) NOT NULL,
  option_d VARCHAR(500) NOT NULL,
  correct_option ENUM('a', 'b', 'c', 'd') NOT NULL,
  duration_seconds INT NOT NULL,
  status ENUM('active', 'finished') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  active_meeting_id INT AS (IF(status = 'active', meeting_id, NULL)) STORED,
  UNIQUE KEY uq_questions_one_active_per_meeting (active_meeting_id),
  CONSTRAINT fk_questions_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── question_answers ──────────────────────────────────────────────────
-- Una fila por respuesta (o "no responder") de un alumno a una
-- pregunta puntual. El índice único sobre (question_id, user_id) es la
-- garantía de base contra respuestas duplicadas — mismo criterio que
-- "active_meeting_id" arriba: cubre doble click, doble pestaña del
-- mismo alumno, y reconexiones, sin depender de que la capa de
-- aplicación llegue a filtrarlo a tiempo.
--
-- "selected_option"/"is_correct" quedan NULL cuando `skipped=TRUE`
-- (el alumno eligió "Prefiero no responder", no seleccionó ninguna
-- opción) — nunca ambos casos a la vez.
CREATE TABLE question_answers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  question_id INT NOT NULL,
  user_id INT NOT NULL,
  selected_option ENUM('a', 'b', 'c', 'd') NULL,
  is_correct BOOLEAN NULL,
  skipped BOOLEAN NOT NULL DEFAULT FALSE,
  response_time_ms INT NOT NULL,
  answered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_question_answers_question_user (question_id, user_id),
  CONSTRAINT fk_question_answers_question
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  CONSTRAINT fk_question_answers_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── files ─────────────────────────────────────────────────────────────
-- Carga de documentos (PDF/DOCX) desde el panel del docente — COMO
-- MUCHO una fila por reunión (`uq_files_meeting`, más abajo): volver a
-- cargar un documento REEMPLAZA la metadata de la fila existente (ver
-- `repositories/documentRepository.upsertDocument`), no acumula
-- historial. Es lo que permite, además, la regla de "no se puede
-- comenzar la clase sin material cargado" (`ws/handlers.js`,
-- `handleStartClass`): "¿existe fila para este meeting_id?" alcanza
-- como chequeo, sin ambigüedad de "cuál de varias".
-- El archivo en sí NUNCA vive en la base: se guarda en una carpeta
-- privada del backend (`backend/uploads/documents/`, no servida por
-- Express — ver `utils/uploadStorage.js`) con un nombre generado
-- (`stored_name`, UUID + extensión) para evitar colisiones y problemas
-- de path traversal; acá solo se registra su metadata. `original_name`
-- es el nombre tal cual lo subió el docente (el que se muestra en el
-- panel); `stored_name` es el nombre real en disco.
-- "uploaded_by" identifica al docente autenticado que lo subió — la
-- autorización para SUBIR (¿es el docente de esta reunión?) ya se
-- validó una sola vez, en el momento de la carga (ver
-- `services/documentService.saveTeacherDocument`).
-- Análisis con IA del documento (OpenAI, Responses API — ver
-- `providers/openAIDocumentAnalysisProvider.js`) — columnas agregadas
-- sobre la MISMA fila de `files` (no una tabla aparte): el análisis es
-- 1:1 con el documento vigente de la reunión, y reemplazar el
-- documento (`upsertDocument`) ya vuelve a dejar estas columnas en su
-- estado inicial — no tiene sentido arrastrar el resultado de un
-- análisis de un archivo que ya no existe.
-- "analysis_status" es la máquina de estados completa: arranca en
-- 'uploaded' (recién cargado, análisis todavía no disparado),
-- 'processing' mientras la llamada a OpenAI está en vuelo, y termina en
-- 'processed' o 'failed' — nunca vuelve atrás. La transición
-- 'uploaded' → 'processing' es la que garantiza "se analiza una sola
-- vez": solo se dispara con un UPDATE atómico condicionado a
-- `analysis_status = 'uploaded'` (ver
-- `repositories/documentAnalysisRepository.js`), así que una carrera
-- (ej. el backend se reinicia y reintenta) nunca dispara el análisis
-- dos veces para el mismo documento.
-- "analysis_result" guarda el resultado completo del pipeline de
-- documentos (ver `services/documentAnalysisService.js`) — SIEMPRE
-- `extractedText`/`pageCount`/`charCount` (paso 1, extracción de
-- texto), más `mainTopics`/`keyConcepts` cuando el resumen con IA
-- está activo (paso 2, opcional) — tal cual lo arma cada proveedor,
-- sin columnas separadas por campo: es contenido para MOSTRAR, no
-- para filtrar/ordenar por SQL, así que una columna JSON nativa
-- alcanza. Ojo con el tipo real: MariaDB no tiene un tipo `JSON`
-- nativo — `JSON` acá es un alias que crea la columna como
-- `LONGTEXT` con un `CHECK (json_valid(...))` (confirmado con `SHOW
-- CREATE TABLE`), o sea ~4 GB de límite práctico, NO los 64 KB de un
-- `TEXT` — un PDF de varias decenas de páginas no la trunca.
-- "analysis_error" si es un `TEXT` normal (64 KB) — un mensaje de
-- error nunca se acerca a ese tamaño, a diferencia de
-- `analysis_result`.
CREATE TABLE files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT NOT NULL,
  uploaded_by INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(150) NOT NULL,
  size_bytes INT NOT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  analysis_status ENUM('uploaded', 'processing', 'processed', 'failed') NOT NULL DEFAULT 'uploaded',
  analysis_error TEXT NULL,
  analysis_result JSON NULL,
  analysis_started_at DATETIME NULL,
  analysis_finished_at DATETIME NULL,
  UNIQUE KEY uq_files_meeting (meeting_id),
  CONSTRAINT fk_files_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_files_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── transcription_sessions ────────────────────────────────────────────
-- Vexa (transcripción de Google Meet) — ver
-- backend/src/services/vexaService.js. Una fila por bot pedido para una
-- reunión (arranca en "requested"/"active" al llamar a Vexa, pasa a
-- "stopped" al finalizar la clase o "failed" si la llamada a Vexa
-- falla).
--
-- COLLATE utf8mb4_general_ci a nivel de tabla: tiene que calzar con la
-- collation REAL de `meetings.meeting_code` (que en esta base terminó
-- en utf8mb4_general_ci, no utf8mb4_unicode_ci) — si no, MariaDB
-- rechaza el FOREIGN KEY de más abajo con errno 150 aunque el tipo de
-- columna sea idéntico.
CREATE TABLE transcription_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_code VARCHAR(50) NOT NULL,
  vexa_meeting_id INT,
  status ENUM('requested','active','stopped','failed') DEFAULT 'requested',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  stopped_at DATETIME,
  FOREIGN KEY (meeting_code) REFERENCES meetings(meeting_code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ─── transcript_segments ───────────────────────────────────────────────
-- Un segmento de transcripción por fila, tal como los devuelve Vexa —
-- "segment_id" es la clave de Vexa para ese segmento puntual, usada para
-- hacer upsert y no duplicar filas en cada poll (ver
-- `vexaService.saveSegments`).
--
-- Índice compuesto (meeting_code, absolute_start_time) — sostiene
-- `transcriptRepository.getRecentSegments` (`WHERE meeting_code = ?
-- ORDER BY absolute_start_time DESC LIMIT ?`, usado por la generación
-- de preguntas con IA): sin él, MySQL resuelve el filtro por el índice
-- implícito de la FK (`meeting_code` solo) y hace un filesort aparte
-- para el ORDER BY — con este índice, ambas partes de la consulta las
-- resuelve el mismo índice, sin ordenar nada aparte. A propósito NO se
-- cachea esta lectura en memoria (ver esa misma función): la
-- transcripción cambia todo el tiempo mientras la clase sigue en vivo,
-- y esta query ya indexada es más barata que mantener un caché
-- coherente con eso.
CREATE TABLE transcript_segments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_code VARCHAR(50) NOT NULL,
  speaker VARCHAR(255),
  text TEXT NOT NULL,
  language VARCHAR(10),
  absolute_start_time DATETIME(3),
  absolute_end_time DATETIME(3),
  segment_id VARCHAR(100) UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (meeting_code) REFERENCES meetings(meeting_code) ON DELETE CASCADE,
  INDEX idx_transcript_segments_meeting_time (meeting_code, absolute_start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ─── attention_snapshots ───────────────────────────────────────────────
-- Historial de "fotos" periódicas del estado grupal de atención — una
-- fila cada 10 segundos por reunión con alumnos monitoreados (ver
-- `backend/src/ws/attentionState.js`, el intervalo que las genera).
-- A diferencia de `attentionStateByMeeting` (el `Map` en memoria de ese
-- mismo archivo, que solo guarda el ÚLTIMO valor de cada alumno y se
-- pierde al reiniciar el backend), esto SÍ persiste — es la base
-- histórica que consume `ConcentrationStats.jsx` (línea temporal + mapa
-- de calor + "momento de mayor desatención") además de lo que llega en
-- vivo por WebSocket.
--
-- `pct_attentive`/`pct_no_face` en PORCENTAJE (0-100), mismo formato
-- que `concentration` en el resto del sistema — nunca fracción 0-1.
-- `group_inattentive` usa el MISMO criterio que `hooks/useGroupAttentionAlert.js`
-- del lado del frontend (`pctAttentive < pThreshold * 100` — P es la
-- fracción ATENTA mínima, auditoría de 2026-08-11 contra la Tabla 2 de
-- la tesis —, el P vigente del modo de clase de esta reunión — ver
-- `attentionState.js` para el detalle de cómo se resuelve P del lado
-- del servidor).
--
-- Mismo criterio de collation que `transcript_segments`/
-- `transcription_sessions` de arriba — tiene que calzar con
-- `meetings.meeting_code` para que el FOREIGN KEY no falle con errno 150.
CREATE TABLE attention_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  meeting_code VARCHAR(50) NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  pct_attentive DECIMAL(5,2) NOT NULL,
  pct_no_face DECIMAL(5,2) NOT NULL,
  total_students SMALLINT UNSIGNED NOT NULL,
  group_inattentive BOOLEAN NOT NULL,
  FOREIGN KEY (meeting_code) REFERENCES meetings(meeting_code) ON DELETE CASCADE,
  INDEX idx_attention_snapshots_meeting_time (meeting_code, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
