import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JET_LOGISTIC_MAX_BYTES, normalizeJetLogisticNumber, parseJetLogistic, PROVIDER } from './parser.js';

/** The lookup the cargo check on every page of jetlogistic.kz makes for the ID typed in. */
export const JET_LOGISTIC_API = 'https://jetlogistic.kz/ajax/checkstatus.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|DDoS-Guard)|_cf_chl_opt|cf-turnstile|ddos-guard|qrator|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Jet Logistic answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Jet Logistic returned a reply that is not JSON', { cause });
  }
}

export class JetLogisticTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJetLogisticNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page also sends `check_pay`, for the payment link it shows for an unpaid
      // cargo; the steps are the same without it.
      const { response, bytes } = await fetchBounded(JET_LOGISTIC_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ TID: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: JET_LOGISTIC_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'Jet Logistic cargo check is unavailable', { status: response.status });
      }
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Jet Logistic refused the lookup', { status: 403 });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!body) throw new IndeterminateError(PROVIDER, 'Jet Logistic returned an empty reply');
      return parseJetLogistic(json(body), number);
    };
    // A lookup that fails to reach the site, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'jet-logistic', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JetLogisticTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jet-logistic', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJetLogisticNumber(number))),
  };
};
