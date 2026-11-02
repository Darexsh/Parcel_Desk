import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, CarrierError, ChallengeError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { CITI_MAX_BYTES, CITI_PAGE, citiForm, normalizeCitiNumber, parseCiti, PROVIDER } from './parser.js';

export class CitilogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCitiNumber(raw);
    const attempt = async (signal: AbortSignal, budget: number) => {
      const start = performance.now(), session = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
      const read = async (url: string) => {
        const left = Math.floor(budget - (performance.now() - start));
        if (left < 1) throw new BudgetExceededError(PROVIDER, left);
        let reply: Awaited<ReturnType<typeof fetchBounded>>;
        try {
          reply = await fetchBounded(url, { signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html' } }, {
            provider: PROVIDER, timeoutMs: left, maxBytes: CITI_MAX_BYTES, redirect: 'manual', allowHttpError: true, fetcher: session });
        } catch (error) {
          signal.throwIfAborted();
          // The request URL and cookie jar carry guest form state. Preserve the
          // network marker for retry without retaining credentials in causes.
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, undefined);
          if (error instanceof CarrierError) throw new CarrierError(error.kind, PROVIDER, 'Citilogistics could not read its guest tracker', {
            status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
          throw new TransportError(PROVIDER, 'Citilogistics could not read its guest tracker');
        }
        signal.throwIfAborted();
        const { response, bytes } = reply;
        if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Citilogistics refused its guest tracker', { status: response.status });
        if ([301, 302, 303, 307, 308, 404, 405, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Citilogistics guest endpoint is unavailable', { status: response.status });
        if (!response.ok) {
          const retry = response.headers.get('retry-after');
          const delay = retry === null ? undefined : /^\d+$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          throw new UpstreamHttpError(PROVIDER, response.status, Number.isFinite(delay) ? Math.max(0, delay!) : undefined);
        }
        return decodeText(bytes);
      };
      const { nonce } = citiForm(await read(CITI_PAGE));
      const url = new URL(CITI_PAGE); url.search = new URLSearchParams({ n: nonce, trackid: number }).toString();
      return parseCiti(await read(url.href), number);
    };
    return runSteps({ carrier: 'citilogistics', signal: context.signal, budgetMs: context.budgetMs ?? 20_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      // Restart the entire guest flow with a new cookie jar and nonce.
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CitilogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'citilogistics', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
