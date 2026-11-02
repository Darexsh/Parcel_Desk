import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { FARGO_UZ_MAX_BYTES, normalizeFargoUzNumber, parseFargoUz, PROVIDER } from './parser.js';

/** The tracking service fargo.uz/track asks, as its page's configuration names it. */
export const FARGO_UZ_API = 'https://fargo.tezbor.uz/api/v1/public/order/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;
// The throttle's own wording when it sends no Retry-After: "… available in 42 seconds."
const WAIT = /(\d+)\s*second/;

export function fargoUzLookupUrl(number: string): string {
  return `${FARGO_UZ_API}${encodeURIComponent(number)}/history_items`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Fargo answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Fargo returned a reply that is not JSON', { cause });
  }
}

/** The wait a 429 names, in its header or, as the page reads it, its reply. */
function waitMs(response: Response, body: string): number | undefined {
  const header = Number(response.headers.get('retry-after'));
  if (header > 0) return header * 1000;
  try {
    const payload: unknown = JSON.parse(body);
    const seconds = isRecord(payload) && typeof payload.detail === 'string' ? Number(WAIT.exec(payload.detail)?.[1]) : Number.NaN;
    return seconds > 0 ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** The tracker's 404 for an order it does not have, as against a route that is gone. */
function missingOrder(body: string): boolean {
  try {
    const payload: unknown = JSON.parse(body);
    return isRecord(payload) && payload.status === 'error' && payload.code === 'order_not_found';
  } catch {
    return false;
  }
}

export class FargoUzTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFargoUzNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(fargoUzLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FARGO_UZ_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 429, ...GONE] });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status === 429) throw new RateLimitedError(PROVIDER, waitMs(response, body), undefined, { status: 429 });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Fargo refused the lookup', { status: 403 });
      if (response.status === 404) {
        // The page reads a missing order from the reply's code; a bare 404 is a moved route.
        if (missingOrder(body)) return parseFargoUz(JSON.parse(body), number);
        throw new TransportError(PROVIDER, 'Fargo tracking lookup is unavailable', { status: 404 });
      }
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Fargo tracking lookup is unavailable', { status: response.status });
      }
      return parseFargoUz(json(body), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fargo-uz', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FargoUzTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fargo-uz', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFargoUzNumber(number))),
  };
};
