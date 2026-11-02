import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NoHistoryError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTaqbinHkWaybill, PROVIDER, TAQBIN_HK_MAX_BYTES, taqbinHkWaybill } from './parser.js';

/** The endpoint and request builder in the official Hong Kong waybill widget. */
export const TAQBIN_HK_PAGE = 'https://delivery.message.sg/YTHKtracking/';
export const TAQBIN_HK_API = 'https://delivery.message.sg/YTHKws/wsWebsite.asmx/external_waybill_fetchStatusLog';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|Incapsula incident|Request unsuccessful|_Incapsula_Resource|acw_sc__v2|aliyun_waf|_____tmd_____/i;

function json(body: string): unknown {
  try { return JSON.parse(body); }
  catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TA-Q-BIN Hong Kong answered with a browser check');
    throw new SchemaError(PROVIDER, 'TA-Q-BIN Hong Kong returned a reply that is not JSON');
  }
}

export class TaqbinHkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = taqbinHkWaybill(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      if (!number) throw new NoHistoryError(PROVIDER, 'TA-Q-BIN Hong Kong e-commerce parcels need an enabled provider', { reason: 'unsupported_service' });
      const { response, bytes } = await fetchBounded(TAQBIN_HK_API, { method: 'POST', signal,
        body: JSON.stringify({ keyTrackingNumber: number }), headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TAQBIN_HK_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // An unknown waybill gets HTTP 200 with an empty array. Other routes are no answer about it.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'TA-Q-BIN Hong Kong waybill lookup moved', { status: response.status });
      return parseTaqbinHkWaybill(json(decodeText(bytes)));
    };
    return runSteps({ carrier: 'taqbin-hk', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TaqbinHkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'taqbin-hk', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
