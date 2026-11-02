import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { EVROPAT_MAX_BYTES, normalizeEvropatNumber, parseEvropat, PROVIDER } from './parser.js';

/** The lookup the tracking page on evropat.bg makes, anonymously, for the waybill in its address. */
export const EVROPAT_API = 'https://evropat.bg/wp-json/evropat/v1/track';
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|h-captcha/i;
// The lookup's own words for a waybill it does not have, and for one it refuses.
const MISSING = 'Няма намерена пратка с този номер.';
const REFUSED = 'Въведете валиден номер на товарителница.';

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Evropat answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Evropat returned a reply that is not JSON', { cause });
  }
}

/** The lookup's refusal, `{ ok: false, message }`, with the message it shows. */
function refusal(payload: unknown): string | undefined {
  return isRecord(payload) && payload.ok === false && typeof payload.message === 'string' ? payload.message.trim() : undefined;
}

export class EvropatTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEvropatNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(EVROPAT_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ barcode: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: EVROPAT_MAX_BYTES, fetcher: this.options.fetcher, allowHttpStatuses: [400, 403, 404] });
      const body = decodeText(bytes);
      if (response.status !== 200) {
        let payload: unknown = null;
        try { payload = JSON.parse(body); } catch { /* not the lookup's answer */ }
        const message = refusal(payload);
        if (response.status === 404 && message === MISSING) throw new NotFoundError(PROVIDER);
        if (response.status === 400 && message === REFUSED) throw new InvalidInputError(PROVIDER, 'Evropat refused the waybill number', { reason: 'wrong_number' });
        // A firewall's refusal is a block, whatever page it sends.
        if (response.status === 403 || CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Evropat answered with a browser check');
        throw new TransportError(PROVIDER, 'Evropat tracking lookup is unavailable', { status: response.status });
      }
      return parseEvropat(json(body), number);
    };
    // A request that fails to reach Evropat, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'evropat', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EvropatTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'evropat', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
