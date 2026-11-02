import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeStone3plNumber, parseStone3pl, PROVIDER } from './parser.js';

export const STONE3PL_API = 'https://stone3pl.com/?route=services/get_track/track&is_debug=';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)/i;

function json(body: string): unknown {
  try { return JSON.parse(body); }
  catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Stone3PL answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Stone3PL returned a reply that is not JSON', { cause });
  }
}

export class Stone3plTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeStone3plNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // jQuery's form encoding, as sent by the public tracking page. No session or key.
      const body = new URLSearchParams({ 'data[0][number]': number, 'data[0][i]': '0' });
      const { response, bytes } = await fetchBounded(STONE3PL_API, {
        method: 'POST', signal, body: body.toString(), headers: {
          Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent),
        },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 512 * 1024,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Stone3PL tracking lookup is unavailable', { status: response.status });
      }
      return parseStone3pl(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'stone3pl', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new Stone3plTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'stone3pl', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeStone3plNumber(number))),
  };
};
