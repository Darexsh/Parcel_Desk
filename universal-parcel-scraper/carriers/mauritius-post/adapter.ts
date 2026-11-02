import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  MAURITIUS_POST_MAX_BYTES, mauritiusPostBlock, mauritiusPostUrl, normalizeMauritiusPostNumber, parseMauritiusPost, PROVIDER,
} from './parser.js';

export { MAURITIUS_POST_TRACKING } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item.
const GONE = [404, 410];
// The site's firewall answers a block or a rate limit with 503, like an outage.
const UNAVAILABLE = 503;
// The page takes several seconds to look an item up.
const DEFAULT_BUDGET_MS = 30_000;

export class MauritiusPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(mauritiusPostUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAURITIUS_POST_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, UNAVAILABLE] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Mauritius Post tracking page is unavailable', { status: response.status });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Mauritius Post redirected its tracking page', { status: response.status });
    const html = decodeText(bytes);
    if (response.status === UNAVAILABLE) throw mauritiusPostBlock(html) ?? new UpstreamHttpError(PROVIDER, UNAVAILABLE);
    return parseMauritiusPost(html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMauritiusPostNumber(raw);
    // One GET of the tracking page, which looks the number up on the server. A
    // read that fails to reach the site, or hangs, is sent once more: the first
    // try gets half of the budget.
    return runSteps({ carrier: 'mauritius-post', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MauritiusPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mauritius-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
