import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EASY_MAIL_MAX_BYTES, isEasyMailBlockPage, normalizeEasyMailNumber, parseEasyMail, PROVIDER } from './parser.js';

/** Easy Mail's tracker, which the website's tracking page frames with the voucher after it. */
export const EASY_MAIL_TRACKER = 'https://trackntrace.easymail.gr/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page reads a missing voucher from a 200 reply; a 404 is a moved route.
const UNAVAILABLE = [404, 410];

export function easyMailTrackerUrl(voucher: string): string {
  return `${EASY_MAIL_TRACKER}${encodeURIComponent(voucher)}`;
}

export class EasyMailTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const voucher = normalizeEasyMailNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(easyMailTrackerUrl(voucher), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EASY_MAIL_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Easy Mail redirected its tracker');
      if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, 'Easy Mail tracker is unavailable');
      const html = decodeText(bytes);
      if (response.status === 403) {
        throw new ChallengeError(PROVIDER, isEasyMailBlockPage(html) ? 'Easy Mail answered with a block page' : 'Easy Mail refused the lookup', { status: 403 });
      }
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Easy Mail did not answer with its tracker');
      return parseEasyMail(html, voucher);
    };
    // A read that fails to reach Easy Mail, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'easy-mail', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Easy Mail, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new EasyMailTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'easy-mail', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
