import { useRef, useState } from 'react';
import { UploadIcon, NotesIcon, CheckIcon, AlertTriangleIcon, CloseIcon, ClockIcon, InfoIcon, ChevronRightIcon } from './icons';
import { ACCEPT_ATTR, formatFileSize } from '../hooks/useDocumentUpload';

// Etiqueta + ícono del estado de análisis (ver
// `backend/src/services/documentAnalysisService.js` para la máquina de
// estados completa) — 'uploaded' y 'processing' se muestran igual acá (el
// docente no necesita distinguir "todavía no arrancó" de "está en
// vuelo", ambos son "esperá"), solo 'processed'/'failed' tienen su propio
// tratamiento visual. Las etiquetas hablan de "extraer texto" (no
// "analizar con IA") porque hoy el proveedor activo solo hace eso — ver
// `backend/src/providers/index.js`.
function analysisStatusMeta(analysisStatus) {
  if (analysisStatus === 'processed') {
    return { label: 'Texto extraído', icon: <CheckIcon size={16} />, tone: 'success' };
  }
  if (analysisStatus === 'failed') {
    return { label: 'Error al procesar', icon: <AlertTriangleIcon size={16} />, tone: 'error' };
  }
  return { label: 'Extrayendo texto…', icon: <ClockIcon size={16} />, tone: 'pending' };
}

// A partir de cuántos conceptos la sección arranca COLAPSADA por default
// (sigue pudiéndose abrir igual, esto solo cambia el estado inicial) — el
// prompt de resumen pide como máximo unos pocos temas (`mainTopics`, ver
// `backend/src/providers/openAIDocumentAnalysisProvider.js`), así que unos
// pocos `keyConcepts` más entran cómodos sin scroll; de ahí para arriba
// conviene arrancar cerrado.
const COLLAPSE_CONCEPTS_THRESHOLD = 5;

