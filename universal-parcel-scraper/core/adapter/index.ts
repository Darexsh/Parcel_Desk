/**
 * The contract between the host and a carrier adapter.
 *
 * A carrier folder exports an `AdapterFactory`; the generated registry lists
 * every factory by carrier id, and the host creates one adapter instance per
 * process through an `AdapterRegistry`. An adapter owns its sessions and
 * declares its steps; it reaches the network only through what the
 * `AdapterEnvironment` provides, and it reports through the `StepRecorder`.
 */
import { isPlaceholderNumber } from '../detection/placeholder.js';
import { BudgetExceededError, CarrierError, carrierErrorKind, InvalidInputError } from '../errors/index.js';
import { normalizeCarrierResult, type CarrierResult } from '../result/index.js';
import type { StepRecorder } from '../telemetry/index.js';
import type { TrawlClient } from '../transport/trawl.js';
import { EXPLICIT_OFFSET_PATTERN, explicitOffsetTime } from '../time/index.js';
import { eventTimestamp } from '../time/result.js';

export interface TrackingInput {
  /** The tracking number as stored on the parcel, validated at the API boundary. */
  number: string;
  /** A capability URL for carriers that need one (shared Planzer links, Dachser). */
  trackingUrl?: string | null;
  /** The delivery postcode for carriers that need one; part of the tracking credential. */
  postcode?: string | null;
  /**
   * The country of `postcode` as an ISO 3166-1 alpha-2 code, for a postcode
   * the consumer knows is from outside the carrier's home country. Without
   * one, an adapter reads the postcode as its home country's.
   */
  postcodeCountry?: string | null;
  /** @deprecated Accepted for compatibility; no adapter or provider reads it. */
  countryHint?: string | null;
  /**
   * The zone of the carrier the parcel is filed under, for universal providers
   * whose scan times name no zone they can be trusted with. When that
   * carrier's catalog zone is UTC, the zone of the carrier a direct lookup
   * confirmed for the same number. Never a guess: absent when neither has one.
   */
  timezone?: string | null;
  /**
   * The catalog id of the carrier the parcel is filed under, for universal
   * providers that can be asked about one carrier when their own detection
   * names another or none. A hint for the lookup, never proof of the carrier.
   */
  carrier?: string | null;
  /**
   * The reader's language as a BCP 47 tag ("fr", "de-CH"), for carriers whose
   * tracker words its scans in it. A preference: an adapter that cannot answer
   * in it answers as it does without one. Stages do not depend on it.
   */
  language?: string | null;
}

/**
 * The primary subtag of the input's language ("fr" for "fr-CH"), in lower
 * case, when `supported` lists it; undefined otherwise.
 */
export function readerLanguage<const Language extends string>(
  input: Pick<TrackingInput, 'language'>,
  supported: readonly Language[],
): Language | undefined {
  const tag = typeof input.language === 'string' ? /^\s*([a-z]{2,3})(?:[-_][\w-]*)?\s*$/i.exec(input.language) : null;
  const primary = tag?.[1]!.toLowerCase();
  return supported.find((language) => language === primary);
}

export interface TrackingContext {
  signal?: AbortSignal;
  /** Overrides the adapter's default lookup budget. */
  budgetMs?: number;
}

/** What an adapter derives from a `TrackingContext`: one signal and one clock for the whole lookup. */
export interface LookupBudget {
  /** Aborts on the caller's signal or when the budget is spent. Every request takes it. */
  readonly signal: AbortSignal;
  readonly budgetMs: number;
  /** When the budget is spent, on the `performance.now()` clock. */
  readonly deadline: number;
  /** Whole milliseconds left, never below 1 so it is always a valid request timeout. */
  remainingMs: () => number;
}

/** The longest delay a timer holds; a longer one would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The caller's signal joined with the lookup budget. Throws the caller's
 * reason when the signal is already aborted, so no request starts.
 */
export function lookupBudget(context: TrackingContext | undefined, defaultBudgetMs: number, provider = 'Tracking'): LookupBudget {
  context?.signal?.throwIfAborted();
  const budgetMs = context?.budgetMs ?? defaultBudgetMs;
  if (!Number.isFinite(budgetMs)) throw new TypeError('Lookup budget must be a finite number of milliseconds');
  // A budget already spent is a budget failure, as the step runner reports it.
  if (budgetMs <= 0) throw new BudgetExceededError(provider, budgetMs);
  const deadline = performance.now() + budgetMs;
  const timeout = AbortSignal.timeout(Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(budgetMs))));
  return {
    budgetMs,
    deadline,
    signal: context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
    remainingMs: () => Math.min(MAX_TIMER_MS, Math.max(1, Math.floor(deadline - performance.now()))),
  };
}

