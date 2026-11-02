import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTdnNumber, parseTdn, PROVIDER, TDN_MAX_BYTES } from './parser.js';

/**
 * The tracker the tracking page on tdn.es sends a number to, with the
 * parameters its form adds. It answers on plain HTTP only.
 */
export const TDN_TRACKING = 'http://tracking.tdnonline.com/consulta_expediciones/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing expedition: an unknown one gets a notice on the page.
const GONE = [404, 405, 410];

/** The page's encoding: its header names windows-1252, which the page itself calls ISO-8859-1. */
function encodingOf(response: Response): string {
  const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
  return charset === 'utf-8' || charset === 'utf8' ? 'utf-8' : 'windows-1252';
}

export class TdnTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTdnNumber(raw);
    const url = `${TDN_TRACKING}?${new URLSearchParams({ REFERENCIA: number, Aceptar: 'Aceptar' })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-ES,es;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TDN_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TDN redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'TDN tracking page is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'TDN refused the lookup', { status: 403 });
      const html = decodeText(bytes, encodingOf(response));
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'TDN returned an empty page');
      return parseTdn(html, number);
    };
    // A request that fails to reach TDN, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest. An HTTP status, a
    // rate limit included, is never sent again.
    return runSteps({ carrier: 'tdn', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TdnTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tdn', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTdnNumber(number))),
  };
};
