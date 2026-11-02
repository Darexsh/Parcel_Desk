import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isTirupatiChallenge, normalizeTirupatiNumber, parseTirupati, PROVIDER, TIRUPATI_HEADER, TIRUPATI_MAX_BYTES, tirupatiDetailUrl,
  tirupatiLookupFields, tirupatiRedirected,
} from './parser.js';

export { TIRUPATI_DETAIL, TIRUPATI_HEADER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

/**
 * The same failure without the request details fetchBounded attaches: the
 * tracking detail's address carries the encrypted number, which opens the
 * parcel's page.
 */
function withoutRequest(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class TirupatiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTirupatiNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'tirupati-courier', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /**
   * The header's tracking box, its post back with the number, and the
   * tracking detail the answer points to. None needs a cookie, a captcha or a
   * browser.
   */
  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const send = (url: string, init: RequestInit & { headers?: Record<string, string> }) => fetchBounded(url, {
      ...init, signal, headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent, ...init.headers },
    }, { provider: PROVIDER, timeoutMs: left(), maxBytes: TIRUPATI_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    const page = (response: Response, bytes: Uint8Array, what: string): string => {
      const body = decodeText(bytes);
      if (response.status === 403) {
        throw new ChallengeError(PROVIDER, isTirupatiChallenge(body) ? `Shree Tirupati Courier answered its ${what} with a browser check`
          : `Shree Tirupati Courier refused its ${what}`, { status: 403 });
      }
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, `Shree Tirupati Courier's ${what} is unavailable`);
      return body;
    };
    try {
      const header = await send(TIRUPATI_HEADER, { method: 'GET' });
      if (REDIRECTS.includes(header.response.status)) tirupatiRedirected(header.response.headers.get('location'), 'tracking box');
      const fields = tirupatiLookupFields(page(header.response, header.bytes, 'tracking box'), number);
      signal.throwIfAborted();
      const lookup = await send(TIRUPATI_HEADER, { method: 'POST', body: fields.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!REDIRECTS.includes(lookup.response.status)) {
        const body = page(lookup.response, lookup.bytes, 'tracking lookup');
        if (isTirupatiChallenge(body)) throw new ChallengeError(PROVIDER, 'Shree Tirupati Courier answered with a browser check');
        // The box answers a post it does not take with itself again.
        throw new SchemaError(PROVIDER, 'Shree Tirupati Courier did not take the tracking lookup');
      }
      const url = tirupatiDetailUrl(lookup.response.headers.get('location'));
      signal.throwIfAborted();
      const detail = await send(url, { method: 'GET' });
      if (REDIRECTS.includes(detail.response.status)) tirupatiRedirected(detail.response.headers.get('location'), 'tracking detail');
      return parseTirupati(page(detail.response, detail.bytes, 'tracking detail'), number);
    } catch (error) {
      throw withoutRequest(error);
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TirupatiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tirupati-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTirupatiNumber(number))),
  };
};
