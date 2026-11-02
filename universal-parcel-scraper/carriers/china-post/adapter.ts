import { accepted, lookupBudget, recognizeFromLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, NoHistoryError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { recoverableByDefault, runSteps } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { userAgentOf } from '../../core/transport/index.js';
import { readChinaPostTraces } from './app.js';
import { normalizeChinaPostNumber, parseChinaPostTraces, PROVIDER } from './parser.js';
import { CHINA_POST_WEB, CHINA_POST_WEB_FLAG, CHINA_POST_WEB_TRACE, parseChinaPostWebPreview } from './web.js';

const BUDGET_MS = 15_000;

export class ChinaPostTracker {
  readonly #userAgent: string;

  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; trawl?: AdapterEnvironment['trawl']; recorder?: StepRecorder } = {}) {
    this.#userAgent = userAgentOf(options.userAgent);
  }

  async direct(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChinaPostNumber(raw);
    const budget = lookupBudget(context, BUDGET_MS, PROVIDER);
    const payload = await readChinaPostTraces(number, { fetcher: this.options.fetcher, userAgent: this.#userAgent,
      budget, callerSignal: context.signal });
    return parseChinaPostTraces(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChinaPostNumber(raw);
    const budgetMs = context.budgetMs ?? (this.options.trawl ? 60_000 : BUDGET_MS);
    const failed = (error: unknown, signal: AbortSignal): never => {
      context.signal?.throwIfAborted();
      if (signal.aborted) throw new BudgetExceededError(PROVIDER, budgetMs);
      throw error;
    };
    return runSteps({ carrier: 'china-post', budgetMs,
      signal: context.signal, recorder: this.options.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.direct(number, { signal, budgetMs: remainingMs }).catch(error => failed(error, signal)) },
      { id: 'trawl', enabled: !!this.options.trawl,
        // The app can also give "no information" for mail the web preview holds.
        // Neither answer prevents the anonymous site from checking the number.
        recovers: error => error instanceof NoHistoryError || carrierErrorKind(error) === 'input_required'
          || (carrierErrorKind(error) !== 'indeterminate' && recoverableByDefault(error)),
        run: async ({ signal, remainingMs }) => {
          const timeoutMs = Math.max(1, Math.floor(remainingMs - 2500));
          const page = await this.options.trawl!.scrape({ url: `${CHINA_POST_WEB}?mailNo=${number}`, skipHttp: true, maxTier: 3,
            maxTimeout: timeoutMs, captureResponses: [CHINA_POST_WEB_FLAG, CHINA_POST_WEB_TRACE] },
          { provider: PROVIDER, timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 4_000_000 }).catch(error => failed(error, signal));
          if (signal.aborted) failed(signal.reason, signal);
          return parseChinaPostWebPreview(page, number);
        } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ChinaPostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent,
    trawl: environment.trawl, recorder: environment.recorder });
  // Recognition asks the check step alone, through the step runner so its requests are recorded.
  const check = new ChinaPostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return {
    id: 'china-post',
    recordsSteps: true,
    steps: ['direct', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: async (number, context) => {
      try {
        return await recognizeFromLookup(() => check.fetch(number, context), () => accepted(() => normalizeChinaPostNumber(number)));
      } catch (error) {
        // The check step asks for a contact phone's digits only about an item China Post holds;
        // other numbers get its "no information" answer, which stays inconclusive.
        if (carrierErrorKind(error) === 'input_required') return { known: true, lastActivityAt: null };
        throw error;
      }
    },
  };
};
