// Pedido a OpenAI cuya respuesta tiene que ser un JSON con una forma fija.
// Lo usan TODOS los proveedores de IA de la app (Etapa 85): antes cada uno
// hacía una sola llamada, y si el modelo devolvía algo con otra forma
// ("formato inválido") el error llegaba tal cual al panel, aunque con
// "Reintentar" funcionara. Ahora hay tres defensas, en este orden:
//
//   1. Salida estructurada (`response_format: json_schema` con `strict`):
//      OpenAI genera la respuesta ajustada al esquema, no solo "algún JSON".
//      Si el modelo configurado no la soporta (400), se sigue con
//      `json_object` y el parseo de cada proveedor.
//   2. Reintentos automáticos: una respuesta vacía, con forma inválida, o un
//      error pasajero de OpenAI (red, 429, 5xx) se vuelve a pedir, hasta
//      MAX_ATTEMPTS veces, sin que el usuario se entere.
//   3. Un tope de tiempo total (`timeBudgetMs`), para responder SIEMPRE antes
//      de que el panel corte la espera (45 s en quiz y resúmenes).
//
// Si aun así no sale (OpenAI caído, clave inválida), se tira `failureMessage`:
// un mensaje pensado para el usuario, nunca el detalle técnico, que queda en
// el log.

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [300, 800];
const DEFAULT_TIME_BUDGET_MS = 35000;
// Sin al menos este margen no vale la pena otro intento: no llegaría a
// terminar dentro del tope.
const MIN_TIME_FOR_ATTEMPT_MS = 4000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Errores que no se arreglan reintentando (clave inválida, pedido mal armado).
function isRetryable(err) {
  const status = err?.status;
  if (status == null) return true; // red o timeout
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isSchemaRejected(err) {
  return err?.status === 400 && /response_format|json_schema|schema/i.test(err.message || '');
}

// Por si el modelo envuelve el JSON en un bloque ```json (pasa con
// `json_object`, nunca con salida estructurada).
function parseJsonText(rawText) {
  const text = String(rawText).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

async function requestJson({
  client,
  label,
  model,
  temperature,
  messages,
  schemaName,
  schema,
  parse,
  failureMessage,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
}) {
  const startedAt = Date.now();
  let useSchema = Boolean(schema);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = timeBudgetMs - (Date.now() - startedAt);
    if (attempt > 1 && remainingMs < MIN_TIME_FOR_ATTEMPT_MS) break;
    const tag = `${label} (intento ${attempt}/${MAX_ATTEMPTS})`;

    let response;
    try {
      response = await client.chat.completions.create(
        {
          model,
          temperature,
          response_format: useSchema
            ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
            : { type: 'json_object' },
          messages,
        },
        // Los reintentos los maneja este archivo, no el SDK: así el tope de
        // tiempo es uno solo y se cumple.
        { timeout: remainingMs, maxRetries: 0 }
      );
    } catch (err) {
      console.error(
        `[Sparkle][IA] OpenAI rechazó ${tag} (status=${err.status ?? 'n/a'}, code=${err.code ?? 'n/a'}):`,
        err.message
      );
      if (useSchema && isSchemaRejected(err)) {
        useSchema = false;
        continue;
      }
      if (!isRetryable(err)) break;
      if (attempt < MAX_ATTEMPTS) await wait(RETRY_DELAYS_MS[attempt - 1]);
      continue;
    }

    const choice = response.choices?.[0];
    const rawContent = choice?.message?.content;
    if (!rawContent) {
      console.error(
        `[Sparkle][IA] OpenAI no devolvió contenido para ${tag} ` +
          `(finish_reason=${choice?.finish_reason ?? 'n/a'}, refusal=${choice?.message?.refusal ?? 'n/a'}).`
      );
    } else {
      try {
        const value = parse(rawContent);
        if (attempt > 1) console.log(`[Sparkle][IA] ${label}: salió bien en el intento ${attempt}.`);
        return { value, response };
      } catch (err) {
        console.error(`[Sparkle][IA] OpenAI devolvió ${tag} con forma inválida:`, err.message, '| contenido crudo:', rawContent);
      }
    }
    if (attempt < MAX_ATTEMPTS) await wait(RETRY_DELAYS_MS[attempt - 1]);
  }

  throw new Error(failureMessage);
}

module.exports = { requestJson, parseJsonText, MAX_ATTEMPTS };
