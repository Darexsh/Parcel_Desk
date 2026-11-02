import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeXdpNumber, normalizeXdpPostcode, parseXdp, PROVIDER } from './parser.js';

// The legacy tracker that XDP's delivery emails still link to. It lists every
// scan with its status type; the newer xdp.co.uk/track/ page shows four milestones.
const PAGE = 'https://www.xdp.co.uk/track.php';
// A page is a few kilobytes, and grows by a row per piece and scan.
const MAX_BYTES = 1024 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown consignment on its page, so a missing page
// says nothing about the consignment.
const MOVED = [...REDIRECTS, 404, 410];

/** The tracker's address for a consignment and its delivery or collection postcode. */
export function xdpTrackingUrl(raw: string, rawPostcode: string): string {
  return `${PAGE}?${new URLSearchParams({ c: normalizeXdpNumber(raw), code: normalizeXdpPostcode(rawPostcode) })}`;
}

export class XdpTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeXdpNumber(raw);
    // Without the postcode the tracker shows nothing, so no request is made.
    const url = xdpTrackingUrl(number, normalizeXdpPostcode(rawPostcode));
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: MOVED, fetcher: this.options.fetcher });
      if (MOVED.includes(response.status)) throw new IndeterminateError(PROVIDER, 'XDP tracking page moved');
      return parseXdp(decodeText(bytes), number);
    };
    // A request that fails to reach XDP, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'xdp', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XdpTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // Every lookup needs the postcode, and an unknown number and a wrong postcode
  // look alike, so the adapter cannot recognize a number alone.
  return {
    id: 'xdp', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
