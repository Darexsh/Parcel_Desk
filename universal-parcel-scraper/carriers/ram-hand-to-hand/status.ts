import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * RAM's scan wording, in `normalizeStatusWording` form, as the parser gives it:
 * the place a scan names after `IN` is its location, so `OUT FOR DELIVERY IN
 * Isando` reads `out for delivery`. The tracker gives no codes. Only wording
 * seen on RAM's tracker is mapped; other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // Taken from the sender's premises, or handed in at a branch.
  ['consigned', 'accepted'],
  // Loaded into, and taken out of, a container at a hub.
  ['into container', 'in_transit'],
  ['out of container', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  // The driver's app recording the same delivery.
  ['rammobile delivered', 'delivered'],
]);

/** Wording followed by the other end of a road leg, such as `departed by road to Isando, Johannesburg`. */
const PREFIXES: readonly (readonly [string, Stage])[] = [
  ['departed by road to ', 'in_transit'],
  ['arrived by road from ', 'in_transit'],
];

/** A failed delivery, alone or followed by ` - ` and the reason; the parcel goes out again. */
const FAILED: readonly string[] = [
  // Spelled so on the tracker.
  'unsuccessfull delivery',
  'rammobile nondelivery',
];

const GAPS = [
  { wording: 'pod returned', note: 'The signed proof of delivery back at the branch after the delivery; it moves nothing.' },
  { wording: 'pod captured', note: 'The signed proof of delivery filed after the delivery; it moves nothing.' },
  { wording: 'outgoing sms - consignment has been dispatched for delivery attempt',
    note: 'A record of the text telling the recipient the parcel is out; the round\'s own scan carries the stage.' },
  { wording: 'outgoing email - consignment has been dispatched for delivery attempt',
    note: 'A record of the email telling the recipient the parcel is out; the round\'s own scan carries the stage.' },
  { wording: 'outgoing call - follow up account query', note: 'A call RAM made about the parcel; it moves nothing.' },
  { wording: 'incoming call - account query', note: 'A call RAM took about the parcel; it moves nothing.' },
  { wording: 'incoming call - arrangements made', note: 'A call RAM took to arrange the delivery; it moves nothing.' },
] as const;
const NOTES: ReadonlySet<string> = new Set(GAPS.map(({ wording }) => wording));
// The record of a message, a call or the proof of delivery, which moves nothing whatever it says.
const NOTICE = /^(?:(?:outgoing|incoming) (?:sms|email|call)\b|pod )/;

/** The stage RAM's own wording gives a scan. */
export function ramMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  const mapped = WORDINGS.get(key) ?? PREFIXES.find(([prefix]) => key.length > prefix.length && key.startsWith(prefix))?.[1];
  return mapped ?? (FAILED.some((failed) => key === failed || key.startsWith(`${failed} - `)) ? 'failed_attempt' : undefined);
}

/** A scan's stage: RAM's wording, else the shared rules, else nothing. */
export function ramStage(wording: string): ClassifiedWording | null {
  const mapped = ramMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const key = normalizeStatusWording(wording);
  if (NOTES.has(key) || NOTICE.test(key)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The tracker gives no codes.
  stage: (code, wording) => (code ? undefined : ramMappedStage(wording)),
  gaps: GAPS,
};
