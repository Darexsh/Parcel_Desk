import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The codes (`eventCode`) on OSM Worldwide's scans. The tracker gives the last
 * mile partner's scans OSM codes of their own, "courier partner" in the
 * wording. The partner accepting the parcel takes it from OSM, which has moved
 * it already: no acceptance. A partner that leaves with the parcel is on its
 * way, not yet out for delivery: the same scan can come days before the delivery.
 */
const CODES: Readonly<Record<string, Stage>> = {
  OSM02: 'registered',
  OSM04: 'in_transit',
  OSM05: 'in_transit',
  OSM06: 'in_transit',
  OSM07: 'in_transit',
  OSM09: 'in_transit',
  OSM13: 'in_transit',
  OSM01: 'delivered',
};

/**
 * The tracker's milestone groups, as it names them: label created, in transit,
 * out for delivery and delivered. Group 0 is a scan in none of them.
 */
const GROUPS: Readonly<Record<number, Stage>> = {
  1: 'registered',
  2: 'in_transit',
  3: 'out_for_delivery',
  4: 'delivered',
};

/**
 * OSM's FAQ says this scan is made when the shipper uploads the label, before
 * OSM has the parcel; the shared rules would read it as a pickup.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^picked up by shipping partner$/, 'registered'],
];

/** The stage the map gives a scan's code, if it knows it. */
export function osmCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

/** The stage of a tracker milestone group, if the scan is in one. */
export function osmGroupStage(group: number): Stage | undefined {
  return Object.hasOwn(GROUPS, group) ? GROUPS[group] : undefined;
}

/** The stage the map gives wording that came without a code it knows. */
export function osmWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** What the tracker says about one scan besides its code and wording. */
export interface OsmScanFlags {
  readonly group: number;
  /** An attempted delivery the recipient can give instructions for. */
  readonly instructionsNeeded: boolean;
  readonly isException: boolean;
}

/**
 * A scan's stage: its code, then the tracker's own flags and milestone group,
 * then OSM's wording, then the shared wording rules. Wording none of them
 * knows stays without a stage, so it remains visible for review.
 */
export function osmStage(code: string, wording: string, flags: OsmScanFlags): ClassifiedWording | null {
  const mapped = osmCodeStage(code)
    ?? (flags.instructionsNeeded ? 'failed_attempt' : flags.isException ? 'exception' : undefined)
    ?? osmGroupStage(flags.group)
    ?? osmWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its code, or by its wording when it has none. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? osmCodeStage(code) : osmWordingStage(wording)),
  gaps: [],
};
