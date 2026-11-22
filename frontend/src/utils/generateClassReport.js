import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  getStudentStats,
  getQuestionsHistory,
  getClassReportAnalysis,
  getReportDocumentTopics,
} from '../services/backendMessaging';

// Reporte PDF de fin de clase — "Descargar reporte" (docente,
// `screens/TeacherPanel.jsx`). Orquesta los pedidos necesarios (dos vía
// REST ya existentes desde antes de esta funcionalidad, dos nuevos —
// análisis final y temas del documento), arma el PDF entero con jsPDF +
// jspdf-autotable, y dispara la descarga. Corre en el CONTENT SCRIPT
// (contexto de página real,
// con DOM completo) — a diferencia del resto de las llamadas al backend,
// que van vía mensaje al service worker, `doc.save()` de jsPDF sí puede
// crear el link de descarga acá mismo, sin necesitar un mensaje aparte.
//
// El origen del análisis de la Sección final (`getClassReportAnalysis`) es
// un modelo de lenguaje del lado del backend — a propósito ESO NUNCA se
// menciona en ningún texto visible del PDF (ni "IA", ni "generado
// automáticamente", ni similar): se presenta como el análisis/las
// conclusiones de la clase en sí, sin aclarar de dónde salió. Mismo criterio
// para el código de reunión: es un identificador técnico interno, nunca
// aparece en el contenido visible del reporte (si aparece en el nombre del
// archivo descargado es solo para que el docente lo distinga en su
// carpeta de descargas, no es parte del documento en sí).

// Paleta REAL de Sparkle (`styles/panel.css`, variables `--sparkle-*`) —
// jsPDF no entiende variables CSS, así que se repiten acá como arrays RGB.
const PRIMARY = [26, 115, 232]; // --sparkle-primary
const BG_SUBTLE = [248, 249, 250]; // --sparkle-bg-subtle
const TEXT_PRIMARY = [32, 33, 36]; // --sparkle-text-primary
const TEXT_SECONDARY = [95, 99, 104]; // --sparkle-text-secondary
const BORDER = [218, 220, 224]; // --sparkle-border
const WHITE = [255, 255, 255];
const SUCCESS = [52, 168, 83]; // --sparkle-success → indicador "Excelente"
const WARNING = [176, 96, 0]; // --sparkle-warning → indicador "Regular"
const DANGER = [217, 48, 37]; // --sparkle-danger → indicador "Necesita apoyo"
// "Bien" reusa PRIMARY (no hay un quinto color de estado propio en
// panel.css para este caso puntual) — mismo azul que ya usa el resto del
// reporte para encabezados y tablas, visualmente distinto de los otros tres
// indicadores.

const PAGE_MARGIN = 40;
const FOOTER_MARGIN = 26;
const TOPICS_PREVIEW_LIMIT = 6;

// Umbrales de indicador de rendimiento — ≥90 Excelente, ≥75 Bien, ≥50
// Regular, <50 Necesita apoyo. Mismo color en TODO el documento (hoy: solo
// el ranking de alumnos) — nunca un color distinto para el mismo nivel.
function getIndicator(percent) {
  if (percent >= 90) return { label: 'Excelente', color: SUCCESS };
  if (percent >= 75) return { label: 'Bien', color: PRIMARY };
  if (percent >= 50) return { label: 'Regular', color: WARNING };
  return { label: 'Necesita apoyo', color: DANGER };
}

// La opción incorrecta que más alumnos eligieron — `null` si nadie eligió
// ninguna incorrecta (todos acertaron o saltearon). `optionDistribution` ya
// viene con `correct`/`count`/`percent` resueltos por el backend (ver
// `backend/src/services/questionService.js#toTeacherHistoryEntry`), acá
// solo se elige el máximo entre las incorrectas.
function getTrickiestDistractor(optionDistribution) {
  const incorrectWithVotes = (optionDistribution || []).filter((opt) => !opt.correct && opt.count > 0);
  if (incorrectWithVotes.length === 0) return null;
  return incorrectWithVotes.reduce((max, opt) => (opt.count > max.count ? opt : max), incorrectWithVotes[0]);
}

