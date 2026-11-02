import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  JETLINE_MAX_BYTES, JETLINE_TRACKER, jetlineAnswerUrl, jetlineHistoryFields, jetlineSearchFields, normalizeJetlineNumber,
  parseJetlineCouriers, PROVIDER, unexpectedPage,
} from './parser.js';

export { JETLINE_TRACKER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the tracker answers unknown numbers with an alert.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;
const FORM_TYPE = 'application/x-www-form-urlencoded';

interface Page { status: number; location: string | null; html: string }

export class JetlineCouriersTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJetlineNumber(raw);
    // One attempt opens the home page, posts the number back to it as its track
    // button does, opens the answer page the post redirects to and posts that
    // page's history link back. No cookie, token or browser is needed.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (url: string, init: RequestInit): Promise<Page> => {
        const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: JETLINE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Jetline tracker is unavailable', { status: response.status });
        return { status: response.status, location: response.headers.get('location'), html: decodeText(bytes) };
      };
      const page = (url: string, init: RequestInit) => read(url, init).then((reply) => {
        if (REDIRECTS.includes(reply.status)) throw new TransportError(PROVIDER, 'Jetline redirected its tracker', { status: reply.status });
        return reply.html.trim() ? reply.html : unexpectedPage(reply.html, 'Jetline returned an empty page');
      });
      const form = await page(JETLINE_TRACKER, { method: 'GET', headers });
      const posted = await read(JETLINE_TRACKER, { method: 'POST', body: jetlineSearchFields(form, number).toString(),
        headers: { ...headers, 'Content-Type': FORM_TYPE, Referer: JETLINE_TRACKER } });
      if (!REDIRECTS.includes(posted.status)) unexpectedPage(posted.html, 'Jetline did not open its answer page');
      const url = jetlineAnswerUrl(posted.location);
      const summary = await page(url, { method: 'GET', headers: { ...headers, Referer: JETLINE_TRACKER } });
      const history = await page(url, { method: 'POST', body: jetlineHistoryFields(summary, number).toString(),
        headers: { ...headers, 'Content-Type': FORM_TYPE, Referer: url } });
      return parseJetlineCouriers(history, number);
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'jetline-couriers', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JetlineCouriersTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jetline-couriers', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
