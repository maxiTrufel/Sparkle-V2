import { useEffect, useRef } from 'react';
import { sendAttentionSnapshot, sendAttentionStopped } from '../services/backendMessaging';

// Envía al backend un snapshot periódico de la concentración de ESTE
// alumno mientras la cámara/detección está activa — el docente lo ve en
// vivo en `screens/ConcentrationStats.jsx`, vía `hooks/useLiveAttention.js`.
//
// Privacidad — esto invierte A PROPÓSITO la garantía "nunca sale del
// dispositivo" que tenía la detección de atención hasta ahora (ver el
// comentario de `hooks/useAttentionDetection.js`): es un pedido de producto
// explícito (el docente necesita una vista en vivo real, no un mock).
//
// Corrección — pedido explícito posterior: el listado del docente ahora
// muestra el NOMBRE REAL del alumno (`name`, el mismo que ya eligió al
// registrarse con `StudentName.jsx` — resuelto en `App.jsx` vía
// `useInitialRoleResolution`), no un rótulo anónimo. Esto reemplaza la
// mitigación anterior ("nunca `name`, solo un `anonId`") — se mantiene
// igual `anonId` (UUID generado ACÁ, del lado del cliente, una sola vez por
// sesión de este hook, nunca persistido) como clave estable interna del
// roster (evita reordenar/duplicar filas si el nombre llegara a cambiar a
// mitad de sesión), pero ya no cumple una función de anonimato: el nombre
// viaja en el mismo payload.
export function useAttentionBroadcast({
  meetingCode, email, name, cameraActive, attention,
}) {
  const anonIdRef = useRef(null);
  if (anonIdRef.current === null) anonIdRef.current = crypto.randomUUID();

  const lastSentRef = useRef(null);
  // `true` desde el primer snapshot mandado en esta sesión de cámara activa
  // — evita mandar "attention_stopped" si la cámara nunca llegó a mandar
  // ningún snapshot real (ej. se apagó durante el calentamiento de 10s).
  const monitoringActiveRef = useRef(false);

  // Corrección — pedido explícito posterior: antes esto solo mandaba
  // snapshot con `phase === 'active'`, así que una ventana `no_face`
  // (`useAttentionDetection.js`) nunca cruzaba al backend — el docente no
  // se enteraba de que el alumno dejó de tener rostro detectado, ni
  // siquiera vía el log de debug del roster (`TeacherDebugLog.jsx`). Ahora
  // se manda en AMBAS fases, con un `type` explícito para que el backend
  // (`handleAttentionSnapshot`) y el roster del docente sepan distinguir
  // una predicción real de una ventana descartada — mismo criterio que ya
  // usa `AttentionDebugLog.jsx` del lado del alumno para sus propias filas.
  useEffect(() => {
    const isBroadcastablePhase = attention.phase === 'active' || attention.phase === 'no_face';
    if (!cameraActive || !isBroadcastablePhase || attention.lastUpdated == null) return;
    // El contrato de más abajo dice que `inattentive` NUNCA viaja en `null` de
    // acá en adelante, y el panel del docente lo asume. Hay un único caso en que
    // este hook puede tener `null`: el modelo se abstuvo ANTES de que las reglas
    // llegaran a evaluarse (faltan 50 s de historia geométrica), de modo que
    // ninguna de las dos capas tiene una afirmación que hacer. Eso no es "atento"
    // ni "desatento": es no tener nada que informar, y se resuelve NO enviando.
    // El docente conserva el último estado conocido, que es el comportamiento
    // correcto mientras el sistema todavía no puede opinar.
    if (attention.inattentive == null) return;
    if (attention.lastUpdated === lastSentRef.current) return;
    lastSentRef.current = attention.lastUpdated;
    monitoringActiveRef.current = true;

    const isNoFace = attention.phase === 'no_face';

    sendAttentionSnapshot(meetingCode, email, {
      anonId: anonIdRef.current,
      name,
      // `kind`, NO `type` — este objeto viaja tal cual, sin envolver, hasta
      // `wsClient.js#sendStudentCommand`, que arma el mensaje real de WS como
      // `{ type: 'attention_snapshot', meetingCode, ...snapshot }`. Si este
      // campo se llamara `type` (como se llamaba `tipo` en español antes del
      // renombrado a inglés, sin colisión), el spread de `...snapshot` PISA
      // el `type: 'attention_snapshot'` del sobre con `'prediction'`/
      // `'no_face'` — el backend nunca ve `type === 'attention_snapshot'`
      // y descarta el mensaje en silencio (ningún branch de `ws/index.js`
      // matchea). Bug real, encontrado después de que el renombrado a
      // inglés le puso el mismo nombre a dos campos que antes eran
      // distintos por casualidad (`tipo` acá vs. `type` del comando WS).
      kind: isNoFace ? 'no_face' : 'prediction',
      // `concentration` en `null` — el modelo nunca calculó esa medición
      // para una ventana `no_face` (no corrió la cabeza de decisión, ver
      // `offscreen/detector.js#predecir`), mismo significado que el "N/A"
      // que ya muestra `AttentionDebugLog.jsx` para esa métrica puntual.
      //
      // `inattentive` SÍ viaja tal cual (sin caso especial acá): regla global
      // "sin rostro = desatento" — `useAttentionDetection.js` ya lo deja en
      // `true` para `no_face`, así que este campo nunca es `null` de
      // acá en adelante en toda la cadena (backend → docente).
      concentration: isNoFace ? null : attention.concentration,
      inattentive: attention.inattentive,
      noFaceFraction: attention.noFaceFraction ?? null,
      ts: attention.lastUpdated,
    }).catch((err) => {
      console.log(`[Sparkle] Error enviando snapshot de atención: ${err.message}`);
    });
  }, [cameraActive, attention.phase, attention.lastUpdated, meetingCode, email, name]);

  // Avisa "salió del monitoreo" apenas se apaga la cámara (switch, pausa de
  // clase, salida de la llamada — cualquier motivo que ponga `cameraActive`
  // en `false`) — así el docente lo ve desaparecer del roster en vez de
  // quedar con un valor último "congelado" para siempre.
  useEffect(() => {
    if (cameraActive || !monitoringActiveRef.current) return;
    monitoringActiveRef.current = false;
    sendAttentionStopped(meetingCode, email, anonIdRef.current).catch((err) => {
      console.log(`[Sparkle] Error avisando fin de monitoreo de atención: ${err.message}`);
    });
  }, [cameraActive, meetingCode, email]);
}
