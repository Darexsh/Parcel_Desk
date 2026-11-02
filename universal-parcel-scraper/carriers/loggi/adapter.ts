import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { LOGGI_MAX_BYTES, loggiTrackingUrl, normalizeLoggiNumber, parseLoggi, PROVIDER } from './parser.js';

export { loggiTrackingUrl, normalizeLoggiNumber, parseLoggi } from './parser.js';

const SERVICE_MS = 30_000;

export class LoggiTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeLoggiNumber(raw);
    const trawl = this.options.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Loggi requires the browser tracking service');
    return runSteps({ carrier: 'loggi', budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'trawl', run: async ({ signal, remainingMs }) => {
        const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - 2000));
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        const url = loggiTrackingUrl(number);
        const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs },
          { provider: `TRAWL while fetching ${PROVIDER}`, timeoutMs, signal, fetcher: this.options.fetcher, maxBytes: 3 * LOGGI_MAX_BYTES });
        signal.throwIfAborted();
        if (page.url !== url) throw new IndeterminateError(PROVIDER, 'Loggi redirected the requested tracking page');
        return parseLoggi(page.html, number);
      } },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new LoggiTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'loggi', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
