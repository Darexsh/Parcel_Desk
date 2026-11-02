import { CarrierError, carrierErrorKind, retryAfterMsOf, SchemaError, TransportError } from '../../core/errors/index.js';
import { fetchBounded } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

const SYSTEM = 'Answer the simple question with only the requested word, number, or short phrase. Use lowercase and singular form for a person or object. When the question lists words, answer with one of them. Do not explain.';
// Recorded question shapes with synthetic words: the small model follows examples better than rules.
const EXAMPLES = [
  ['Write the item that is not a vegetable from these three words\ncarrot lamp onion', 'lamp'],
  ['Write the vehicle word from these three words\ncup bus pillow', 'bus'],
  ['Respond with the matching property from the question.\nWill a glass marble sink or float when released in fresh water?', 'sink'],
  ['Respond with the matching property from the question.\nWill a plastic duck toy sink or float when released in fresh water?', 'float'],
].flatMap(([question, answer]) => [{ role: 'user', content: question! }, { role: 'assistant', content: answer! }]);
type Message = { role: string; content: string };
const ANSWER = /^[A-Za-z0-9-][A-Za-z0-9 ,'-]{0,59}$/;

/** The words a question offers, when its heading asks to pick one of them. */
function listedWords(heading: string, question: string): string[] | null {
  const words = question.trim().toLowerCase();
  if (!/\b(?:words?|list|items?|which|select|choose|pick)\b/i.test(heading) || !/^[a-z]{2,20}(?:,? [a-z]{2,20}){2,4}$/.test(words)) return null;
  return words.split(/,? /);
}

/** Only the widget's question reaches the optional private model, never parcel data or browser state. */
export async function answerCorreosChileText(url: string, heading: string, question: string,
  signal: AbortSignal, timeoutMs: number, fetcher?: typeof fetch): Promise<string | null> {
  if (heading.length > 150 || question.length > 400) return null;
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new TransportError('Correos de Chile', 'Text solver address is invalid'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TransportError('Correos de Chile', 'Text solver address is invalid');
  }
  const deadline = Date.now() + timeoutMs;
  const ask = async (messages: Message[]) => {
    const answer = (await askModel(endpoint, messages, signal, deadline - Date.now(), fetcher))?.replace(/\.$/, '');
    return answer !== undefined && ANSWER.test(answer) ? answer : null;
  };
  const yes = async (asked: string) => {
    const reply = /^(yes|no)\b/i.exec(await askModel(endpoint, [{ role: 'system', content: 'Answer yes or no.' }, { role: 'user', content: asked }],
      signal, deadline - Date.now(), fetcher, 4) ?? '');
    return reply ? reply[1]!.toLowerCase() === 'yes' : null;
  };
  // The model reads "sink or float" as a cue for "sink"; asked whether the thing floats, it answers far better.
  const floats = /^Will (an? [a-z][a-z ]{0,40}) sink or float when released in fresh water\?$/.exec(question.trim());
  if (floats) {
    const floating = await yes(`Does ${floats[1]} float on fresh water?`);
    return floating === null ? null : floating ? 'float' : 'sink';
  }
  const words = listedWords(heading, question);
  // It misreads "not" too: each listed word is asked about on its own, and the one word outside the kind is the answer.
  const kind = words && /\b(?:is not|isn't|does not name) ((?:an? (?:piece of )?)?[a-z]+(?: [a-z]+)?)(?= from\b| in\b| among\b| write\b|[.?]|$)/i
    .exec(heading.trim())?.[1]?.toLowerCase();
  if (words && kind) {
    const outside: string[] = [];
    for (const word of words) if (await yes(`Is the word '${word}' ${kind}?`) === false) outside.push(word);
    if (outside.length === 1) return outside[0]!;
  }
  const messages = [{ role: 'system', content: SYSTEM }, ...EXAMPLES, { role: 'user', content: `${heading}\n${question}` }];
  const answer = await ask(messages);
  if (!words || answer === null || words.includes(answer.toLowerCase())) return answer;
  // A word the question does not list is wrong whatever it means; the model is asked once more with the choices.
  const again = await ask([...messages, { role: 'assistant', content: answer }, { role: 'user', content: `Answer with exactly one of: ${words.join(', ')}.` }]);
  return again !== null && words.includes(again.toLowerCase()) ? again.toLowerCase() : null;
}

async function askModel(endpoint: URL, messages: Message[], signal: AbortSignal, timeoutMs: number,
  fetcher?: typeof fetch, maxTokens = 32): Promise<string | null> {
  let bytes: Uint8Array;
  try { ({ bytes } = await fetchBounded(endpoint.href, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0, stream: false }) },
  { provider: 'Correos de Chile text solver', fetcher, timeoutMs: Math.max(1, Math.min(10_000, timeoutMs)),
    maxBytes: 8_000, redirect: 'error' }));
  } catch (error) {
    signal.throwIfAborted();
    // Private endpoint paths and request diagnostics must not reach telemetry.
    const kind = carrierErrorKind(error);
    // A missing model route says nothing about shipment existence.
    throw new CarrierError(kind === 'not_found' ? 'transport' : kind ?? 'transport', 'Correos de Chile', 'Text solver is unavailable', {
      ...(error instanceof CarrierError && kind !== 'not_found' ? { status: error.status } : {}), retryAfterMs: retryAfterMsOf(error),
    });
  }
  signal.throwIfAborted();
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new SchemaError('Correos de Chile', 'Text solver returned invalid JSON'); }
  const choice: unknown = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : null;
  const content: unknown = isRecord(choice) && isRecord(choice.message) ? choice.message.content : null;
  return typeof content === 'string' ? content.trim() : null;
}
