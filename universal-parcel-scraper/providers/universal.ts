/**
 * The universal discovery chain: what runs when no dedicated carrier adapter
 * can answer for a parcel.
 *
 * Default order is ParcelsApp -> Ship24 -> 17TRACK -> UPU, with Postal Ninja after
 * the other aggregators only when the host enables it. A carrier with coverage
 * evidence (coverage.ts) gets its own order: fuller history first, HTTP before the
 * browser service within a tier, providers that answered with another parcel,
 * refused the format or keep the carrier for their subscribers left out, Postal
 * Ninja still after the other aggregators and only if the evidence shows its history. Validated China Post C/L numbers put
 * 17TRACK first and ten-digit numbers Ship24, unless the carrier left it out.
 * Each provider is asked once per lookup and the first usable history wins; the
 * per-parcel router remembers which provider answered, except UPU stays last
 * and requires a postal S10. The source names are persisted in routing state and must not change.
 *
 * This module owns the order and the aggregate failure; every protocol detail
 * lives in the provider folder next to it.
 */
import type { AdapterEnvironment, CarrierAdapter, TrackingContext } from '../core/adapter/index.js';
import { normalizeTrackingNumber } from '../core/detection/normalize.js';
import { isPlaceholderNumber } from '../core/detection/placeholder.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../core/detection/usps.js';
import { BudgetExceededError, IndeterminateError, InvalidInputError, NoHistoryError } from '../core/errors/index.js';
import type { CarrierResult } from '../core/result/index.js';
import { readLateRegistrations } from '../core/result/registration.js';
import { withoutRepeatedScans } from '../core/result/repeats.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/index.js';
import { adapter as parcelsAppAdapter } from './parcelsapp/adapter.js';
import { adapter as postalNinjaAdapter } from './postal-ninja/adapter.js';
import { adapter as seventeenTrackAdapter } from './seventeentrack/adapter.js';
import { adapter as ship24Adapter } from './ship24/adapter.js';
import { adapter as track718Adapter } from './track718/adapter.js';

import { adapter as track123Adapter } from './track123/adapter.js';
import { adapter as upuAdapter } from './upu/adapter.js';
import { numberOf, type UniversalSource as Source } from './shared/result.js';

export { parse17TrackResponse, SeventeenTrackLookupError, SeventeenTrackNoHistoryError, SeventeenTrackQuotaError, SeventeenTrackVerificationError } from './seventeentrack/adapter.js';
export { parseParcelsAppHtml, parseParcelsAppResponse } from './parcelsapp/adapter.js';
export { parsePostalNinjaResponse } from './postal-ninja/adapter.js';
export { parseShip24Response } from './ship24/adapter.js';
export { TrackingCaptureError } from './shared/capture.js';
export type { UniversalSource } from './shared/result.js';

export * from './plan.js';
import { universalPlan, universalSourceBudget } from './plan.js';

/**
 * A source is asked only with this much budget left. A provider that runs out
 * of time returns a few milliseconds before the deadline, because its timers
 * round down to whole milliseconds, and none answers in less.
 */
const MIN_SOURCE_BUDGET_MS = 50;
/** The longest number providers are asked about only for a named carrier. */
const SHORT_NUMBER_LENGTH = 7;

const FACTORIES = {
  'Ship24': ship24Adapter,
  'ParcelsApp': parcelsAppAdapter,
  'Postal Ninja': postalNinjaAdapter,
  '17TRACK': seventeenTrackAdapter,
  'UPU': upuAdapter,
  'Track718': track718Adapter,

  'Track123': track123Adapter,
} as const satisfies Record<Source, unknown>;

interface SourceFailure {
  source: Source;
  reason: string;
  error: unknown;
}

export class UniversalTrackingError extends AggregateError {
  constructor(readonly failures: ReadonlyArray<SourceFailure>) {
    super(failures.map(({ error }) => error), `Automatic carrier lookup could not retrieve tracking history. ${failures.map(
      ({ source, reason }) => `${source}: ${reason}`,
    ).join('; ')}`);
    this.name = 'UniversalTrackingError';
  }
}

export interface UniversalTrackerOptions {
  providers?: readonly Source[];
  /** The browser service endpoint; overrides `environment.trawl`. An empty string disables it. */
  trawlUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  executablePath?: string;
  enablePostalNinja?: boolean;
  /** Test seam replacing the two local-browser providers. */
  browserLookup?: (source: 'Postal Ninja' | 'Ship24', number: string) => Promise<CarrierResult>;
  /** What the host gives every adapter: browser service, telemetry sink, flags. */
  environment?: Partial<AdapterEnvironment>;
}

