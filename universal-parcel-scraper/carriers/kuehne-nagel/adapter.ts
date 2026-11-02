import { accepted, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import {
  KUEHNE_NAGEL_MAX_BYTES, kuehneNagelOwnReference, normalizeKuehneNagelNumber, parseKuehneNagel, parseKuehneNagelSearch,
  PROVIDER, type KuehneNagelMatch,
} from './parser.js';

// The services the public tracker on mykn.kuehne-nagel.com asks: a search by
// reference, then the shipment's route and notices by the tracker's own id.
export const KUEHNE_NAGEL_ORIGIN = 'https://mykn.kuehne-nagel.com';
export const KUEHNE_NAGEL_SEARCH_URL = `${KUEHNE_NAGEL_ORIGIN}/public-tracking/internal/shipment-list`;
const SHIPMENTS_URL = `${KUEHNE_NAGEL_ORIGIN}/public-tracking/internal/shipments`;
// A web application firewall or bot check's page.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment|Attention Required)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;

export class KuehneNagelTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async json(url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    let bytes: Uint8Array;
    try {
      ({ bytes } = await fetchBounded(url, { signal,
        headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: KUEHNE_NAGEL_MAX_BYTES, fetcher: this.options.fetcher }));
    } catch (error) {
      // A missing route is not a missing shipment: the search answers an unknown reference with no results.
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
        throw new TransportError(PROVIDER, 'Kuehne+Nagel tracking service is unavailable', { cause: error });
      }
      throw error;
    }
    try { return parseJsonBytes(bytes, PROVIDER); }
    catch (cause) {
      if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Kuehne+Nagel answered with a block page', { cause });
      throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned invalid tracking JSON', { cause });
    }
  }

  private async search(number: string, signal: AbortSignal, timeoutMs: number): Promise<KuehneNagelMatch> {
    const url = `${KUEHNE_NAGEL_SEARCH_URL}?${new URLSearchParams({ query: number })}`;
    return parseKuehneNagelSearch(await this.json(url, signal, timeoutMs), number);
  }

  private async lookup(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const match = await this.search(number, signal, left());
    const shipment = `${SHIPMENTS_URL}/${encodeURIComponent(match.id)}`;
    // The page asks for the route and the notices together.
    const [routing, information] = await Promise.all([
      this.json(`${shipment}/shipment-routing`, signal, left()),
      this.json(`${shipment}/information-milestones`, signal, left()),
    ]);
    return parseKuehneNagel(routing, information, match, number);
  }

  /** Two attempts at most: the first gets half of the budget, so one after a network failure fits in the rest. */
  private run<T>(read: (signal: AbortSignal, timeoutMs: number) => Promise<T>, context: TrackingContext): Promise<T> {
    return runSteps({ carrier: 'kuehne-nagel', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }: StepContext) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKuehneNagelNumber(raw);
    return this.run((signal, timeoutMs) => this.lookup(number, signal, timeoutMs), context);
  }

  /**
   * The search alone: a shipment found under one of Kuehne+Nagel's own
   * references is known, and none is unknown. A match only under a reference
   * anyone can hold, such as a customer reference or a container, does not
   * show that the number is Kuehne+Nagel's.
   */
  async recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    if (!accepted(() => normalizeKuehneNagelNumber(raw))) return { known: false };
    const number = normalizeKuehneNagelNumber(raw);
    let match: KuehneNagelMatch;
    try {
      match = await this.run((signal, timeoutMs) => this.search(number, signal, timeoutMs), context);
    } catch (error) {
      if (carrierErrorKind(error) === 'not_found') return { known: false };
      throw error;
    }
    if (!kuehneNagelOwnReference(match)) {
      throw new IndeterminateError(PROVIDER, 'Kuehne+Nagel found the number only as a reference of another party');
    }
    return { known: true, lastActivityAt: match.lastActivityAt };
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KuehneNagelTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kuehne-nagel', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