function formatDateLabel(date) {
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Nombre de archivo seguro — un código de reunión de Meet normal (letras/
// números/guiones) ya pasa intacto; esto es solo una red de seguridad
// contra cualquier carácter que un sistema de archivos no acepte. Vive
// SOLO en el nombre del archivo descargado (organización de la carpeta de
// descargas del docente) — nunca dentro del contenido visible del PDF.
function sanitizeForFilename(text) {
  return String(text).replace(/[^a-zA-Z0-9-]+/g, '-');
}

function ensureSpace(doc, y, neededHeight) {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + neededHeight > pageHeight - FOOTER_MARGIN - 20) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return y;
}

// Título de sección — número (secuencial, asignado por quien arma el
// documento en `generateClassReport`, así una sección omitida como
// "Alumnos que saltearon muchas preguntas" nunca deja un salto en la
// numeración) + texto en color primario + línea separadora fina, en vez
// del bloque de color sólido de la versión anterior — look más plano y
// moderno, consistente con el resto de tarjetas/tablas del reporte.
function addSectionTitle(doc, y, number, title) {
  y = ensureSpace(doc, y, 36);
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...PRIMARY);
  doc.text(`${number}. ${title}`, PAGE_MARGIN, y);

  y += 9;
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(1);
  doc.line(PAGE_MARGIN, y, pageWidth - PAGE_MARGIN, y);

  return y + 18;
}

function addSubheading(doc, y, text) {
  y = ensureSpace(doc, y, 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...TEXT_PRIMARY);
  doc.text(text, PAGE_MARGIN, y);
  doc.setFont('helvetica', 'normal');
  return y + 16;
}

function addBulletList(doc, y, items) {
  const maxWidth = doc.internal.pageSize.getWidth() - PAGE_MARGIN * 2 - 12;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...TEXT_PRIMARY);
  items.forEach((item) => {
    const lines = doc.splitTextToSize(item, maxWidth);
    y = ensureSpace(doc, y, lines.length * 13 + 4);
    doc.text('•', PAGE_MARGIN, y);
    doc.text(lines, PAGE_MARGIN + 12, y);
    y += lines.length * 13 + 4;
  });
  return y;
}

function addEmptyStateNote(doc, y, text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...TEXT_SECONDARY);
  doc.text(text, PAGE_MARGIN, y);
  return y + 20;
}

// Tarjeta de métrica clave (portada) — fondo tenue + etiqueta chica en
// mayúsculas + valor grande, mismo criterio visual que las "stat cards" de
// un dashboard. `valueColor` opcional (default `TEXT_PRIMARY`) — se usa
// para el promedio de aciertos, coloreado según el indicador de nivel.
function drawStatCard(doc, x, y, width, height, label, value, valueColor) {
  doc.setFillColor(...BG_SUBTLE);
  doc.roundedRect(x, y, width, height, 8, 8, 'F');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...TEXT_SECONDARY);
  doc.text(label.toUpperCase(), x + 14, y + 22, { maxWidth: width - 28 });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(23);
  doc.setTextColor(...(valueColor || TEXT_PRIMARY));
  doc.text(value, x + 14, y + height - 16);
}