export interface AdapterEnvironment {
  /** Test seam; production uses the global fetch. */
  fetcher?: typeof fetch;
  /** Sent where an adapter names itself instead of a browser; `DEFAULT_USER_AGENT` when absent. */
  userAgent?: string;
  /** The private browser service, or null when not configured. */
  trawl: TrawlClient | null;
  /** Optional named browser routes, constructed and isolated by the host. */
  trawlRoutes?: Readonly<Record<string, TrawlClient | null>>;
  /** A Chromium executable for adapters that must run a browser locally, or null. */
  browserExecutablePath: string | null;
  recorder: StepRecorder;
  /** Provider-specific configuration (feature flags, optional endpoints). */
  env: Readonly<Record<string, string | undefined>>;
}

/** Whether a carrier knows a tracking number, from a cheap check. */
export interface Recognition {
  known: boolean;
  /** The newest activity the check saw, when it reports one; old parcels can share a reused number. */
  lastActivityAt?: string | null;
  /** Without such an instant, the newest scan on the carrier's local clock: an offset-less ISO wall time. */
  lastActivityLocal?: string | null;
}

/** Browser confirmation retains the lookup, normalized like any tracking result, so a consumer can reuse its history. */
export interface BrowserRecognition extends Recognition {
  result?: CarrierResult;
}

export interface CarrierAdapter {
  readonly id: string;
  /** The tiers this adapter can go through, in order; telemetry labels use these ids. */
  readonly steps: readonly string[];
  /** The adapter records its own steps, including single-step protocols. */
  readonly recordsSteps?: boolean;
  /**
   * The carrier enters some scans at their planned time, before they happen, such as a departure
   * at its schedule: a scan dated after the lookup is held back until it is due.
   */
  readonly plannedScans?: boolean;
  track(input: TrackingInput, context?: TrackingContext): Promise<CarrierResult>;
  /**
   * Required when carrier.json declares `tracking.recognition`: whether the
   * carrier knows the number, without the user's inputs, through plain HTTP
   * only (never a browser tier). A positive not-found is `known: false`; any
   * other failure throws.
   */
  recognize?(number: string, context?: TrackingContext): Promise<Recognition>;
  /** Opt-in confirmation through the adapter's browser path, without recipient inputs. */
  recognizeWithBrowser?(number: string, context?: TrackingContext, previousError?: unknown): Promise<BrowserRecognition>;
}

export type AdapterFactory = (environment: AdapterEnvironment) => CarrierAdapter;

/**
 * `recognize()` for an adapter whose ordinary lookup is already cheap: a
 * result with scans, or a status past pending, is known; a positive not-found
 * is unknown; any other failure is thrown. `accepts` is the adapter's own
 * number check: a form it cannot look up is unknown without a request. Only
 * for lookups without a browser tier.
 */
/** Whether a number check passes: false when it rejects the number. */
export function accepted(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof InvalidInputError || error instanceof TypeError) return false;
    throw error;
  }
}

/** The first carrier error in the chain asks for an input to show a parcel the carrier holds. */
function foundBehindInput(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current) && seen.size < 8; current = current.cause) {
    seen.add(current);
    if (current instanceof CarrierError) return current.kind === 'input_required' && current.reason === 'parcel_found';
  }
  return false;
}

