import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DOHRN_MAX_BYTES, normalizeDohrnNumber, parseDohrn, PROVIDER } from './parser.js';

/** The XML shipment trace Dohrn's API page documents, which takes a PRO without a login. */
export const DOHRN_TRACE = 'https://facts.dohrn.com/scripts/cgiip.exe/protracexml.htm';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the trace names an unknown PRO in a 200 reply.
const GONE = [404, 410];

/** The trace's address for one PRO. */
export function dohrnTraceUrl(pro: string): string {
  return `${DOHRN_TRACE}?${new URLSearchParams({ pronum: pro })}`;
}

export class DohrnTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const pro = normalizeDohrnNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(dohrnTraceUrl(pro), { signal, headers: {
        Accept: 'text/xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DOHRN_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Dohrn redirected its shipment trace');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Dohrn shipment trace is unavailable');
      // The trace labels its replies ISO-8859-1, which browsers read as windows-1252.
      const xml = decodeText(bytes, 'windows-1252');
      if (!xml.trim()) throw new IndeterminateError(PROVIDER, 'Dohrn returned an empty reply');
      return parseDohrn(xml, pro);
    };
    // A read that fails to reach Dohrn, or hangs, is sent once more: the first gets half of the budget.
    return runSteps({ carrier: 'dohrn-transfer', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DohrnTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dohrn-transfer', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDohrnNumber(number))),
  };
};
