import { CheckIcon } from '../ui/icons';

// Se muestra mientras `callStage.js` detecta la pantalla posterior a
// salir ("You left the meeting" / "Dejaste la reunión") — sin contenido
// de Docente/Alumno ni pedido de rol, la reunión ya terminó para este
// usuario (Etapa 24).
export default function CallEndedScreen() {
  return (
    <div className="sparkle-screen">
      <div className="sparkle-waiting-card">
        <span className="sparkle-waiting-icon">
          <CheckIcon size={20} />
        </span>
        <p className="sparkle-text">Llamada finalizada</p>
      </div>
    </div>
  );
}