// Tarjeta "Temas abordados" (portada) — mismo lenguaje visual que
// `drawStatCard` (fondo tenue, esquinas redondeadas) para que las tres
// tarjetas de la portada luzcan como un conjunto, pero de ANCHO COMPLETO y
// ALTO VARIABLE: a diferencia de un número suelto, una lista de temas no
// entra en una caja de tamaño fijo, así que esta función mide el contenido
// ANTES de dibujar el fondo (necesita saber cuánto va a ocupar el texto
// para dibujar un rectángulo que lo contenga entero, jsPDF no tiene ningún
// "auto-height" nativo). Devuelve el alto real dibujado, por si quien llama
// necesita seguir posicionando algo debajo.
function drawTopicsCard(doc, x, y, width, topics) {
  const paddingX = 20;
  const paddingTop = 24;
  const paddingBottom = 20;
  const headingGap = 18;
  const bulletLineHeight = 13;
  const bulletSpacing = 6;
  const maxTextWidth = width - paddingX * 2 - 12;

  const preview = topics.slice(0, TOPICS_PREVIEW_LIMIT);
  const hasMore = topics.length > preview.length;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const linesPerTopic = preview.map((topic) => doc.splitTextToSize(topic, maxTextWidth));

  // Mide el alto total del contenido ANTES de dibujar nada.
  let contentHeight = headingGap;
  if (preview.length === 0) {
    contentHeight += 14;
  } else {
    linesPerTopic.forEach((lines) => {
      contentHeight += lines.length * bulletLineHeight + bulletSpacing;
    });
    if (hasMore) contentHeight += 14;
  }

  const cardHeight = paddingTop + contentHeight + paddingBottom;

  doc.setFillColor(...BG_SUBTLE);
  doc.roundedRect(x, y, width, cardHeight, 10, 10, 'F');

  let cursorY = y + paddingTop;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...TEXT_PRIMARY);
  doc.text('Temas abordados', x + paddingX, cursorY);
  cursorY += headingGap;

  if (preview.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text('No se registraron preguntas durante esta clase.', x + paddingX, cursorY);
    return cardHeight;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...TEXT_PRIMARY);
  preview.forEach((topic, index) => {
    const lines = linesPerTopic[index];
    doc.text('•', x + paddingX, cursorY);
    doc.text(lines, x + paddingX + 12, cursorY);
    cursorY += lines.length * bulletLineHeight + bulletSpacing;
  });

  if (hasMore) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(`+ ${topics.length - preview.length} tema(s) más — ver "Resumen de la clase".`, x + paddingX, cursorY);
  }

  return cardHeight;
}

// Portada — densa a propósito (pedido explícito: "nunca una página casi
// vacía"): banda de marca, título, y tres métricas ("tarjetas"): dos
// tarjetas de número (alumnos/preguntas) lado a lado, y una tercera de
// ancho completo con los temas abordados debajo — mismo lenguaje visual
// entre las tres (fondo tenue, esquinas redondeadas), pensado como un
// conjunto armónico. El detalle completo de ranking/preguntas/temas vive en
// las páginas siguientes — acá es un panorama ejecutivo de un vistazo.
function buildCoverPage(doc, { dateLabel, totalStudents, totalQuestions, topics }) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const bandHeight = 168;

  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageWidth, bandHeight, 'F');

  doc.setTextColor(...WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('SPARKLE', PAGE_MARGIN, 52);

  doc.setFontSize(29);
  doc.text('Reporte de Clase', PAGE_MARGIN, 96);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.text(`Generado el ${dateLabel}`, PAGE_MARGIN, 122);

  // Dos tarjetas de número, lado a lado — más anchas y más altas que
  // cuando compartían la fila con una tercera, para que la portada siga
  // sintiéndose completa sin dejar huecos.
  let y = bandHeight + 40;
  const cardGap = 20;
  const cardWidth = (pageWidth - PAGE_MARGIN * 2 - cardGap) / 2;
  const cardHeight = 96;

  drawStatCard(doc, PAGE_MARGIN, y, cardWidth, cardHeight, 'Alumnos participantes', String(totalStudents));
  drawStatCard(
    doc,
    PAGE_MARGIN + cardWidth + cardGap,
    y,
    cardWidth,
    cardHeight,
    'Preguntas realizadas',
    String(totalQuestions)
  );

  y += cardHeight + 24;

  // Tercera tarjeta, ancho completo — temas abordados.
  drawTopicsCard(doc, PAGE_MARGIN, y, pageWidth - PAGE_MARGIN * 2, topics);
}

