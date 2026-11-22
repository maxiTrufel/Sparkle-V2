import { useEffect, useRef, useState } from 'react';
import { uploadDocument, getCurrentDocument } from '../services/backendMessaging';

// Solo PDF, hasta 10 MB — mismo criterio que valida el backend
// (`backend/src/utils/uploadStorage.js`, la validación AUTORITATIVA: esto
// es solo para dar feedback inmediato sin esperar el viaje de ida y
// vuelta al servidor, nunca la única barrera).
export const ALLOWED_EXTENSIONS = ['.pdf'];
export const ALLOWED_MIME_TYPES = ['application/pdf'];
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const ACCEPT_ATTR = 'application/pdf';

// Estados NO terminales del análisis (ver
// `backend/src/services/documentAnalysisService.js`) — mientras el
// documento esté en uno de estos dos, sigue vigente el polling de abajo.
const ANALYSIS_PENDING_STATUSES = ['uploaded', 'processing'];
// Cada cuánto se vuelve a consultar el estado del análisis mientras sigue
// en curso — hoy es solo extracción de texto local (rápida, ver
// `backend/src/providers/pdfTextExtractionProvider.js`), pero el resumen
// con IA (más lento, varios segundos) puede volver a activarse en cualquier
// momento con un flag (ver `backend/src/providers/index.js`) sin tocar este
// archivo, así que se mantiene un polling no agresivo por las dudas.
const ANALYSIS_POLL_MS = 3000;

// `chrome.runtime.sendMessage` (el canal hacia el service worker, ver
// `services/backendMessaging.js`) serializa el mensaje con JSON — un
// `ArrayBuffer` no sobrevive eso (`JSON.stringify` lo deja en `{}`, ver el
// comentario de `services/api.js`). `FileReader.readAsDataURL` lee el
// `File` como un data URL (string base64, JSON-safe) de forma NATIVA — a
// diferencia de armar el base64 a mano con
// `String.fromCharCode(...new Uint8Array(buffer))`, que revienta el stack
// con archivos de varios MB (el spread crea un argumento por byte).
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Algunos navegadores/sistemas operativos no reconocen el tipo real de un
// archivo y lo mandan como `''`/`application/octet-stream` — se acepta
// igual si la EXTENSIÓN es correcta (mismo criterio que `fileFilter` en
// `uploadStorage.js`, del lado del backend), para no rechazar un PDF válido
// por un mimetype mal reportado por el cliente.
function validateFile(file) {
  const ext = `.${(file.name.split('.').pop() || '').toLowerCase()}`;
  const extOk = ALLOWED_EXTENSIONS.includes(ext);
  const mimeOk = !file.type || file.type === 'application/octet-stream' || ALLOWED_MIME_TYPES.includes(file.type);
  if (!extOk || !mimeOk) return 'Solo se permiten archivos PDF.';
  if (file.size > MAX_FILE_SIZE_BYTES) return 'El archivo supera el tamaño máximo permitido (10 MB).';
  return null;
}

