import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePromptXpressNumber, parsePromptXpress, PROMPT_XPRESS_MAX_BYTES, PROMPT_XPRESS_PORTAL, PROVIDER } from './parser.js';

export { PROMPT_XPRESS_PORTAL } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the portal answers unknown numbers with a notice.
const GONE = [404, 410];

/** The portal's own address for one whole tracking number. */
export function promptXpressLookupUrl(raw: string): string {
  return `${PROMPT_XPRESS_PORTAL}?${new URLSearchParams({ trackingNo: normalizePromptXpressNumber(raw) })}`;
}

export class PromptXpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePromptXpressNumber(raw);
    const url = promptXpressLookupUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PROMPT_XPRESS_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Prompt Xpress redirected its tracking portal');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Prompt Xpress tracking portal is unavailable', { status: response.status });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Prompt Xpress returned an empty page');
      return parsePromptXpress(html, number);
    };
    // A request that fails to reach the portal, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'prompt-xpress', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PromptXpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'prompt-xpress', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePromptXpressNumber(number))),
  };
};
