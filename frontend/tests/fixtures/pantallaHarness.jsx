// Monta UNA pantalla o componente real de `src/` con las props que defina el
// test, para probarlo aislado (sin `App.jsx` entero). Mismo patrón que
// `fatigueAlertHarness.jsx`: se empaqueta con esbuild y se monta sobre jsdom.
//
// El test elige qué montar con `window.__pantalla` (nombre de la tabla de
// abajo) y las props iniciales con `window.__props`, ANTES de `mount()`.
// Después puede cambiar props con `window.__harness.setProps({...})`.
// `FinalQuiz` es controlado (su estado vive en el padre, como en
// `StudentPanel.jsx`), así que se monta con un padre que guarda ese estado.
import { useState } from 'react';
import FinalQuiz from '../../src/screens/FinalQuiz.jsx';
import ClassSummary from '../../src/screens/ClassSummary.jsx';
import RecoverySummary from '../../src/screens/RecoverySummary.jsx';
import GenerateQuestion from '../../src/screens/GenerateQuestion.jsx';
import ConcentrationStats from '../../src/screens/ConcentrationStats.jsx';
import LobbyScreen from '../../src/screens/LobbyScreen.jsx';

function FinalQuizControlado(props) {
  const [quizState, setQuizState] = useState(props.quizState ?? null);
  window.__quizState = quizState;
  return <FinalQuiz {...props} quizState={quizState} onQuizStateChange={setQuizState} />;
}

const PANTALLAS = {
  FinalQuiz: FinalQuizControlado,
  ClassSummary,
  RecoverySummary,
  GenerateQuestion,
  ConcentrationStats,
  LobbyScreen,
};

export default function PantallaHarness() {
  const [props, setProps] = useState(() => window.__props || {});
  const Pantalla = PANTALLAS[window.__pantalla];
  window.__harness = {
    setProps: (cambios) => setProps((previas) => ({ ...previas, ...cambios })),
  };
  if (!Pantalla) return <p>Pantalla desconocida: {String(window.__pantalla)}</p>;
  return <Pantalla {...props} />;
}
