import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isUpayaBlockPage, normalizeUpayaNumber, parseUpaya, PROVIDER, UPAYA_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on upaya.com.np makes for the code typed in. */
export const UPAYA_API = 'https://upaya.com.np/wp-json/upaya-tracking/v1/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The reply's JSON, or the error a body that is not JSON stands for. */
function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isUpayaBlockPage(body)) throw new ChallengeError(PROVIDER, 'Upaya answered with a browser check', { cause, status });
    if (GONE.includes(status)) throw new TransportError(PROVIDER, 'Upaya tracking lookup is unavailable', { cause, status });
    throw new SchemaError(PROVIDER, 'Upaya returned a reply that is not JSON', { cause, status });
  }
}

export class UpayaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${UPAYA_API}?code=${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: UPAYA_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, ...GONE] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Upaya redirected its tracking lookup', { status: response.status });
    const body = decodeText(bytes);
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Upaya refused the lookup', { status: 403 });
    const payload = json(body, response.status);
    const error = isRecord(payload) && payload.ok === false ? payload.error : undefined;
    // The lookup answers an unknown code with HTTP 404 and `uot_not_found`; another 404 is a moved route.
    if (GONE.includes(response.status) && error !== 'uot_not_found') {
      throw new TransportError(PROVIDER, 'Upaya tracking lookup is unavailable', { status: response.status });
    }
    // A code it does not read as one gets HTTP 400 and `invalid_code`; another 400 is a changed request.
    if (response.status === 400 && error !== 'invalid_code') throw new SchemaError(PROVIDER, 'Upaya refused the request', { status: 400 });
    return parseUpaya(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeUpayaNumber(raw);
    // A read that fails to reach Upaya, or hangs, is sent once more: the first
    // try gets half of the budget.
    return runSteps({ carrier: 'upaya', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new UpayaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'upaya', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeUpayaNumber(number))),
  };
};