// Resumen del documento (paso 2, OPCIONAL del pipeline — ver
// `backend/src/services/documentAnalysisService.js`) — solo se muestra
// cuando `analysisStatus === 'processed'` (ver el `default export`, más
// abajo). Cubre a propósito los tres estados posibles de `analysis`,
// además del caso feliz:
//   1. `mainTopics` NI SIQUIERA está en el objeto — el resumen con IA
//      nunca corrió (flag apagado) o corrió y FALLÓ (ver el `catch`
//      dedicado en `documentAnalysisService.analyzeDocument`, que sigue
//      guardando `extractedText` igual). No es un error de la app — el
//      documento se cargó bien, es la parte de la IA la que no está.
//   2. `mainTopics` es un array VACÍO — el resumen sí corrió, pero no
//      encontró temas puntuales (documento muy corto/sin contenido
//      temático). Mensaje explícito, nunca una lista vacía sin contexto.
//   3. `mainTopics` tiene contenido — el caso esperado.
// El texto extraído CRUDO ya NO se muestra acá — sigue extrayéndose y
// guardándose igual en `analysis_result` (MySQL, ver
// `services/documentAnalysisService.js`), simplemente dejó de exponerse
// en esta UI (antes vivía detrás de un "Ver texto extraído" colapsado).
function DocumentSummarySection({ fileName, analysis }) {
  const { pageCount, mainTopics, keyConcepts } = analysis;
  const hasSummary = Array.isArray(mainTopics);
  const hasTopics = hasSummary && mainTopics.length > 0;
  const hasConcepts = Array.isArray(keyConcepts) && keyConcepts.length > 0;

  return (
    <div className="sparkle-doc-summary">
      <div className="sparkle-doc-summary-header">
        <span className="sparkle-doc-summary-filename">{fileName}</span>
        <span className="sparkle-doc-summary-pages">{pageCount} {pageCount === 1 ? 'página' : 'páginas'}</span>
      </div>

      {!hasSummary && (
        <p className="sparkle-text">
          <InfoIcon size={14} /> El documento se cargó bien, pero todavía no hay temas disponibles
          para este material.
        </p>
      )}

      {hasSummary && !hasTopics && (
        <p className="sparkle-text">
          <InfoIcon size={14} /> No se identificaron temas puntuales en este documento.
        </p>
      )}

      {hasTopics && (
        <ol className="sparkle-doc-summary-topics">
          {mainTopics.map((topic, index) => (
            <li key={index}>{topic}</li>
          ))}
        </ol>
      )}

      {hasConcepts && (
        <details className="sparkle-doc-collapsible" open={keyConcepts.length <= COLLAPSE_CONCEPTS_THRESHOLD}>
          <summary className="sparkle-doc-collapsible-summary">
            <ChevronRightIcon size={14} className="sparkle-doc-collapsible-chevron" />
            Conceptos clave ({keyConcepts.length})
          </summary>
          <dl className="sparkle-doc-summary-concepts">
            {keyConcepts.map((concept, index) => (
              <div className="sparkle-doc-summary-concept" key={index}>
                <dt>{concept.term}</dt>
                <dd>{concept.definition}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

// Bloque COMPACTO, embebido directo en `TeacherPanel.jsx` (pantalla previa
// a "Comenzar Clase") — reemplaza al viejo botón "Cargar Archivo" sin
// acción y a la pantalla propia `screens/UploadDocument.jsx` (eliminada):
// nunca navega ni reemplaza el resto del panel, el docente sigue viendo
// "Comenzar Clase" (deshabilitado hasta que haya un documento) al mismo
// tiempo. Puramente presentacional — todo el estado/lógica vive en
// `hooks/useDocumentUpload.js` (pasado acá como props), así que nada de
// esto se duplica entre el bloque y `TeacherPanel.jsx` (que también
// necesita `hasValidDocument` para el botón).
export default function DocumentUploadBlock({
  currentDocument,
  loadingCurrent,
  loadError,
  selectedFile,
  validationError,
  status,
  uploadError,
  onSelectFile,
  onCancelSelection,
  onConfirmUpload,
}) {
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  function openFilePicker() {
    if (status === 'uploading') return;
    fileInputRef.current?.click();
  }

  function handleInputChange(e) {
    onSelectFile(e.target.files?.[0] || null);
    // Limpia el input nativo: sin esto, elegir el MISMO archivo dos veces
    // seguidas (ej. después de "Cancelar") no dispara `onChange`.
    e.target.value = '';
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    onSelectFile(e.dataTransfer.files?.[0] || null);
  }

  function handleDragOver(e) {
    e.preventDefault();
    setIsDragging(true);
  }

  const showDropzone = !selectedFile && !currentDocument;
  const showCurrentDocument = !selectedFile && currentDocument;
  const showPendingFile = Boolean(selectedFile);
  const disableUpload = !selectedFile || Boolean(validationError) || status === 'uploading';

  return (
    <div className="sparkle-doc-upload">
      <p className="sparkle-section-label">Material de la clase</p>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        onChange={handleInputChange}
        className="sparkle-file-input-hidden"
      />

      {loadingCurrent && <p className="sparkle-text">Consultando material cargado…</p>}

      {!loadingCurrent && loadError && (
        <p className="sparkle-text sparkle-text-error">
          <AlertTriangleIcon size={14} /> {loadError}
        </p>
      )}

      {!loadingCurrent && !loadError && showDropzone && (
        <div
          className={`sparkle-dropzone sparkle-dropzone--compact ${isDragging ? 'sparkle-dropzone--dragging' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={openFilePicker}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openFilePicker();
          }}
        >
          <UploadIcon size={18} className="sparkle-dropzone-icon" />
          <span className="sparkle-dropzone-text">Arrastrá el archivo acá o hacé click para seleccionarlo</span>
          <span className="sparkle-dropzone-hint">PDF, hasta 10 MB</span>
        </div>
      )}

      {!loadingCurrent && !loadError && showCurrentDocument && (
        <>
          <div className={`sparkle-file-row ${currentDocument.analysisStatus === 'failed' ? 'sparkle-file-row--error' : ''}`}>
            <span className="sparkle-file-row-icon">
              <NotesIcon size={20} />
            </span>
            <div className="sparkle-file-row-info">
              <span className="sparkle-file-row-name">{currentDocument.fileName}</span>
              <span className="sparkle-file-row-meta">
                {formatFileSize(currentDocument.sizeBytes)} · {analysisStatusMeta(currentDocument.analysisStatus).label}
              </span>
            </div>
            <span className={`sparkle-file-row-status--${analysisStatusMeta(currentDocument.analysisStatus).tone}`}>
              {analysisStatusMeta(currentDocument.analysisStatus).icon}
            </span>
          </div>

          {currentDocument.analysisStatus === 'failed' && currentDocument.analysisError && (
            <p className="sparkle-text sparkle-text-error">
              <AlertTriangleIcon size={14} /> {currentDocument.analysisError}
            </p>
          )}

          {currentDocument.analysisStatus === 'processed' && currentDocument.analysis && (
            <DocumentSummarySection fileName={currentDocument.fileName} analysis={currentDocument.analysis} />
          )}

          <button
            type="button"
            className="sparkle-button sparkle-button-secondary sparkle-button-compact"
            onClick={openFilePicker}
          >
            Reemplazar documento
          </button>
        </>
      )}

      {showPendingFile && (
        <>
          <div className={`sparkle-file-row ${validationError ? 'sparkle-file-row--error' : ''}`}>
            <span className="sparkle-file-row-icon">
              <NotesIcon size={20} />
            </span>
            <div className="sparkle-file-row-info">
              <span className="sparkle-file-row-name">{selectedFile.name}</span>
              <span className="sparkle-file-row-meta">
                {formatFileSize(selectedFile.size)}
                {status === 'uploading' && ' · Cargando…'}
              </span>
            </div>
            <button
              type="button"
              className="sparkle-file-row-remove"
              onClick={onCancelSelection}
              disabled={status === 'uploading'}
              aria-label="Cancelar selección"
            >
              <CloseIcon size={14} />
            </button>
          </div>

          {validationError && (
            <p className="sparkle-text sparkle-text-error">
              <AlertTriangleIcon size={14} /> {validationError}
            </p>
          )}
          {status === 'error' && uploadError && (
            <p className="sparkle-text sparkle-text-error">
              <AlertTriangleIcon size={14} /> {uploadError}
            </p>
          )}

          <div className="sparkle-doc-upload-actions">
            <button
              type="button"
              className="sparkle-button sparkle-button-primary sparkle-button-compact"
              onClick={onConfirmUpload}
              disabled={disableUpload}
            >
              {status === 'uploading' ? 'Cargando…' : currentDocument ? 'Confirmar reemplazo' : 'Cargar documento'}
            </button>
            <button
              type="button"
              className="sparkle-button sparkle-button-tertiary sparkle-button-compact"
              onClick={onCancelSelection}
              disabled={status === 'uploading'}
            >
              Cancelar
            </button>
          </div>
        </>
      )}
    </div>
  );
}