// Estado + acciones del material de la clase (PDF) del panel del
// docente — un solo hook, reusado por `ui/DocumentUploadBlock.jsx` (el
// bloque compacto embebido en `TeacherPanel.jsx`) y por el propio
// `TeacherPanel.jsx` (necesita saber `hasValidDocument` para deshabilitar
// "Comenzar Clase" — requisito de producto: no se puede arrancar la clase
// sin material cargado, validado también del lado del servidor en
// `backend/src/ws/handlers.js`, `handleStartClass`).
//
// Reemplaza al viejo `screens/UploadDocument.jsx` (pantalla propia,
// eliminada): la carga ahora vive INLINE en el panel principal, sin
// navegar a ningún lado — este hook es la lógica que antes vivía adentro
// de esa pantalla, movida acá para no duplicarla entre el bloque visual y
// el panel que necesita conocer `hasValidDocument`.
export function useDocumentUpload({ meetingCode, email }) {
  // Documento YA cargado y confirmado por el backend para esta reunión —
  // `null` mientras no se cargó ninguno. Se recupera del servidor al
  // montar (ver el efecto de abajo): ni el panel ni el service worker
  // retienen este dato entre aperturas/recargas, así que sin este fetch
  // "Comenzar Clase" quedaría deshabilitado a cada rato aunque el
  // documento siga existiendo en el backend.
  const [currentDocument, setCurrentDocument] = useState(null);
  const [loadingCurrent, setLoadingCurrent] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Archivo elegido/soltado, pendiente de confirmar la carga (o de
  // reemplazar el documento ya existente) — `null` en cualquier otro
  // momento, incluso con `currentDocument` ya cargado.
  const [selectedFile, setSelectedFile] = useState(null);
  const [validationError, setValidationError] = useState(null);
  // 'idle' | 'uploading' | 'error'
  const [status, setStatus] = useState('idle');
  const [uploadError, setUploadError] = useState(null);

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  function loadCurrentDocument() {
    if (!meetingCode || !email) {
      setLoadingCurrent(false);
      return;
    }
    setLoadingCurrent(true);
    setLoadError(null);
    getCurrentDocument(meetingCode, email)
      .then((result) => {
        if (!mountedRef.current) return;
        if (result?.error) throw new Error(result.error);
        setCurrentDocument(result?.document || null);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setLoadError(`No se pudo consultar el material cargado: ${err.message}`);
      })
      .finally(() => {
        if (!mountedRef.current) return;
        setLoadingCurrent(false);
      });
  }

  useEffect(() => {
    loadCurrentDocument();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingCode, email]);

  // Versión SILENCIOSA de `loadCurrentDocument`, para el polling de abajo
  // — a propósito no toca `loadingCurrent` (eso dispararía un parpadeo del
  // botón "Comenzar Clase" deshabilitándose de nuevo en cada tick) ni
  // `loadError` (un solo tick fallido de polling, ej. un blip de red, no
  // debería tapar el estado ya conocido — el próximo tick lo reintenta
  // solo).
  function pollCurrentDocument() {
    if (!meetingCode || !email) return;
    getCurrentDocument(meetingCode, email)
      .then((result) => {
        if (!mountedRef.current || result?.error) return;
        setCurrentDocument(result?.document || null);
      })
      .catch(() => {});
  }

  // Mientras el análisis con IA siga en curso ('uploaded' recién cargado,
  // sin arrancar todavía, o 'processing' en vuelo — ver
  // `backend/src/services/documentAnalysisService.js`), se vuelve a
  // consultar cada `ANALYSIS_POLL_MS` hasta que termine ('processed' o
  // 'failed', ambos ESTADOS TERMINALES — ver el `useEffect` cortando el
  // intervalo apenas deja de aplicar). Es lo que permite que "Comenzar
  // Clase" pase a habilitarse solo, sin que el docente tenga que recargar
  // el panel a mano para enterarse de que el análisis terminó.
  useEffect(() => {
    if (!currentDocument || !ANALYSIS_PENDING_STATUSES.includes(currentDocument.analysisStatus)) return undefined;
    const intervalId = setInterval(pollCurrentDocument, ANALYSIS_POLL_MS);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDocument?.id, currentDocument?.analysisStatus, meetingCode, email]);

  function selectFile(file) {
    if (!file || status === 'uploading') return;
    setSelectedFile(file);
    setValidationError(validateFile(file));
    setStatus('idle');
    setUploadError(null);
  }

  function cancelSelection() {
    if (status === 'uploading') return;
    setSelectedFile(null);
    setValidationError(null);
    setStatus('idle');
    setUploadError(null);
  }

  async function confirmUpload() {
    if (!selectedFile || validationError || status === 'uploading' || !meetingCode) return;
    setStatus('uploading');
    setUploadError(null);
    try {
      const dataUrl = await readFileAsDataUrl(selectedFile);
      const result = await uploadDocument(meetingCode, email, {
        name: selectedFile.name,
        type: selectedFile.type,
        size: selectedFile.size,
        dataUrl,
      });
      if (result?.status === 201) {
        setCurrentDocument(result.body.document);
        setSelectedFile(null);
        setValidationError(null);
        setStatus('idle');
      } else {
        setStatus('error');
        setUploadError(result?.body?.error || 'No se pudo cargar el documento.');
      }
    } catch (err) {
      setStatus('error');
      setUploadError(err.message);
    }
  }

  return {
    currentDocument,
    loadingCurrent,
    loadError,
    reloadCurrentDocument: loadCurrentDocument,
    selectedFile,
    validationError,
    status,
    uploadError,
    selectFile,
    cancelSelection,
    confirmUpload,
    // `true` solo cuando hay un documento confirmado por el backend Y SU
    // ANÁLISIS CON IA YA TERMINÓ OK — requisito de producto: no alcanza con
    // "hay un archivo cargado", tiene que estar analizado
    // (`analysisStatus === 'processed'`, ver `backend/src/services/
    // documentAnalysisService.js`). Mientras siga en 'uploaded'/'processing'
    // (o haya terminado en 'failed'), esto sigue en `false` — mismo
    // criterio, del lado del servidor, en `backend/src/ws/handlers.js#
    // handleStartClass`. Mientras `loadingCurrent` sigue sin resolverse,
    // tampoco se sabe todavía (ver `TeacherPanel.jsx`, que también
    // consulta `loadingCurrent` antes de decidir si deshabilitar "Comenzar
    // Clase").
    hasValidDocument: currentDocument?.analysisStatus === 'processed',
  };
}
