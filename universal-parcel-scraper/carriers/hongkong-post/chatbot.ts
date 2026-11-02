import { randomUUID } from 'node:crypto';
import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { expectMenuOption, expectNumberPrompt, MAIL_TRACING_PATH, pollMessage, PROVIDER, sendAccepted } from './parser.js';

// The official enquiry chatbot (Talk2Elain), linked from the Hongkong Post app
// and website. Each input is posted to `web`; the bot's reply is collected from
// `web/longPoll`, one message per poll.
export const HONGKONG_POST_SEND = 'https://chatbot.hongkongpost.hk/mw/web';
export const HONGKONG_POST_POLL = 'https://chatbot.hongkongpost.hk/mw/web/longPoll';
const CHANNEL = 'Talk2Elain';
const MAX_BYTES = 100_000;
/**
 * An idle poll ends with HTTP 408 after about 30 s; a poll that finds a message
 * returns at once. A reply without a message counts like an idle poll.
 */
const POLLS_PER_MESSAGE = 3;

export interface ChatbotLookup {
  fetcher?: typeof fetch;
  userAgent: string;
  /** Aborts on the caller's signal or at the end of the budget. */
  signal: AbortSignal;
  /** When the budget is spent, on the `performance.now()` clock. */
  deadline: number;
  budgetMs: number;
  /** Whether the budget, not the caller, ended the lookup. */
  spent: () => boolean;
}

/**
 * Walks a fresh session to Mail Tracing and returns the bot's answer to the
 * number. The answer does not repeat the number, so the session belongs to
 * this lookup alone, the number is its last input, and the answer is the first
 * message after it.
 */
export async function askMailTracing(number: string, lookup: ChatbotLookup): Promise<string> {
  const sessionId = randomUUID();
  const post = async (url: string, body: unknown, poll: boolean) => {
    const left = Math.floor(lookup.deadline - performance.now());
    if (left < 1 || lookup.spent()) throw new BudgetExceededError(PROVIDER, lookup.budgetMs);
    lookup.signal.throwIfAborted();
    let fetched: Awaited<ReturnType<typeof fetchBounded>>;
    try {
      fetched = await fetchBounded(url, { method: 'POST', signal: lookup.signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': lookup.userAgent,
      }, body: JSON.stringify(body) }, { provider: PROVIDER, timeoutMs: left, maxBytes: MAX_BYTES,
        allowHttpStatuses: poll ? [408] : [], fetcher: lookup.fetcher });
    } catch (error) {
      if (lookup.spent()) throw new BudgetExceededError(PROVIDER, lookup.budgetMs, { cause: error });
      // A missing route says nothing about the parcel.
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'Hongkong Post chatbot endpoint is unavailable', { cause: error, status: error.status });
      }
      throw error;
    }
    const { response, bytes } = fetched;
    if (poll && response.status === 408) return null;
    const text = decodeText(bytes);
    // CloudFront and WAF pages are HTML, whatever their status.
    if (/^\s*</.test(text) || /html/i.test(response.headers.get('content-type') ?? '')) {
      throw new ChallengeError(PROVIDER, 'Hongkong Post answered with a web page instead of the chatbot');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned invalid JSON', { cause });
    }
  };
  const exchange = async (content: string): Promise<string> => {
    sendAccepted(await post(HONGKONG_POST_SEND, {
      session_id: sessionId, channel: CHANNEL, input: { type: 'text', content }, timestamp: new Date().toISOString(), remarks: null,
    }, false));
    // The next input waits for this one's reply, so replies cannot be paired with the wrong input.
    for (let poll = 0; poll < POLLS_PER_MESSAGE; poll += 1) {
      const reply = await post(HONGKONG_POST_POLL, { session_id: sessionId }, true);
      const message = reply === null ? null : pollMessage(reply);
      if (message !== null) return message;
    }
    throw new IndeterminateError(PROVIDER, 'Hongkong Post chatbot did not answer');
  };
  let reply = await exchange('init');
  for (const step of MAIL_TRACING_PATH) {
    expectMenuOption(reply, step);
    reply = await exchange(step.option);
  }
  expectNumberPrompt(reply);
  return exchange(number);
}
