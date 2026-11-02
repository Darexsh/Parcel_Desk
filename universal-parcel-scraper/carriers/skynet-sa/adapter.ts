import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { readBlazorPage } from '../../core/transport/blazorCircuit.js';
import { normalizeSkynetSaNumber, parseSkynetSa, PROVIDER, skynetSaPageState } from './parser.js';

/** SkyTrack, the tracker SkyNet's WooCommerce plugin links each booked waybill to. */
export const SKYNET_SA_TRACKER = 'https://web.skynet.co.za:5002/';
/** The app's SignalR hub, which renders its pages. */
export const SKYNET_SA_HUB = `${SKYNET_SA_TRACKER}_blazor`;

/** The tracking page for one waybill, which looks it up as it opens. */
export function skynetSaPageUrl(number: string): string {
  return `${SKYNET_SA_TRACKER}T?R=${normalizeSkynetSaNumber(number)}`;
}

// The shell is under fifty kilobytes.
const SHELL_MAX_BYTES = 512 * 1024;

export class SkynetSaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSkynetSaNumber(raw);
    return runSteps({ carrier: 'skynet-sa', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => readBlazorPage({
        provider: PROVIDER, name: 'SkyNet South Africa', app: SKYNET_SA_TRACKER, page: skynetSaPageUrl(number),
        shellMaxBytes: SHELL_MAX_BYTES, componentState: true,
        fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal, deadline: performance.now() + remainingMs,
        // The page's scripts set up its widgets and focus, and none of their results matters to the lookup. It looks
        // the waybill up as it opens, so a move elsewhere is not its answer.
        answer: ({ page, roots, started }) => {
          const html = roots.map((root) => page.html(root)).join('');
          const state = skynetSaPageState(html, number);
          // The not-found line counts once the page has opened, not while it loads.
          return state === 'shipment' || (state === 'not_found' && started) ? parseSkynetSa(html, number) : undefined;
        },
      }) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkynetSaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'skynet-sa', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
