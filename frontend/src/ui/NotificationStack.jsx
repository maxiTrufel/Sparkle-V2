// Contenedor genérico de notificaciones flotantes — agrupa TODAS las
// notificaciones de esquina superior izquierda (`NewQuestionToast`,
// `FatigueAlert`, `GroupAttentionAlert`, `ClassResumeNotice`) en un único
// `position: fixed` con `display: flex; flex-direction: column` (ver
// `.sparkle-notification-stack` en `styles/panel.css`).
//
// Reemplaza el viejo mecanismo de `ResizeObserver` + offset manual que
// empujaba `FatigueAlert` a mano cuando coincidía con `NewQuestionToast`
// (la única combinación que antes podía superponerse): con las cuatro
// notificaciones como hijas de ESTE flex, el apilado vertical sin overlap
// es automático para cualquier combinación que llegue a coincidir, no solo
// esa. Cada notificación conserva su propio ciclo de vida (timers de
// auto-hide, cooldown, animación de entrada/salida) — este componente es
// puramente de layout, no sabe nada de eso.
//
// Cada hija sigue decidiendo sola cuándo mostrarse (clase `--visible`
// propia); el CSS de cada una pasa de `position: absolute` (oculta, no
// reserva espacio en el flex) a `position: static` (visible, ocupa su
// lugar en la pila) al aplicar esa clase — ver `styles/panel.css`.
export function NotificationStack({ children }) {
  return <div className="sparkle-notification-stack">{children}</div>;
}
