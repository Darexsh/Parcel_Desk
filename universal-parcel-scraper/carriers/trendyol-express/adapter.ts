import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import { normalizeTrendyolNumber, parseTrendyol, PROVIDER, TRENDYOL_MAX_BYTES, trendyolTrackingUrl } from './parser.js';

export class TrendyolTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeTrendyolNumber(raw);
    if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Trendyol Express requires the browser tracking service');
    return runSteps({ carrier: 'trendyol-express', budgetMs: context.budgetMs ?? 45_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      trawlPageStep({ ...this.options, provider: PROVIDER, url: trendyolTrackingUrl(number), maxBytes: TRENDYOL_MAX_BYTES,
        contentWaitForSelector: '#delivery-state, section.not-found-wrapper',
        parse: html => parseTrendyol(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new TrendyolTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'trendyol-express', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
