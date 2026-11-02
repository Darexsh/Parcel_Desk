import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, UpstreamHttpError, userAgentOf } from '../../core/transport/index.js';
import { ABF_MAX_BYTES, normalizeAbfNumber, parseAbfFreight, PROVIDER } from './parser.js';

// The service ArcBest's tracking page asks, without an account, key, cookie or CAPTCHA token.
export const ABF_ENDPOINT = 'https://view.arcb.com/api/nlo/track';
// A missing route is not a missing shipment: an unknown number is the service's own empty answer.
const GONE = [404, 410];
// The page a lookup comes from. ArcBest's edge holds a request without it for
// a few seconds, then answers with its error page.
const PAGE = 'https://view.arcb.com/nlo/tools/tracking/';
// ArcBest's edge page, which it also sends a request it takes for a bot, or a
// firewall's or CDN's block page.
const CHALLENGE = /<title>\s*(?:There was a problem|Just a moment|Attention Required|Access denied)|experiencing technical difficulties|cf-turnstile|_cf_chl_opt|captcha/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) && header !== '0' ? Number(header) * 1000 : undefined;
}

/** The address the page asks for one PRO number. */
export function abfTrackingUrl(raw: string): string {
  const url = new URL(ABF_ENDPOINT);
  url.searchParams.set('ref', normalizeAbfNumber(raw));
  return url.href;
}

/** Whether a reply is the service's answer for a number it has no shipment for: the number with none. */
function isEmptyAnswer(payload: unknown, number: string): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  const items = (payload as Record<string, unknown>)[number];
  return keys.length === 1 && keys[0] === number && Array.isArray(items) && items.length === 0;
}

export class AbfFreightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAbfNumber(raw);
    const url = abfTrackingUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent), Referer: `${PAGE}${number}`,
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ABF_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [...GONE, 429, 503] });
      const text = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ArcBest\'s edge refused the request', { cause });
        if (response.status === 503) throw new UpstreamHttpError(PROVIDER, 503, retryAfterMs(response));
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'ArcBest\'s tracking service is unavailable', { cause });
        throw new SchemaError(PROVIDER, 'ABF Freight returned a reply that is not JSON', { cause });
      }
      // An unknown number is a 404 whose reply has the number and no shipment.
      if (GONE.includes(response.status)) {
        if (response.status === 404 && isEmptyAnswer(payload, number)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'ArcBest\'s tracking service is unavailable');
      }
      if (response.status === 503) throw new UpstreamHttpError(PROVIDER, 503, retryAfterMs(response));
      return parseAbfFreight(payload, number);
    };
    // A request that fails to reach ArcBest, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'abf-freight', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AbfFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'abf-freight', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAbfNumber(number))),
  };
};
