import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  FRANCH_EXPRESS_LOOKUP, FRANCH_EXPRESS_MAX_BYTES, FRANCH_EXPRESS_RESULT, franchExpressToken, normalizeFranchExpressNumber, parseFranchExpress, PROVIDER,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const UNAVAILABLE = [404, 410];

export class FranchExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFranchExpressNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'franch-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  /** The AWB History form's two requests: the lookup turns the query into a token, then the page opens with it. */
  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const send = (url: string, init: RequestInit & { headers: Record<string, string> }) => fetchBounded(url, {
      ...init, signal, headers: { 'User-Agent': userAgent, ...init.headers },
    }, { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: FRANCH_EXPRESS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
    const answered = (response: Response, what: string) => {
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, `Franch Express moved its ${what}`);
      if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, `Franch Express's ${what} is unavailable`);
      if (response.status === 403) throw new ChallengeError(PROVIDER, `Franch Express refused its ${what}`, { status: 403 });
    };
    // The form serializes its field as `keyword=…` and posts that as `url`.
    const lookup = await send(FRANCH_EXPRESS_LOOKUP, { method: 'POST', headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
    }, body: new URLSearchParams({ url: `keyword=${number}` }).toString() });
    answered(lookup.response, 'tracking lookup');
    const token = franchExpressToken(decodeText(lookup.bytes));
    signal.throwIfAborted();
    const page = await send(`${FRANCH_EXPRESS_RESULT}?data=${token}`, { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml' } });
    answered(page.response, 'AWB History page');
    return parseFranchExpress(decodeText(page.bytes), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FranchExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'franch-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
