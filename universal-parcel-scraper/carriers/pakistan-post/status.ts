import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Pakistan Post's scans, read by how they start. Domestic scans name the
 * office in their wording ("Received at Peshawar GPO"). International ones
 * carry the UPU's IPS event name with a leg, "in origin country" or "in
 * destination country", that the tracker adds to Pakistani scans of outbound
 * items too, and sometimes the next office. The shared rules misread several
 * of them: a handover from the airline as an acceptance, an arrival at a mail
 * office as one, a release from customs as a hold.
 */
const SCANS: readonly (readonly [RegExp, Stage])[] = [
  [/^booked at\b/, 'accepted'],
  // At a district mail office, a delivery office or a hub.
  [/^received at\b/, 'in_transit'],
  [/^dispatch from\b/, 'in_transit'],
  // Sent to the wrong office, which sends it on; the page writes "MissSent".
  [/^miss?sent\b/, 'in_transit'],
  [/^sent out for delivery\b/, 'out_for_delivery'],
  [/^undelivered\b/, 'failed_attempt'],
  [/^return to sender\b/, 'returned'],
  [/^delivered\b/, 'delivered'],
  [/^receive item at office of exchange\b/, 'in_transit'],
  [/^send item to destination country\b/, 'in_transit'],
  // The sending post's despatch abroad, which reaches Pakistan Post as data after that post's own scans:
  // not a pre-advice.
  [/^send item abroad\b/, 'in_transit'],
  [/^send item to domestic location\b/, 'in_transit'],
  [/^insert item into (?:domestic )?bag\b/, 'in_transit'],
  [/^handed ?over to airline\b/, 'in_transit'],
  [/^flight departure\b/, 'in_transit'],
  [/^handed over from airline\b/, 'in_transit'],
  [/^send item to customs\b/, 'customs'],
  // Customs handed the item back: a release.
  [/^return item from customs\b/, 'in_transit'],
  // Kept at the office of exchange, as other posts' IPS feeds read it.
  [/^hold item at office of exchange\b/, 'in_transit'],
  [/^receive item at sorting centre\b/, 'in_transit'],
  [/^send item out of sorting centre\b/, 'in_transit'],
  [/^receive item at delivery office\b/, 'in_transit'],
  [/^send item out for physical delivery\b/, 'out_for_delivery'],
  [/^unsuccessful item delivery attempt\b/, 'failed_attempt'],
  [/^receive item at collection point for pick-up\b/, 'ready_for_pickup'],
  [/^deliver item\b/, 'delivered'],
];

// An IPS record that changed the item's data; it moves nothing.
const UPDATES = ['Update item in destination country'].map(normalizeStatusWording);

/** The stage Pakistan Post's wording starts with, read case-insensitively. */
export function pakistanPostScanStage(wording: string): Stage | undefined {
  const text = normalizeStatusWording(wording);
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. An update has none. */
export function pakistanPostStage(wording: string): ClassifiedWording | null {
  if (UPDATES.includes(normalizeStatusWording(wording))) return null;
  const mapped = pakistanPostScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code || UPDATES.includes(wording) ? undefined : pakistanPostScanStage(wording)),
  gaps: UPDATES.map((wording) => ({ wording, note: 'An IPS record that changed the item\'s data; it moves nothing.' })),
};
