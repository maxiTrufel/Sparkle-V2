import { ChevronRightIcon } from './icons';
import { ATTENTION_MODES } from '../constants/attentionModes';

// Selector de modo de clase — pantalla pre-clase del docente
// (`screens/TeacherPanel.jsx`, arriba de `DocumentUploadBlock`). Elige uno
// de los 5 presets fijos de X/Y/K/Q/C (alumno) + P/V_doc/Q_doc/C_doc
// (docente) — los NOMBRES/DESCRIPCIONES/ÍCONOS viven acá (`constants/
// attentionModes.js` del lado del frontend), los NÚMEROS reales de cada
// modo viven únicamente en el backend y llegan recién por WebSocket una vez
// elegido (ver `hooks/useAttentionModeSync.js`) — este componente nunca los
// conoce.
//
// Segundo rediseño (pedido explícito — el primero, con tarjetas grandes, no
// convenció): vuelve a ser un `<select>`, pero estilizado a mano (flecha
// nativa oculta vía `appearance: none`, ícono propio superpuesto — ver
// `.sparkle-mode-select*` en `styles/panel.css`) en vez del control gris
// crudo del browser. Puramente controlado, igual que las dos versiones
// anteriores: `modeId` es el id vigente, `onChange` manda el pedido — el
// valor mostrado se corrige solo si el backend termina aplicando otra cosa
// (no hay estado optimista propio acá).
//
// `chosen` (el modo sigue siendo OBLIGATORIO, sin cambios de fondo desde
// el rediseño anterior): distingue "ya llegó un default automático" (el
// catch-up del backend aplica "Por Defecto" apenas el socket se une, aunque
// el docente nunca haya tocado nada) de "el docente eligió una opción de
// verdad". Mientras sea `false`, el `<select>` muestra el placeholder
// "Seleccioná el modo de clase..." (con `value=""`, la primera `<option>`,
// deshabilitada — nunca una opción válida en sí) en vez de saltar
// directamente a "Por Defecto" ya marcado — sería confuso al lado de un
// botón "Comenzar Clase" que sigue deshabilitado por esto mismo (ver
// `TeacherPanel.jsx`, que es quien decide este valor).
export function AttentionModeSelector({ modeId, chosen, onChange }) {
  const currentMode = chosen ? ATTENTION_MODES.find((mode) => mode.id === modeId) : null;

  return (
    <div className="sparkle-mode-selector">
      {/* Pedido explícito — mismo estilo EXACTO que el label "Material de
          la clase" (`ui/DocumentUploadBlock.jsx`): la clase compartida
          `sparkle-section-label` (mayúsculas, 12px, 500, letter-spacing,
          color secundario), no una clase propia con su propio look. */}
      <label className="sparkle-section-label" htmlFor="sparkle-mode-select">
        Modo de clase
      </label>
      <div className="sparkle-mode-select-wrap">
        <select
          id="sparkle-mode-select"
          className={`sparkle-mode-select ${!chosen ? 'sparkle-mode-select--placeholder' : ''}`}
          value={chosen ? String(modeId) : ''}
          onChange={(e) => {
            // La opción placeholder (`value=""`) está `disabled` — el
            // browser ya no debería dejarla elegir una vez que hay una
            // opción real seleccionada, pero igual se guarda acá: nunca
            // mandar un `onChange` con un id vacío/inválido.
            if (!e.target.value) return;
            onChange(Number(e.target.value));
          }}
        >
          <option value="" disabled>
            Seleccioná el modo de clase...
          </option>
          {ATTENTION_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {`${mode.icon} ${mode.name}`}
            </option>
          ))}
        </select>
        <ChevronRightIcon size={14} className="sparkle-mode-select-chevron" />
      </div>
      {currentMode && <p className="sparkle-mode-select-desc">{currentMode.description}</p>}
    </div>
  );
}
