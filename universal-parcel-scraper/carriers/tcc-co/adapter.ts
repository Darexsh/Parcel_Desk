import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { normalizeTccNumber, parseTcc, PROVIDER, TCC_MAX_BYTES, tccJson } from './parser.js';

export const TCC_STATES = 'https://tccrestify-dot-tcc-cloud.appspot.com/tracking/estados';
// The same appId ships to every visitor in the official guest client's interceptor.
const APP_ID = '9f9b3215a2ae89f1964ded0ab4b83e5354ddf1dc8a656931e958a4dc3bcf37dd'; // gitleaks:allow

export class TccTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeTccNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number) => {
      const { response, bytes } = await fetchBounded(TCC_STATES, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', appId: APP_ID,
          Origin: 'https://tcc.com.co', Referer: 'https://tcc.com.co/rastreo/', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ infoadicional: '2', remesas: { numeroremesa: number } }),
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TCC_MAX_BYTES,
        redirect: 'manual', allowHttpError: true, fetcher: this.options.fetcher });
      signal.throwIfAborted();
      if (response.url && response.url !== TCC_STATES) throw new TransportError(PROVIDER, 'TCC redirected the requested tracking response');
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'TCC refused the tracking lookup', { status: response.status });
      if ([301, 302, 303, 307, 308, 404, 405, 410].includes(response.status)) throw new TransportError(PROVIDER, 'TCC tracking endpoint is unavailable', { status: response.status });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const retryAfterMs = retry === null ? undefined : /^\d+$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        // Error bodies can contain free-text observations. Preserve HTTP kind
        // and retry time without returning those fields as diagnostics.
        throw new UpstreamHttpError(PROVIDER, response.status, retryAfterMs);
      }
      return parseTcc(tccJson(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'tcc-co', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new TccTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'tcc-co', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
