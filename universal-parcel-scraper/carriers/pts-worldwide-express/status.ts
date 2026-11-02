import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * PTS's scan codes. They stay the same in every language the tracker words
 * its scans in; scans relayed from partners abroad get PTS's codes too. Only
 * codes seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['004', 'registered'], // The shipment's data reached PTS before the parcel did.
  ['001', 'accepted'], // A courier collected the parcel.
  ['017', 'accepted'], // Handed in at an operations centre.
  ['219', 'in_transit'], // Reached PTS's hub.
  ['222', 'in_transit'], // Prepared for its flight; the English tracker says "Shipped from Origin".
  ['106', 'in_transit'], // Loaded on a vehicle.
  ['022', 'in_transit'], // Handed over at the airport.
  ['205', 'in_transit'], // Exported from Turkey.
  ['214', 'in_transit'], // The plane took off.
  ['215', 'in_transit'], // The plane landed.
  ['256', 'in_transit'], // Arrived in the destination country.
  ['225', 'in_transit'], // Reached an operations centre.
  ['255', 'customs'], // Under customs clearance.
  ['250', 'in_transit'], // Cleared customs.
  ['264', 'in_transit'],
  ['305', 'in_transit'], // Handed over to the subcontractor that delivers it.
  ['317', 'in_transit'], // Handed over to the last-mile subcontractor.
  ['998', 'in_transit'], // Handed over to the local delivery agent.
  ['206', 'in_transit'], // Arrived at a sorting centre.
  ['992', 'in_transit'], // Scheduled for delivery, not yet out.
  ['300', 'out_for_delivery'],
  ['460', 'ready_for_pickup'], // Left at a parcel shop for collection.
  ['420', 'failed_attempt'],
  ['999', 'delivered'],
  ['987', 'returned'], // The last-mile partner completed the parcel's return.
]);

// A delay notice moves nothing.
const NOTICES: ReadonlySet<string> = new Set(['280']);

/**
 * The tracker's summary of a parcel, which the page shows over the scans,
 * with its English label. "In Customs" is the label of the step the Turkish
 * page calls at the destination warehouse, so it reads as in transit.
 */
const SUMMARIES: ReadonlyMap<string, { stage: Stage; label: string }> = new Map([
  ['PREPARING', { stage: 'registered', label: 'In Progress' }],
  ['IN_PROGRESS', { stage: 'in_transit', label: 'Under Transport' }],
  ['DESTINATION_COUNTRY_WAREHOUSE', { stage: 'in_transit', label: 'In Customs' }],
  ['OUT_FOR_DELIVERY', { stage: 'out_for_delivery', label: 'Out for Delivery' }],
  ['DELIVERED', { stage: 'delivered', label: 'Delivered' }],
  ['UNDELIVERABLE', { stage: 'exception', label: 'Undeliverable' }],
]);

type Entry = { code?: string; wording: string; stage?: string };

// Wordings of the former tracker, which gave no codes.
const WORDINGS: ReadonlyMap<string, Stage> = new Map((statuses.entries as readonly Entry[])
  .filter((entry) => !entry.code && entry.stage).map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage PTS's map gives a scan or summary code, or a wording that came without one. */
export function ptsMappedStage(code: string | null, wording: string): Stage | undefined {
  if (!code) return WORDINGS.get(normalizeStatusWording(wording));
  const key = code.toUpperCase();
  return CODES.get(key) ?? SUMMARIES.get(key)?.stage;
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function ptsStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = ptsMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker's summary code with its stage and label, when it is one the page knows. */
export function ptsSummary(status: string): { code: string; stage: Stage; label: string } | undefined {
  const code = status.toUpperCase();
  const summary = SUMMARIES.get(code);
  return summary && { code, ...summary };
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => ptsMappedStage(code, wording),
  gaps: [
    { code: '280', note: 'A delay notice ("Transfer Delay"); it moves nothing.' },
  ],
};
