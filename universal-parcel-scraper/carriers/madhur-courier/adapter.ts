import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  MADHUR_MAX_BYTES, MADHUR_TRACKER, madhurSearchFields, madhurSessionUrl, normalizeMadhurNumber, parseMadhurCourier, PROVIDER,
} from './parser.js';

export { MADHUR_TRACKER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing consignment: the tracker answers unknown C-Notes with an empty page.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;

interface Page { status: number; location: string | null; html: string }

export class MadhurCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMadhurNumber(raw);
    // One attempt opens the tracker, which sends a visitor to the page under
    // a session id in its address, and posts the C-Note back to that page as
    // its search button does. No cookie, token or browser is needed.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (url: string, init: RequestInit): Promise<Page> => {
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: MADHUR_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Madhur tracker is unavailable', { status: response.status });
        return { status: response.status, location: response.headers.get('location'), html: decodeText(bytes) };
      };
      const page = (url: string, init: RequestInit) => read(url, init).then((reply) => {
        if (REDIRECTS.includes(reply.status)) throw new TransportError(PROVIDER, 'Madhur redirected its tracker', { status: reply.status });
        if (!reply.html.trim()) throw new IndeterminateError(PROVIDER, 'Madhur returned an empty page');
        return reply.html;
      });
      const entry = await read(MADHUR_TRACKER, { method: 'GET', headers });
      const url = REDIRECTS.includes(entry.status) ? madhurSessionUrl(entry.location) : MADHUR_TRACKER;
      const form = url === MADHUR_TRACKER ? entry.html : await page(url, { method: 'GET', headers });
      const answer = await page(url, { method: 'POST', body: madhurSearchFields(form, number).toString(),
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: url } });
      return parseMadhurCourier(answer, number);
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'madhur-courier', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MadhurCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'madhur-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
