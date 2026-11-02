import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchOldDominionInBrowser } from './browser.js';
import { normalizeOldDominionNumber } from './parser.js';

export { normalizeOldDominionNumber, oldDominionPro, oldDominionTraceUrl, parseOldDominionReply } from './parser.js';
export type { OldDominionReply } from './parser.js';

const DEFAULT_BUDGET_MS = 45_000;
/** The shared local browser serves one lookup for at most a minute. */
const BROWSER_LIMIT_MS = 60_000;

export interface OldDominionTrackerOptions {
  /** A local Chromium; the trace service answers only the page's own verified calls. */
  executablePath?: string | null;
  recorder?: StepRecorder;
}

export class OldDominionTracker {
  readonly #executablePath: string | null;
  readonly #recorder: StepRecorder;

  constructor(options: OldDominionTrackerOptions = {}) {
    this.#executablePath = options.executablePath ?? null;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOldDominionNumber(raw);
    const executablePath = this.#executablePath;
    if (!executablePath) throw new ChallengeError('Old Dominion', 'Old Dominion requires TRACKING_CHROMIUM_PATH');
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Old Dominion budget must be positive');
    return runSteps<CarrierResult>({ carrier: 'old-dominion', budgetMs, signal: context.signal, recorder: this.#recorder }, [
      { id: 'browser', run: ({ signal, remainingMs }) => fetchOldDominionInBrowser(number, executablePath, signal,
        Math.min(BROWSER_LIMIT_MS, Math.max(1, Math.floor(remainingMs)))) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OldDominionTracker({ executablePath: environment.browserExecutablePath, recorder: environment.recorder });
  return { id: 'old-dominion', recordsSteps: true, steps: ['browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
