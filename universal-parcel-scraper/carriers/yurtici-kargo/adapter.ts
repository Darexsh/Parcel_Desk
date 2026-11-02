import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeYurticiNumber, parseYurtici, parseYurticiSearch, PROVIDER, YURTICI_MAX_BYTES } from './parser.js';

// The tracker on www.yurticikargo.com/en/online-servisler/gonderi-sorgula reads these
// anonymously: a search for the code, then the shipment's details, then its movements.
const SERVICE = 'https://www.yurticikargo.com/service';
export const YURTICI_SEARCH_URL = `${SERVICE}/shipmentstrackingsearch`;
export const YURTICI_DETAIL_URL = `${SERVICE}/shipmentstracking`;
export const YURTICI_MOVEMENT_URL = `${SERVICE}/shipmenttrackingmovement`;

/** The firewall in front of www.yurticikargo.com rejects a request with an HTML page. */
function rejected(bytes: Uint8Array): boolean {
  return /Request Rejected|The requested URL was rejected/i.test(decodeText(bytes.subarray(0, 4_000)));
}

export class YurticiKargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeYurticiNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Yurtiçi Kargo budget must be a positive number of milliseconds');
    return runSteps({ carrier: 'yurtici-kargo', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: step => this.lookup(number, step) },
    ]);
  }

  private async lookup(number: string, { signal, remainingMs }: StepContext): Promise<CarrierResult> {
    const deadline = performance.now() + remainingMs;
    const get = (url: string, id: string) => this.get(url, id, signal, Math.max(1, Math.floor(deadline - performance.now())));
    const search = parseYurticiSearch(await get(YURTICI_SEARCH_URL, number), number);
    const detail = await get(YURTICI_DETAIL_URL, search.id);
    // The tracker lists movements until the parcel is delivered or returned, and only asks then.
    const movements = isOpen(detail) ? await get(YURTICI_MOVEMENT_URL, number) : undefined;
    return parseYurtici(detail, movements, number, search);
  }

  private async get(url: string, id: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    signal.throwIfAborted();
    let bytes: Uint8Array;
    try {
      ({ bytes } = await fetchBounded(`${url}?${new URLSearchParams({ id, language: 'en' })}`,
        { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs, maxBytes: YURTICI_MAX_BYTES, fetcher: this.options.fetcher, retryTransient: true }));
    } catch (error) {
      // A missing route is not a missing shipment.
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'Yurtiçi Kargo tracking service is unavailable', { cause: error });
      }
      throw error;
    }
    try { return parseJsonBytes(bytes, PROVIDER); }
    catch (cause) {
      if (rejected(bytes)) throw new ChallengeError(PROVIDER, 'Yurtiçi Kargo rejected the tracking request', { cause });
      throw new SchemaError(PROVIDER, 'Yurtiçi Kargo returned invalid tracking JSON', { cause });
    }
  }
}

/** Details of a parcel not yet delivered or returned, whose movements the tracker lists. */
function isOpen(detail: unknown): boolean {
  return isRecord(detail) && detail.IsDelivered === false && detail.ErrorMessage === undefined;
}

export const adapter: AdapterFactory = environment => {
  const tracker = new YurticiKargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'yurtici-kargo', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeYurticiNumber(number))) };
};