// Sección — "Resumen de la clase": de qué se trató. Fuente preferida: los
// temas identificados en el material que subió el docente (`mainTopics`
// del análisis del documento, ver
// `backend/src/services/classReportService.getDocumentTopics`) — es la
// mejor aproximación a "de qué se trató la clase" cuando existe. Si no hay
// documento (o no llegó a identificar temas), `topics` ya viene con el
// fallback aplicado por `generateClassReport` (los enunciados de las
// preguntas realizadas) — esta función no distingue el origen, el texto de
// acá es neutral a propósito para valer en ambos casos.
function addClassSummarySection(doc, y, number, topics) {
  y = addSectionTitle(doc, y, number, 'Resumen de la clase');

  if (topics.length === 0) {
    return addEmptyStateNote(doc, y, 'No hay material ni preguntas registradas para resumir esta clase.');
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...TEXT_SECONDARY);
  const intro = `La clase abordó ${topics.length} tema${topics.length === 1 ? '' : 's'}:`;
  const introLines = doc.splitTextToSize(intro, doc.internal.pageSize.getWidth() - PAGE_MARGIN * 2);
  doc.text(introLines, PAGE_MARGIN, y);
  y += introLines.length * 13 + 8;

  return addBulletList(doc, y, topics) + 10;
}

// Ranking de alumnos, de mayor a menor % de aciertos.
function addRankingSection(doc, y, number, ranking) {
  y = addSectionTitle(doc, y, number, 'Ranking de alumnos');

  if (ranking.length === 0) {
    return addEmptyStateNote(doc, y, 'Todavía no se realizó ninguna pregunta en esta clase — no hay ranking para mostrar.');
  }

  autoTable(doc, {
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Alumno', 'Correctas', 'Respondidas', 'Salteadas', '% Aciertos', 'Nivel']],
    body: ranking.map((student) => [
      student.name || student.email,
      String(student.correctAnswers),
      String(student.totalFinishedQuestions),
      String(student.skippedQuestions),
      `${student.percent}%`,
      student.indicator.label,
    ]),
    theme: 'striped',
    headStyles: { fillColor: PRIMARY, textColor: WHITE, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: BG_SUBTLE },
    styles: { fontSize: 9, cellPadding: 6, textColor: TEXT_PRIMARY },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 5) {
        const rowIndicator = ranking[data.row.index]?.indicator;
        if (rowIndicator) {
          data.cell.styles.textColor = rowIndicator.color;
          data.cell.styles.fontStyle = 'bold';
        }
      }
    },
  });

  return doc.lastAutoTable.finalY + 24;
}