export class UniversalTracker {
  private readonly instances = new Map<Source, CarrierAdapter>();
  constructor(readonly options: UniversalTrackerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('Universal tracking timeout must be positive');
    }
  }

  /**
   * Look up one number through the whole chain. `postcode` is the parcel's
   * stored delivery postcode, if the user supplied one: it is forwarded into
   * every provider's track input. ParcelsApp submits it as extra[zipcode] on
   * its direct API request; 17TRACK submits it through the browser's postcode form.
   * `countryHint` is accepted for compatibility and no longer read. `carrier` is the
   * catalog carrier the parcel is filed under, a hint for providers that can be
   * asked about one carrier (see `TrackingInput.carrier`).
   * The caller's budget covers the whole chain and its signal ends it.
   */
  async fetch(trackingNumber: string, postcode?: string | null, context: TrackingContext = {}, countryHint?: string | null, carrier?: string | null): Promise<CarrierResult> {
    numberOf(trackingNumber);
    context.signal?.throwIfAborted();
    const deadline = context.budgetMs === undefined ? Infinity : performance.now() + context.budgetMs;
    const failures: SourceFailure[] = [];
    const sources = universalPlan({ carriers: [carrier], trackingNumber, enablePostalNinja: this.options.enablePostalNinja,
      enableTrack123: this.options.providers?.includes('Track123') }).sources.filter(source => (this.options.providers ?? ['UPU']).includes(source));
    for (const source of sources) {
      const remaining = deadline - performance.now();
      if (remaining < MIN_SOURCE_BUDGET_MS) {
        failures.push({ source, reason: 'the lookup budget was spent first', error: new BudgetExceededError(source, context.budgetMs!) });
        continue;
      }
      try {
        return await this.fetchSource(source, trackingNumber, Math.min(remaining, this.options.timeoutMs ?? universalSourceBudget(source)),
          postcode, null, context.signal, countryHint, carrier);
      } catch (error) {
        if (context.signal?.aborted) throw context.signal.reason;
        failures.push({ source, reason: 'history unavailable; try again later or open the tracking website', error });
      }
    }
    throw new UniversalTrackingError(failures);
  }

  async fetchSource(source: Source, trackingNumber: string, timeoutMs = this.options.timeoutMs ?? universalSourceBudget(source), postcode?: string | null, timezone?: string | null, signal?: AbortSignal, countryHint?: string | null, carrier?: string | null): Promise<CarrierResult> {
    // Providers get the normalized number, as from createTracker(), however the caller stored it.
    const normalized = normalizeTrackingNumber(numberOf(trackingNumber));
    // A USPS routing barcode opens with the recipient's ZIP code. Providers are
    // asked for the package identifier after it, the number USPS tracks, and
    // bind their answer to it. Without a single identifier neither the barcode
    // nor its readings are sent, and the lookup is left to USPS's adapter.
    // Detection still reads the barcode as typed.
    const pic = uspsPackageIdentifier(normalized);
    if (!pic && USPS_ROUTING_BARCODE.test(normalized)) {
      throw new IndeterminateError(source, 'A USPS routing barcode without a single package identifier is not sent',
        { reason: 'usps_routing_barcode' });
    }
    const number = pic ?? normalized;
    // Providers merge other people's shipments under a placeholder such as 123456789.
    if (isPlaceholderNumber(number)) {
      throw new InvalidInputError(source, 'A placeholder number is not sent', { reason: 'placeholder_number' });
    }
    // Many carriers issue a number this short. A provider guesses which one from the number alone, and
    // its guess can change from one lookup to the next, each time with another shipment's history.
    if (number.length <= SHORT_NUMBER_LENGTH && (!carrier || carrier === 'unknown')) {
      throw new NoHistoryError(source, 'A number this short is not sent without its carrier', { reason: 'short_number' });
    }
    const result = this.options.browserLookup && (source === 'Postal Ninja' || source === 'Ship24')
      ? await this.options.browserLookup(source, number)
      : await this.provider(source).track({ number, postcode: postcode ?? null, timezone: timezone ?? null, countryHint: countryHint ?? null,
        carrier: carrier ?? null }, { budgetMs: timeoutMs, signal });
    // A history whose scans all lack an instant can't be placed on a timeline or weighed
    // against another provider's, so it isn't an answer. An answer without scans keeps
    // its stage and carrier as before. UPU's local clocks are by design.
    if (source !== 'UPU' && result.events?.length && !result.events.some((event) => event.time)) {
      throw new IndeterminateError(source, 'No dated tracking events', { reason: 'undated_history' });
    }
    return readLateRegistrations(withoutRepeatedScans(result));
  }

  /** One provider adapter, built from this tracker's environment. */
  private provider(source: Source): CarrierAdapter {
    let instance = this.instances.get(source);
    if (!instance) { instance = FACTORIES[source](this.environment()); this.instances.set(source, instance); }
    return instance;
  }

  private environment(): AdapterEnvironment {
    const partial = this.options.environment ?? {};
    const fetcher = partial.fetcher ?? this.options.fetcher;
    return {
      fetcher,
      userAgent: partial.userAgent,
      trawl: this.trawl(fetcher, partial),
      trawlRoutes: partial.trawlRoutes,
      browserExecutablePath: partial.browserExecutablePath ?? this.options.executablePath ?? null,
      recorder: partial.recorder ?? NOOP_RECORDER,
      env: partial.env ?? {},
    };
  }

  private trawl(fetcher: typeof fetch | undefined, partial: Partial<AdapterEnvironment>): TrawlClient | null {
    const configured = this.options.trawlUrl;
    if (configured !== undefined) return configured ? new TrawlClient(configured, fetcher) : null;
    if (partial.trawl !== undefined) return partial.trawl;
    return TrawlClient.fromEnvironment(partial.env ?? {}, fetcher);
  }
}
