import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSeflNumber, parseSefl, PROVIDER, SEFL_MAX_BYTES } from './parser.js';

/** SEFL's Web Connect tracing service, which its tracer's live tracing links open. */
export const SEFL_TRACING = 'https://www.sefl.com/webconnect/tracing';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The service's address for one PRO, in its XML form. */
export function seflTracingUrl(pro: string): string {
  return `${SEFL_TRACING}?${new URLSearchParams({ Type: 'PN', RefNum1: pro, output: 'XML' })}`;
}

export class SeflTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const pro = normalizeSeflNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(seflTracingUrl(pro), { signal, headers: {
        Accept: 'text/xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SEFL_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The service names an unknown PRO in a 200 reply: a redirect or a 404 is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'Southeastern Freight Lines tracing service moved');
      // The service labels its replies ISO-8859-1, which browsers read as windows-1252.
      return parseSefl(decodeText(bytes, 'windows-1252'), pro);
    };
    // A read that fails to reach SEFL, or hangs, is sent once more: the first gets half of the budget.
    return runSteps({ carrier: 'southeastern-freight-lines', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SeflTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'southeastern-freight-lines', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSeflNumber(number))),
  };
};
