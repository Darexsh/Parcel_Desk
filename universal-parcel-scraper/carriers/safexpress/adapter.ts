import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeSafexpressNumber, parseSafexpress, PROVIDER } from './parser.js';

const BASE = 'https://dgapi.safexpress.com/sfxweb/waybillinvoicetracking/v1/';
const UNAVAILABLE = [301, 302, 303, 307, 308, 404, 410];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|captcha|<title>\s*(?:403 )?Forbidden/i;

function json(bytes: Uint8Array): unknown {
  const text = decodeText(bytes).replace(/^\uFEFF/, '');
  try { return JSON.parse(text); } catch {
    if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER, 'Safexpress answered with a browser check');
    throw new SchemaError(PROVIDER, 'Safexpress returned a reply that is not JSON');
  }
}

/** Remove issued guest tokens, request bodies and upstream diagnostics before telemetry sees a failure. */
function privateError(error: unknown): unknown {
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(PROVIDER, undefined);
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
  if (error instanceof CarrierError) return new CarrierError(error.kind, PROVIDER, 'Safexpress could not read its guest tracker', {
    status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason });
  return new TransportError(PROVIDER, 'Safexpress could not read its guest tracker');
}

export class SafexpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSafexpressNumber(raw);
    const attempt = async (signal: AbortSignal, budgetMs: number) => {
      const deadline = performance.now() + budgetMs;
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(budgetMs)))]);
      const send = async (path: string, init: RequestInit = {}) => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new UpstreamNetworkError(PROVIDER, undefined);
        try {
          const reply = await fetchBounded(`${BASE}${path}`, { ...init, signal: attemptSignal, headers: {
            Accept: 'application/json', Origin: 'https://www.safexpress.com', Referer: 'https://www.safexpress.com/',
            'User-Agent': userAgentOf(this.options.userAgent), ...init.headers,
          } }, { provider: PROVIDER, timeoutMs: remaining, maxBytes: 1_000_000, redirect: 'manual',
            fetcher: this.options.fetcher, allowHttpStatuses: UNAVAILABLE });
          if (UNAVAILABLE.includes(reply.response.status)) throw new TransportError(PROVIDER, 'Safexpress tracking endpoint is unavailable', { status: reply.response.status });
          return json(reply.bytes);
        } catch (error) { throw privateError(error); }
      };
      const bootstrap = await send('getpropeliauth2token');
      if (!isRecord(bootstrap)) throw new SchemaError(PROVIDER);
      if (bootstrap.result !== 'success') throw new IndeterminateError(PROVIDER, 'Safexpress could not open guest tracking');
      const token = bootstrap.msg;
      if (typeof token !== 'string' || token.length > 8_192 || !/^[A-Za-z0-9._~-]+$/.test(token)) throw new SchemaError(PROVIDER);
      const payload = await send('trackingbytype', { method: 'POST', headers: { 'Content-Type': 'application/json', token },
        body: JSON.stringify({ docNo: [number], docType: 'WB' }) });
      return parseSafexpress(payload, number);
    };
    return runSteps({ carrier: 'safexpress', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      // A failed token-bound lookup starts again with a fresh guest token.
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SafexpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'safexpress', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
