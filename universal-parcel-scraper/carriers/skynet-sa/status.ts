import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SkyNet South Africa's scan wording, in `normalizeStatusWording` form. The
 * tracker gives no codes. Only wording seen on SkyTrack is mapped; other
 * wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['created waybill', 'registered'],
  // Taken from the sender, or from the airport for a parcel flown in.
  ['collected by courier', 'accepted'],
  ['flight landed', 'in_transit'],
  ['received from airline', 'in_transit'],
  // Scanned for one of SkyNet's in-house clients at the branch that took the parcel from the airline.
  ['in-house-client scan', 'in_transit'],
  ['scan into branch', 'in_transit'],
  // Received by the customs agent.
  ['rec cust agent', 'customs'],
  ['released from customs', 'in_transit'],
  ['dispatch from airport', 'in_transit'],
  ['out on delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** Wording followed by the branch's name or the reason, such as `Received In Branch Cape Town`. */
const PREFIXES: readonly (readonly [string, Stage])[] = [
  ['received in branch ', 'in_transit'],
  // A delivery that did not happen, with the reason; the parcel goes out again.
  ['delivery exception: ', 'failed_attempt'],
];

const GAPS = [
  { wording: 'customs duties paid', note: 'The duty recorded as paid, filed with the waybill\'s creation before the parcel landed; it moves nothing.' },
  { wording: 'pod created', note: 'The proof of delivery filed on the delivery\'s own clock; the delivery scan carries the stage.' },
  { wording: 'pod image scanned', note: 'The signed proof of delivery scanned into the system after the delivery; it moves nothing.' },
  { wording: 'email : first time parcel out for delivery at delivery branch',
    note: 'A record of the email telling the recipient the parcel is out for delivery; the round\'s own scan carries the stage.' },
] as const;
const NOTES: ReadonlySet<string> = new Set(GAPS.map(({ wording }) => wording));
// The record of a message to the recipient, which moves nothing.
const EMAIL = /^email\s*:/;

/** The stage SkyNet South Africa's own wording gives a scan. */
export function skynetSaMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? PREFIXES.find(([prefix]) => key.length > prefix.length && key.startsWith(prefix))?.[1];
}

/** A scan's stage: SkyNet South Africa's wording, else the shared rules, else nothing. */
export function skynetSaStage(wording: string): ClassifiedWording | null {
  const mapped = skynetSaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const key = normalizeStatusWording(wording);
  if (NOTES.has(key) || EMAIL.test(key)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The tracker gives no codes.
  stage: (code, wording) => (code ? undefined : skynetSaMappedStage(wording)),
  gaps: GAPS,
};
