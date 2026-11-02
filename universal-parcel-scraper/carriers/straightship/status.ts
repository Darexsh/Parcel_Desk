import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of Straightship's tracker, in English without a code. Station
 * and delivery rows end with the town and province in brackets, which the
 * parser moves to the scan's place; the map reads either form. The summary's
 * `Package Status` values are here too, since universal providers relay them
 * as scans.
 */
const RULES: readonly (readonly [RegExp, Stage])[] = [
  // The shipper's details, before Straightship has the parcel.
  [/^package information is created in the system$/, 'registered'],
  [/^ready ?for ?shipping$/, 'registered'],
  // Relayed by universal providers between the label and the first scan in Canada.
  [/^customs released$/, 'in_transit'],
  // The first scan once the parcel reaches Straightship in Canada; a station row at the same time follows.
  [/^package received with origin scan warehouse$/, 'accepted'],
  [/^package is received at a straightship station$/, 'in_transit'],
  [/^arrived at facility$/, 'in_transit'],
  [/^package arrived at transit station$/, 'in_transit'],
  // Loaded at the station for the delivery round.
  [/^loading$/, 'in_transit'],
  // Seen after a round that did not deliver, before another round or a return.
  [/^delivery is in progress$/, 'in_transit'],
  [/^your order is in progress$/, 'in_transit'],
  // The summary while the parcel is on its delivery round.
  [/^shipped$/, 'in_transit'],
  [/^shipment delayed$/, 'exception'],
  // The driver's round: the parcel comes that day, or an attempt follows.
  [/^package will be delivered before \d{1,2}:\d{2} ?[ap]m$/, 'out_for_delivery'],
  // Followed by the reason and how to arrange another delivery.
  [/^an attempt was made to deliver your package\b/, 'failed_attempt'],
  [/^attempted delivery$/, 'failed_attempt'],
  [/^delivered$/, 'delivered'],
  // A station can still scan the parcel afterwards and send it out again.
  [/^package is being returned to shipper$/, 'returned'],
  [/^returned ?to ?sender$/, 'returned'],
];

// "(Sampleton, BC)": the place after the wording, which relayed copies can shorten to the town.
const PLACE = / \([^()\d@]+\)$/;

/** The stage the map gives Straightship's wording, if it knows it. */
export function straightshipMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording).replace(PLACE, '');
  return RULES.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function straightshipStage(wording: string): ClassifiedWording | null {
  const mapped = straightshipMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Rows come without a code, and every wording seen moves the parcel. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? straightshipMappedStage(wording) : undefined),
  gaps: [],
};