// Por cada pregunta finalizada: % de aciertos grupales, distractor más
// engañoso y tiempo promedio de respuesta.
function addQuestionAnalysisSection(doc, y, number, questions) {
  y = addSectionTitle(doc, y, number, 'Análisis de preguntas');

  if (questions.length === 0) {
    return addEmptyStateNote(doc, y, 'No se realizaron preguntas durante esta clase.');
  }

  const body = questions.map((question, index) => {
    const correctPercent = question.optionDistribution?.[question.correctOptionIndex]?.percent ?? 0;
    const trickiest = getTrickiestDistractor(question.optionDistribution);
    const avgTimeLabel = question.avgResponseTimeSeconds != null ? `${question.avgResponseTimeSeconds}s` : '—';
    return [
      `${index + 1}. ${question.prompt}`,
      `${correctPercent}%`,
      trickiest ? `${trickiest.label} (${trickiest.percent}%)` : '—',
      avgTimeLabel,
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Pregunta', '% Aciertos', 'Distractor más engañoso', 'Tiempo prom.']],
    body,
    theme: 'striped',
    headStyles: { fillColor: PRIMARY, textColor: WHITE, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: BG_SUBTLE },
    styles: { fontSize: 9, cellPadding: 6, textColor: TEXT_PRIMARY, valign: 'top' },
    columnStyles: {
      0: { cellWidth: 225 },
      1: { cellWidth: 55, halign: 'center' },
      2: { cellWidth: 150 },
      3: { cellWidth: 55, halign: 'center' },
    },
  });

  return doc.lastAutoTable.finalY + 24;
}

// Alumnos con más del 40% de preguntas salteadas — quien llama
// (`generateClassReport`) decide si corresponde llamar a esta función:
// se omite la sección entera (ni el título) si no hay ninguno.
function addHeavySkippersSection(doc, y, number, heavySkippers) {
  y = addSectionTitle(doc, y, number, 'Alumnos que saltearon muchas preguntas');
  autoTable(doc, {
    startY: y,
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    head: [['Alumno', 'Preguntas salteadas', 'Total de preguntas']],
    body: heavySkippers.map((student) => [
      student.name || student.email,
      String(student.skippedQuestions),
      String(student.totalFinishedQuestions),
    ]),
    theme: 'striped',
    headStyles: { fillColor: WARNING, textColor: WHITE, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: BG_SUBTLE },
    styles: { fontSize: 9, cellPadding: 6, textColor: TEXT_PRIMARY },
  });

  return doc.lastAutoTable.finalY + 24;
}

// Análisis final de la clase — fortalezas/aspectos a reforzar del grupo,
// diagnóstico de las preguntas con baja tasa de acierto, recomendaciones
// personalizadas por alumno, y temas sugeridos. A propósito NUNCA se
// menciona la fuente (modelo de lenguaje) en ningún texto de esta sección
// — se presenta como el análisis de la clase en sí. Si el análisis no
// llegó a generarse (flag apagado del lado del backend, o falló la
// llamada upstream), se muestra un mensaje neutral en vez de romper el
// resto del reporte — ver `backend/src/services/classReportService.js`.
function addClassAnalysisSection(doc, y, number, analysis, questionsById) {
  y = addSectionTitle(doc, y, number, 'Análisis de la clase');

  if (!analysis?.aiAnalysisAvailable) {
    return addEmptyStateNote(doc, y, 'El análisis de la clase no está disponible en este momento.');
  }

  if (analysis.strengths?.length) {
    y = addSubheading(doc, y, 'Fortalezas del grupo');
    y = addBulletList(doc, y, analysis.strengths) + 6;
  }

  if (analysis.weaknesses?.length) {
    y = addSubheading(doc, y, 'Aspectos a reforzar');
    y = addBulletList(doc, y, analysis.weaknesses) + 6;
  }

  if (analysis.questionDiagnostics?.length) {
    y = addSubheading(doc, y, 'Preguntas con baja tasa de acierto');
    const items = analysis.questionDiagnostics.map((diagnostic) => {
      const prompt = questionsById.get(diagnostic.questionId)?.prompt || `Pregunta #${diagnostic.questionId}`;
      const diagnosisLabel =
        diagnostic.diagnosis === 'pregunta_confusa' ? 'posible pregunta confusa' : 'dificultad del tema';
      return `"${prompt}" (${diagnosisLabel}): ${diagnostic.explanation}`;
    });
    y = addBulletList(doc, y, items) + 6;
  }

  if (analysis.studentRecommendations?.length) {
    y = addSubheading(doc, y, 'Recomendaciones personalizadas');
    const items = analysis.studentRecommendations.map((rec) => `${rec.name}: ${rec.recommendation}`);
    y = addBulletList(doc, y, items) + 6;
  }

  if (analysis.suggestedTopics?.length) {
    y = addSubheading(doc, y, 'Temas sugeridos para la próxima clase');
    y = addBulletList(doc, y, analysis.suggestedTopics);
  }

  return y + 10;
}

function addFooters(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text('Sparkle', PAGE_MARGIN, pageHeight - FOOTER_MARGIN);
    doc.text(`Página ${page} de ${pageCount}`, pageWidth - PAGE_MARGIN, pageHeight - FOOTER_MARGIN, {
      align: 'right',
    });
  }
}

