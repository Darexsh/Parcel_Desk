import { isValidS10TrackingNumber } from '../core/detection/s10.js';
import { normalizeTrackingNumber } from '../core/detection/normalize.js';
import { CARRIER_IDS } from '../generated/catalog.js';
import { coverageTiers, type CoverageTier } from './coverage.js';
import type { UniversalSource as Source } from './types.js';
export const UNIVERSAL_SOURCES: Source[] = ['ParcelsApp', 'Ship24', '17TRACK', 'Track718', 'UPU'];
/** Providers reached only through the browser service: slower, and sharing one TRAWL. */
export const BROWSER_SOURCES: ReadonlySet<Source> = new Set(['17TRACK', 'Postal Ninja', 'Track718', 'Track123']);

/** Lookup time reserved by the chain and host router, before transport allowance. */
export function universalSourceBudget(source: Source): number {
  return source === 'ParcelsApp' ? 45_000 : source === 'UPU' ? 8_000 : 30_000;
}

/** Evidence-based exception to affinity/rotation, shared by discovery and routing. */
export function priorityUniversalSource(trackingNumber?: string): Source | undefined {
  if (trackingNumber && /^JXC[A-Z]{2}\d{10}YQ$/.test(normalizeTrackingNumber(trackingNumber))) return 'Track718';
  // The Express corpus has complete Ship24 histories where ParcelsApp can be empty or input-gated.
  if (trackingNumber && /^\d{10}$/.test(normalizeTrackingNumber(trackingNumber))) return 'Ship24';
  // E-series and untested formats keep ordinary discovery.
  return trackingNumber && /^[CL][A-Z]\d{9}CN$/.test(normalizeTrackingNumber(trackingNumber)) && isValidS10TrackingNumber(trackingNumber)
    ? '17TRACK' : undefined;
}

export interface UniversalPlan {
  /** The eligible providers, in the order to ask them. */
  sources: Source[];
  /** The carrier whose coverage evidence ordered them, or null for the default order. */
  carrier: string | null;
  /** A provider's coverage tier for that carrier; `unknown` without evidence. */
  tier(source: Source): CoverageTier;
  /** Lower is fuller history for the carrier; providers without evidence share one rank. */
  rank(source: Source): number;
}

const TIER_RANK: Record<CoverageTier, number> = { full: 0, partial: 1, unknown: 2, empty: 3, excluded: 4 };
/**
 * UPU's sparse feed ranks as a provider without evidence. Postal Ninja ranks no
 * higher than one without history: its histories rarely have a scan whose clock
 * a consumer can place, so its rows are not usable history.
 */
function tierRank(tiers: Partial<Record<Source, CoverageTier>> | null, source: Source): number {
  const rank = TIER_RANK[tiers?.[source] ?? 'unknown'];
  if (source === 'UPU') return TIER_RANK.unknown;
  return source === 'Postal Ninja' ? Math.max(rank, TIER_RANK.empty) : rank;
}
/** Asked after the other aggregators whatever the evidence: Postal Ninja, then UPU. */
const lastResort = (source: Source): number => source === 'UPU' ? 2 : source === 'Postal Ninja' ? 1 : 0;

/**
 * Orders providers (given in the default order) by a carrier's coverage tiers:
 * fuller history first, HTTP before the browser service, then the default order.
 * Excluded providers are left out unless nothing else would remain. Postal Ninja
 * and then UPU stay last whatever their evidence.
 */
export function orderUniversalSources(eligible: readonly Source[], tiers: Partial<Record<Source, CoverageTier>> | null): Source[] {
  const excluded = (source: Source) => source !== 'UPU' && tiers?.[source] === 'excluded';
  const usable = eligible.some((source) => source !== 'UPU' && !excluded(source)) ? eligible.filter((source) => !excluded(source)) : [...eligible];
  return usable.sort((a, b) => lastResort(a) - lastResort(b) || tierRank(tiers, a) - tierRank(tiers, b)
    || Number(BROWSER_SOURCES.has(a)) - Number(BROWSER_SOURCES.has(b)) || eligible.indexOf(a) - eligible.indexOf(b));
}

/** Catalog carriers other than the catalog's own `unknown`. */
const CARRIERS: ReadonlySet<string> = new Set(CARRIER_IDS.filter((carrier) => carrier !== 'unknown'));

/**
 * The providers to ask for a number, ordered by the coverage evidence of the
 * first of `carriers` that has some (the carrier the lookup is for, then the one
 * confirmed or discovered for the number), otherwise in the default order.
 *
 * Postal Ninja's browser lookups rarely find a named carrier's parcel that the
 * other aggregators missed. It is asked about one only when that carrier's
 * evidence shows its history, and about any number no carrier is named for,
 * where it is often the only provider with the parcel.
 */
export function universalPlan(options: {
  carriers?: ReadonlyArray<string | null | undefined>;
  trackingNumber?: string;
  enablePostalNinja?: boolean;
  /** Opt-in public-page recovery, only when the requested carrier is FedEx. */
  enableTrack123?: boolean;
} = {}): UniversalPlan {
  const { trackingNumber, enablePostalNinja = false } = options;
  const carriers = options.carriers ?? [];
  const carrier = carriers.find((candidate) => coverageTiers(candidate)) ?? null;
  const tiers = coverageTiers(carrier);
  const named = carriers.some((candidate) => candidate && CARRIERS.has(candidate));
  const postalNinja = enablePostalNinja && (!named || ['full', 'partial'].includes(tiers?.['Postal Ninja'] ?? 'unknown'));
  const defaults: Source[] = postalNinja ? ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] : [...UNIVERSAL_SOURCES];
  const juxi = carriers.find(candidate => candidate && CARRIERS.has(candidate)) === 'juxi-express' || !named && !!trackingNumber && /^JXC[A-Z]{2}\d{10}YQ$/.test(normalizeTrackingNumber(trackingNumber));
  const eligible = defaults.filter(source => (source !== 'Track718' || juxi)
    && (source !== 'UPU' || trackingNumber === undefined || isValidS10TrackingNumber(trackingNumber)));
  if (juxi && !eligible.includes('Track718')) eligible.unshift('Track718');
  const ordered = orderUniversalSources(eligible, tiers);
  if (options.enableTrack123 && carriers[0] === 'fedex' && !!trackingNumber
    && /^(?:\d{12}|\d{15}|\d{20})$/.test(normalizeTrackingNumber(trackingNumber))) ordered.unshift('Track123');
  // The number's priority provider goes first, unless the carrier's evidence left it out.
  const priority = ordered.find((source) => source === priorityUniversalSource(trackingNumber));
  return {
    sources: juxi ? ['Track718', ...ordered.filter(source => source !== 'Track718')]
      : priority ? [priority, ...ordered.filter((source) => source !== priority)] : ordered,
    carrier,
    tier: (source) => tiers?.[source] ?? 'unknown',
    rank: (source) => tierRank(tiers, source),
  };
}

/** The default order for a number, without a carrier's evidence. */
export function universalSources(enablePostalNinja = false, trackingNumber?: string): Source[] {
  return universalPlan({ trackingNumber, enablePostalNinja }).sources;
}
