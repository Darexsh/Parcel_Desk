import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GUATEX_MAX_BYTES, normalizeGuatexNumber, parseGuatex, PROVIDER } from './parser.js';

const ORIGIN = 'https://servicios.guatex.gt';
/** The lookup the tracker page at servicios.guatex.gt/Guatex/RastreoTracking posts the guía to. */
export const GUATEX_API = `${ORIGIN}/Guatex/Login/ObtengoTrackingGuia`;
const PAGE = `${ORIGIN}/Guatex/RastreoTracking`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup answers an unknown guía with HTTP 200; a 404 is a moved route.
const GONE = [404, 410];
// A page in place of the reply: a bot check, a firewall's refusal or an error page.
const PAGE_REPLY = /^\s*</;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (PAGE_REPLY.test(body)) throw new ChallengeError(PROVIDER, 'Guatex answered with a page instead of its lookup', { cause });
    throw new SchemaError(PROVIDER, 'Guatex returned a reply that is not JSON', { cause });
  }
}

export class GuatexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGuatexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own request; no cookie, token or account goes with it.
      const { response, bytes } = await fetchBounded(GUATEX_API, { method: 'POST', signal, headers: {
        Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': userAgentOf(this.options.userAgent), Origin: ORIGIN, Referer: PAGE,
      }, body: new URLSearchParams({ noguia: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: GUATEX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Guatex moved its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Guatex tracking lookup is unavailable', { status: response.status });
      return parseGuatex(json(decodeText(bytes).replace(/^\uFEFF/, '')), number);
    };
    // A request that fails to reach Guatex, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'guatex', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GuatexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'guatex', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGuatexNumber(number))),
  };
};
