import { ClockIcon } from '../ui/icons';

// Se muestra mientras `callStage.js` detecta el lobby ("Ready to join?" /
// "Listo para unirte") — no hay que pedir rol ni mostrar ningún panel
// todavía, porque el usuario ni siquiera se unió a la reunión (Etapa 24).
export default function LobbyScreen() {
  return (
    <div className="sparkle-screen">
      <div className="sparkle-waiting-card">
        <span className="sparkle-waiting-icon">
          <ClockIcon size={20} />
          <span className="sparkle-pulse-dot" />
        </span>
        <p className="sparkle-text">Esperando para ingresar a la reunión...</p>
      </div>
    </div>
  );
}
