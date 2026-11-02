import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePackManNumber } from './number.js';
import { isPackManBlockPage, PACK_MAN_MAX_BYTES, parsePackMan, PROVIDER } from './parser.js';

/** Pack-Man's search page, whose form sends the voucher back to it as `code`. */
export const PACK_MAN_SEARCH = 'https://pack-man.gr/anazitisi-apostolis.html';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page reads a missing voucher from a 200 reply; a 404 is a moved route.
const UNAVAILABLE = [404, 410];

export function packManSearchUrl(voucher: string): string {
  return `${PACK_MAN_SEARCH}?code=${encodeURIComponent(voucher)}`;
}

export class PackManTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const voucher = normalizePackManNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(packManSearchUrl(voucher), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PACK_MAN_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Pack-Man redirected its search page');
      if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, 'Pack-Man search page is unavailable');
      const html = decodeText(bytes);
      if (response.status === 403) {
        throw new ChallengeError(PROVIDER, isPackManBlockPage(html) ? 'Pack-Man answered with a block page' : 'Pack-Man refused the lookup', { status: 403 });
      }
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Pack-Man did not answer with its search page');
      return parsePackMan(html, voucher);
    };
    // A read that fails to reach Pack-Man, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pack-man', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PackManTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pack-man', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePackManNumber(number))),
  };
};
