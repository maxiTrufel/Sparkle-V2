import { useEffect, useState } from 'react';
import { watchCallStage } from '../utils/callStage';

// 'lobby' | 'in-call' | 'ended' | 'undetermined' — decide qué CONTENIDO
// mostrar dentro del panel (nunca si el panel existe: eso lo sigue
// decidiendo únicamente la URL, vía content/main.jsx). Se resuscribe en
// cada montaje y se desconecta al desmontar, que es justo cuando se sale
// de la llamada (Etapa 24). `meetingCode` se pasa como clave del "sticky
// state" de `callStage.js` (Etapa 26): una reevaluación ambigua para esta
// misma reunión no pisa el último estado concluyente detectado.
export function useCallStage(meetingCode) {
  const [callStage, setCallStage] = useState('undetermined');
  useEffect(() => watchCallStage(setCallStage, meetingCode), [meetingCode]);
  return callStage;
}
