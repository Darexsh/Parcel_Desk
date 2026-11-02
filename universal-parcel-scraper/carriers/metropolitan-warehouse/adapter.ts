import { accepted, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  METROPOLITAN_WAREHOUSE_MAX_BYTES, metropolitanWarehouseDetailsPath, metropolitanWarehouseKnows, normalizeMetropolitanWarehouseNumber,
  parseMetropolitanWarehouse, PROVIDER,
} from './parser.js';

const ORIGIN = 'https://main.gomwd.com';
/** The tracker's check that it holds an order under the number typed in. */
export const METROPOLITAN_WAREHOUSE_CHECK = `${ORIGIN}/Client/CheckTrackingId`;
/** The tracker's link to the order's page, under a key it issues for the number. */
export const METROPOLITAN_WAREHOUSE_LINK = `${ORIGIN}/Client/TrackOrderWix_encryptUrl`;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing order.
const GONE = [404, 410];

export class MetropolitanWarehouseTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One GET as the tracker's script makes it; a redirect or a missing route is a moved tracker. */
  private async get(url: string, signal: AbortSignal, timeoutMs: number, accept: string): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: accept, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: METROPOLITAN_WAREHOUSE_MAX_BYTES,
      redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Metropolitan Warehouse tracking is unavailable');
    return decodeText(bytes);
  }

  /** Whether the tracker holds an order under the number. */
  private async knows(number: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    const url = `${METROPOLITAN_WAREHOUSE_CHECK}?${new URLSearchParams({ trackid: number })}`;
    return metropolitanWarehouseKnows(await this.get(url, signal, timeoutMs, 'application/json, text/javascript, */*; q=0.01'));
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMetropolitanWarehouseNumber(raw);
    // The tracker checks the number, then asks for the link to the order's
    // page and opens it. The page fails with HTTP 500 for a number the
    // tracker does not hold, so only the check tells a missing order.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      if (!await this.knows(number, signal, left())) throw new NotFoundError(PROVIDER);
      const link = `${METROPOLITAN_WAREHOUSE_LINK}?${new URLSearchParams({ trackingid: number })}`;
      const path = metropolitanWarehouseDetailsPath(await this.get(link, signal, left(), '*/*'));
      return parseMetropolitanWarehouse(await this.get(`${ORIGIN}${path}`, signal, left(), 'text/html,application/xhtml+xml'), number);
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more:
    // the first gets half of the budget, so the retry fits in the rest. An
    // HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'metropolitan-warehouse', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }

  /** The tracker's own check: an order it holds is known, without a date. */
  async recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    if (!accepted(() => normalizeMetropolitanWarehouseNumber(raw))) return { known: false };
    const number = normalizeMetropolitanWarehouseNumber(raw);
    const known = await runSteps({ carrier: 'metropolitan-warehouse', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.knows(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.knows(number, signal, remainingMs)),
    ]);
    return known ? { known: true, lastActivityAt: null } : { known: false };
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MetropolitanWarehouseTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'metropolitan-warehouse', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
