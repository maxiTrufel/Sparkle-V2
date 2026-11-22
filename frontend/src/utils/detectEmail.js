const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// "Joined as xxx@gmail.com" / "Te uniste como xxx@gmail.com" — texto que
// Meet muestra en el popup "Your meeting's ready" del lobby (Etapa 15).
// Cubre las variantes en inglés y español que son razonablemente
// esperables según el idioma configurado en la cuenta de Google.
const JOINED_AS_REGEX =
  /(?:joined as|signed in as|te uniste como|iniciaste sesión como|conectado[a]? como)[^\w@]{0,12}([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;

// Estrategia 1 (la original): el email suele estar en el aria-label del
// botón/ícono de cuenta (ej. "Cuenta de Google: Nombre (email@gmail.com)").
// Es la más confiable — el aria-label de ese botón específico es casi
// siempre el email de la cuenta activa, no cualquier otro email que
// aparezca en la página.
function searchAriaLabels() {
  const candidates = document.querySelectorAll('[aria-label*="@"]');

  for (const element of candidates) {
    const match = element.getAttribute('aria-label')?.match(EMAIL_REGEX);
    if (match) return match[0];
  }

  return null;
}

// Estrategia 2: en el lobby ("Ready to join?"), el aria-label de la
// Estrategia 1 no siempre está presente (layout distinto al de landing —
// ver DOCUMENTACION.md, Etapa 15), pero Meet suele mostrar el email en
// texto visible tipo "Joined as xxx@gmail.com" en el popup de la reunión.
function searchJoinedAsPattern() {
  const text = document.body.innerText || '';
  const match = text.match(JOINED_AS_REGEX);
  return match ? match[1] : null;
}

// Estrategia 3 (último recurso): cualquier email en el texto visible de la
// página. Es la menos confiable de las tres —podría matchear un email que
// no sea el de la cuenta activa (ej. uno mencionado en el nombre de la
// reunión o en otro texto)— pero mejor eso que no detectar nada.
function searchEmailInPlainText() {
  const text = document.body.innerText || '';
  const match = text.match(EMAIL_REGEX);
  return match ? match[0] : null;
}

// Etapa 82 — `plainText` marca la estrategia que acepta cualquier email
// escrito en la página. Adentro de la llamada se saltea: ahí hay chat,
// subtítulos y nombres de participantes, y un email pegado en el chat se
// tomaría como el de la cuenta. En la sala de espera sí hace falta: es la
// única que encuentra el email ahí (ver los logs de la Etapa 82).
const STRATEGIES = [
  { name: 'aria-label con "@"', search: searchAriaLabels },
  { name: 'texto "Joined as ..." / "Te uniste como ..."', search: searchJoinedAsPattern },
  { name: 'texto plano de la página (fallback amplio)', search: searchEmailInPlainText, plainText: true },
];

// Prueba las estrategias en orden (de más confiable a menos) y devuelve el
// primer resultado válido. Loguea cuál estrategia encontró el email, para
// poder confirmar en la consola cuál terminó funcionando en cada pantalla
// de Meet (ver DOCUMENTACION.md, Etapa 15).
export function detectGoogleAccountEmail({ allowPlainText = true } = {}) {
  for (const strategy of STRATEGIES) {
    if (strategy.plainText && !allowPlainText) continue;
    const email = strategy.search();
    if (email) {
      console.log(`[Sparkle] Email detectado vía estrategia: "${strategy.name}" → ${email}`);
      return email;
    }
  }

  return null;
}
