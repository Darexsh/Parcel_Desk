import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CORRE_MAX_BYTES, normalizeCorreNumber, parseCorre, PROVIDER } from './parser.js';

/** The national lookup the Track & Trace page on corremz.com opens for one code. */
export const CORRE_TRACKER = 'https://www.corremz.com/cgi-bin/tracktrace.cgi';
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup answers an unknown code on its page: a missing route is not a missing item.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one code. */
export function correLookupUrl(number: string): string {
  return `${CORRE_TRACKER}?${new URLSearchParams({ OBJ: number })}`;
}

/** The page names no charset: UTF-8 when it decodes as such, else the windows-1252 of the site's other pages. */
function pageText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeText(bytes, 'windows-1252');
  }
}

export class CorreTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(correLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CORRE_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'CORRE’s tracking lookup is unavailable', { status: response.status });
      }
      const html = pageText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'CORRE returned an empty page');
      return parseCorre(html, number);
    };
    // A lookup that fails to reach the site, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'corre', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'corre', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCorreNumber(number))),
  };
};
