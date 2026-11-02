import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FOURSIDES_MAX_BYTES, normalizeFoursidesNumber, parseFoursides, PROVIDER } from './parser.js';

/** The lookup 4sides.ru's tracking page makes for the waybill in its address or form. */
export const FOURSIDES_API = 'https://4sides.ru/api/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing waybill: the lookup answers unknown ones with HTTP 200.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|DDoS-Guard)|_cf_chl_opt|cf-turnstile|ddos-guard|qrator|smartcaptcha|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '4Sides answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, '4Sides returned a reply that is not JSON', { cause });
  }
}

export class FoursidesTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFoursidesNumber(raw);
    const url = `${FOURSIDES_API}?${new URLSearchParams({ number }).toString()}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FOURSIDES_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, '4Sides redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, '4Sides tracking lookup is unavailable', { status: response.status });
      // The lookup checks the number as the adapter does, so its refusal is a changed rule.
      if (response.status === 400) throw new SchemaError(PROVIDER, '4Sides refused the lookup request', { status: 400 });
      const body = decodeText(bytes).trim();
      if (!body) throw new IndeterminateError(PROVIDER, '4Sides returned an empty reply');
      return parseFoursides(json(body), number);
    };
    // A request that fails to reach 4Sides, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: '4sides', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FoursidesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: '4sides', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFoursidesNumber(number))),
  };
};
