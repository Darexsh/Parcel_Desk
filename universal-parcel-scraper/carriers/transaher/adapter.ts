import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { readBlazorPage } from '../../core/transport/blazorCircuit.js';
import { normalizeTransaherNumber, parseTransaher, PROVIDER, transaherPageState } from './parser.js';

/** The tracker's app, which the tracking box on transaher.es opens. */
export const TRANSAHER_TRACKER = 'https://clientes.transaher.es/webclient/';
/** The app's SignalR hub, which renders its pages. */
export const TRANSAHER_HUB = `${TRANSAHER_TRACKER}_blazor`;

/** The tracking page for one number, where the box's `htracking` link moves after checking the device. */
export function transaherPageUrl(number: string): string {
  return `${TRANSAHER_TRACKER}tracking/-5,0,${normalizeTransaherNumber(number)}`;
}

// The shell is under two kilobytes.
const SHELL_MAX_BYTES = 256 * 1024;
const TRACKING_ROUTE = /^https:\/\/clientes\.transaher\.es\/webclient\/h?tracking\/-5,0,\d+$/;

export class TransaherTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTransaherNumber(raw);
    return runSteps({ carrier: 'transaher', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => readBlazorPage({
        provider: PROVIDER, name: 'Transaher', app: TRANSAHER_TRACKER, page: transaherPageUrl(number), shellMaxBytes: SHELL_MAX_BYTES,
        fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal, deadline: performance.now() + remainingMs,
        // The page asks whether it runs on a phone, and leaves a desktop on its tracking route.
        scripts: { isDevice: false },
        // The page may move to its own address again; any other page is not the tracker's answer.
        follows: (target) => TRACKING_ROUTE.test(target) && target.endsWith(`,${number}`),
        answer: ({ page, roots, started }) => {
          const html = roots.length ? page.html(roots[0]!) : '';
          const state = transaherPageState(html);
          // The unknown number's sentence counts once the page has opened, not while it loads.
          return state === 'shipment' || (state === 'not_found' && started) ? parseTransaher(html, number) : undefined;
        },
      }) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TransaherTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'transaher', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTransaherNumber(number))),
  };
};
