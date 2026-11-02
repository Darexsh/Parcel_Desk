import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseSmsaApp, SMSA_APP_ACTION, SMSA_APP_ENDPOINT, SMSA_APP_MAX_BYTES, smsaAppRequest } from './app.js';
import { normalizeSmsaNumber, parseSmsa, PROVIDER, SMSA_MAX_BYTES, SMSA_ORIGIN } from './parser.js';

// The English Saudi results page the tracking form redirects to.
export const SMSA_ENDPOINT = `${SMSA_ORIGIN}/sa/trackingdetails`;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment: an unknown number gets SMSA's own answer.
const GONE = [404, 410];

export class SmsaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSmsaNumber(raw);
    const read = async (url: string, init: RequestInit, maxBytes: number, signal: AbortSignal, timeoutMs: number): Promise<string> => {
      const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
        ...init.headers as Record<string, string>, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'SMSA sent the lookup to another address');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'SMSA tracking is unavailable at this address');
      const text = decodeText(bytes);
      if (!text.trim()) throw new IndeterminateError(PROVIDER, 'SMSA returned an empty reply');
      return text;
    };
    const app = async (signal: AbortSignal, timeoutMs: number) => parseSmsaApp(await read(SMSA_APP_ENDPOINT, {
      method: 'POST', body: smsaAppRequest(number),
      headers: { Accept: 'text/xml', 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: SMSA_APP_ACTION },
    }, SMSA_APP_MAX_BYTES, signal, timeoutMs), number);
    const page = async (signal: AbortSignal, timeoutMs: number) => parseSmsa(await read(
      `${SMSA_ENDPOINT}?${new URLSearchParams({ tracknumbers: number })}`,
      { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml' } }, SMSA_MAX_BYTES, signal, timeoutMs), number);
    // The app's service answers first. A request that fails to reach it, or
    // hangs, gets one more try; each gets half of what is left, so the page
    // still has time. The page answers after a failure, a block or an
    // inconclusive reply; never after SMSA's answer, a rate limit included.
    return runSteps({ carrier: 'smsa-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'app', run: ({ signal, remainingMs }) => app(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => app(signal, firstAttemptMs(remainingMs))),
      { id: 'direct', run: ({ signal, remainingMs }) => page(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SmsaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'smsa-express', recordsSteps: true, steps: ['app', 'retry', 'direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSmsaNumber(number))),
  };
};