// Punto de entrada — llamado por `TeacherPanel.jsx` al hacer click en
// "Descargar reporte". `getStudentStats`/`getQuestionsHistory` son
// ENDPOINTS CORE (ranking, análisis de preguntas): un fallo ahí aborta la
// generación entera, se propaga tal cual para que el botón muestre el
// error. `getReportDocumentTopics`/`getClassReportAnalysis` son OPCIONALES
// (temas del material y análisis final): un fallo ahí nunca debe impedir
// descargar el resto del reporte, así que se degradan a un fallback/estado
// "no disponible" en vez de propagar el error hacia arriba.
export async function generateClassReport({ meetingCode, email }) {
  const [studentStatsResult, questionsHistoryResult] = await Promise.all([
    getStudentStats(meetingCode, email),
    getQuestionsHistory(meetingCode, email),
  ]);

  if (studentStatsResult?.error) throw new Error(studentStatsResult.error);
  if (questionsHistoryResult?.error) throw new Error(questionsHistoryResult.error);

  const students = studentStatsResult?.students || [];
  const questions = questionsHistoryResult?.questions || [];

  // Validación mínima (pedido explícito) — un reporte sin ningún alumno
  // registrado o sin ninguna pregunta finalizada no tiene ranking, análisis
  // de preguntas, ni resumen real que mostrar: se corta ACÁ, antes de pedir
  // los temas del documento/el análisis final (evita esas dos llamadas de
  // más cuando ya se sabe que el reporte no se va a generar) y antes de
  // tocar jsPDF. `code: 'INSUFFICIENT_DATA'` es lo que
  // `TeacherPanel.jsx#handleDownloadReport` usa para mostrar este mensaje
  // TAL CUAL (sin el prefijo genérico "No se pudo generar el reporte: ..."
  // que sí antepone a cualquier otro error real).
  if (students.length === 0 || questions.length === 0) {
    throw Object.assign(
      new Error(
        'No hay suficiente información para generar el reporte.'
      ),
      { code: 'INSUFFICIENT_DATA' }
    );
  }

  // "Temas abordados" — fuente preferida: los temas identificados en el
  // material que subió el docente (ver
  // `backend/src/services/classReportService.getDocumentTopics`). Si no
  // hay documento, no se analizó, o no identificó ningún tema, se cae de
  // vuelta a los enunciados de las preguntas realizadas — mismo criterio
  // "nunca mostrar nada inventado" que ya usa `classSummaryService` del
  // lado del backend para su propio resumen.
  let documentTopics = [];
  try {
    const topicsResp = await getReportDocumentTopics(meetingCode, email);
    if (topicsResp?.status === 200) documentTopics = topicsResp.body?.topics || [];
  } catch (err) {
    // Sin temas del documento — se usa el fallback de abajo, sin
    // interrumpir el resto del reporte.
  }
  const questionTopics = questions.map((question) => question.prompt);
  const topics = documentTopics.length > 0 ? documentTopics : questionTopics;

  let aiAnalysis = { aiAnalysisAvailable: false, reason: 'ai_disabled' };
  try {
    const aiResp = await getClassReportAnalysis(meetingCode, email);
    if (aiResp?.status === 200) {
      aiAnalysis = aiResp.body;
    } else {
      aiAnalysis = { aiAnalysisAvailable: false, reason: 'error' };
    }
  } catch (err) {
    aiAnalysis = { aiAnalysisAvailable: false, reason: 'error' };
  }

  const ranking = students
    .map((student) => {
      const percent =
        student.totalFinishedQuestions > 0
          ? Math.round((student.correctAnswers / student.totalFinishedQuestions) * 100)
          : 0;
      return { ...student, percent, indicator: getIndicator(percent) };
    })
    .sort((a, b) => b.percent - a.percent);

  const heavySkippers = students
    .filter((student) => student.totalFinishedQuestions > 0 && student.skippedQuestions / student.totalFinishedQuestions > 0.4)
    .sort((a, b) => b.skippedQuestions - a.skippedQuestions);

  const questionsById = new Map(questions.map((question) => [question.id, question]));

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const now = new Date();

  buildCoverPage(doc, {
    dateLabel: formatDateLabel(now),
    totalStudents: students.length,
    totalQuestions: questions.length,
    topics,
  });

  doc.addPage();
  let y = PAGE_MARGIN;
  let sectionNumber = 0;
  const nextSectionNumber = () => {
    sectionNumber += 1;
    return sectionNumber;
  };

  y = addClassSummarySection(doc, y, nextSectionNumber(), topics);
  y = addRankingSection(doc, y, nextSectionNumber(), ranking);
  y = addQuestionAnalysisSection(doc, y, nextSectionNumber(), questions);
  if (heavySkippers.length > 0) {
    y = addHeavySkippersSection(doc, y, nextSectionNumber(), heavySkippers);
  }
  addClassAnalysisSection(doc, y, nextSectionNumber(), aiAnalysis, questionsById);

  addFooters(doc);

  const fileDate = now.toISOString().slice(0, 10);
  doc.save(`reporte-clase-${sanitizeForFilename(meetingCode)}-${fileDate}.pdf`);
}