export async function recognizeFromLookup(
  lookup: () => Promise<CarrierResult>,
  accepts: () => boolean = () => true,
): Promise<Recognition> {
  if (!accepts()) return { known: false };
  let result: CarrierResult;
  try {
    result = await lookup();
  } catch (error) {
    // A number the carrier does not issue is as unknown to it as one it cannot find.
    if (['not_found', 'invalid_input'].includes(carrierErrorKind(error) ?? '')) return { known: false };
    // The carrier holds the parcel and shows it only once the recipient gives an input, such as a postcode.
    if (foundBehindInput(error)) return { known: true, lastActivityAt: null };
    throw error;
  }
  // Local clocks and malformed dates name no instant.
  const iso = (value: string | null | undefined) => {
    if (typeof value !== 'string') return Number.NaN;
    const raw = value.trim();
    // Luxon normalizes impossible offsets such as +02:99 or +99:00.
    // Those are unresolved clocks, not instants that can rank a match.
    return /^\d{4}-\d{2}-\d{2}T/.test(raw) && /(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i.test(raw)
      ? explicitOffsetTime(raw)?.timestamp ?? Number.NaN : Number.NaN;
  };
  const times = (result.events ?? []).map((event) => iso(event.time)).filter(Number.isFinite);
  // A pending status without a scan is no evidence: some carriers answer any number that way.
  const known = (result.events?.length ?? 0) > 0 || !['unknown', 'pending', undefined].includes(result.status);
  const updated = iso(result.last_update);
  const lastActivityAt = !known ? null : times.length ? new Date(Math.max(...times)).toISOString()
    : Number.isFinite(updated) ? new Date(updated).toISOString() : null;
  // A local clock still tells an old parcel's label from a new one, to within a day.
  const walls = [result.last_update, result.last_update_local, ...(result.events ?? []).flatMap((event) => [event.time, event.local_time])]
    .map((value) => typeof value === 'string' && !EXPLICIT_OFFSET_PATTERN.test(value.trim()) ? Date.parse(eventTimestamp(value, 'UTC') ?? '') : Number.NaN)
    .filter(Number.isFinite);
  return known && !lastActivityAt && walls.length
    ? { known, lastActivityAt, lastActivityLocal: new Date(Math.max(...walls)).toISOString().slice(0, 19) }
    : { known, lastActivityAt };
}

/** Browser shells and undated default statuses do not establish a shipment. */
export async function recognizeFromBrowserLookup(lookup: () => Promise<CarrierResult>): Promise<BrowserRecognition> {
  let result: CarrierResult | undefined;
  // The retained result passes the same checks as every tracking result before anyone reuses it.
  const answer = await recognizeFromLookup(async () => (result = normalizeCarrierResult(await lookup())));
  if (!answer.known || !answer.lastActivityAt || !result) return { known: false, lastActivityAt: null };
  return { ...answer, result };
}

/** Registered adapter factories plus the carrier → adapter mapping, as generated. */
export interface RegistryDefinition {
  factories: Readonly<Record<string, AdapterFactory>>;
  /** Carrier id → adapter id (a key of `factories`), 'universal', or null for link-only carriers. */
  carriers: Readonly<Record<string, string | null>>;
}

/**
 * The adapter, refusing placeholder numbers before it is asked: trackers show
 * other people's shipments under them. Its lookup fails as invalid input and
 * its recognition answers unknown, without a request.
 */
function refusingPlaceholders(adapter: CarrierAdapter): CarrierAdapter {
  const refusal = () => new InvalidInputError(adapter.id, 'A placeholder number is not looked up', { reason: 'placeholder_number' });
  const recognize = adapter.recognize?.bind(adapter);
  const recognizeWithBrowser = adapter.recognizeWithBrowser?.bind(adapter);
  // Arguments pass through as given: an adapter can tell a lookup without a context.
  return {
    id: adapter.id,
    steps: adapter.steps,
    ...(adapter.recordsSteps !== undefined && { recordsSteps: adapter.recordsSteps }),
    ...(adapter.plannedScans !== undefined && { plannedScans: adapter.plannedScans }),
    track: async (...args) => {
      if (isPlaceholderNumber(args[0].number)) throw refusal();
      return adapter.track(...args);
    },
    ...(recognize && { recognize: async (...args: Parameters<typeof recognize>) =>
      isPlaceholderNumber(args[0]) ? { known: false } : recognize(...args) }),
    ...(recognizeWithBrowser && { recognizeWithBrowser: async (...args: Parameters<typeof recognizeWithBrowser>) =>
      isPlaceholderNumber(args[0]) ? { known: false, lastActivityAt: null } : recognizeWithBrowser(...args) }),
  };
}

/**
 * One adapter instance per adapter id for the process lifetime, created on
 * first use so a broken provider module cannot prevent unrelated carriers
 * from syncing. Each refuses placeholder numbers.
 */
export class AdapterRegistry {
  private readonly instances = new Map<string, CarrierAdapter>();

  constructor(private readonly definition: RegistryDefinition, private readonly environment: AdapterEnvironment) {}

  /** The adapter id that serves this carrier, 'universal', or null. */
  adapterIdFor(carrierId: string): string | null {
    return this.definition.carriers[carrierId] ?? null;
  }

  /** Whether a dedicated adapter module serves this carrier. */
  has(carrierId: string): boolean {
    const adapterId = this.adapterIdFor(carrierId);
    return adapterId !== null && adapterId !== 'universal' && Object.hasOwn(this.definition.factories, adapterId);
  }

  for(carrierId: string): CarrierAdapter | null {
    const adapterId = this.adapterIdFor(carrierId);
    if (adapterId === null || adapterId === 'universal') return null;
    const factory = this.definition.factories[adapterId];
    if (!factory) return null;
    let instance = this.instances.get(adapterId);
    if (!instance) {
      instance = refusingPlaceholders(factory(this.environment));
      this.instances.set(adapterId, instance);
    }
    return instance;
  }

  /** Every dedicated adapter id, for canaries and documentation. */
  adapterIds(): string[] {
    return Object.keys(this.definition.factories);
  }
}
