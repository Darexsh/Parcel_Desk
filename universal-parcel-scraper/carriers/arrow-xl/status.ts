import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scans on ArrowXL's tracker, in English without a code. A delivery goes
 * from the retailer's order data to a depot and a two-person crew. A
 * collection is the crew picking an item up from the customer for the
 * retailer: it is accepted once collected, and returned once sent on to the
 * retailer's returns site.
 */
const SCANS: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^order data (?:created|received)$/, 'registered'],
  [/^collection data created$/, 'registered'],
  // The crew is on its way to collect; the item is still with the customer.
  [/^out for collection$/, 'registered'],
  [/^collection success$/, 'accepted'],
  // The first scan in ArrowXL's network, before the delivering depot's.
  [/^stock received into network$/, 'accepted'],
  [/^stock received in delivery site$/, 'in_transit'],
  // Loaded on the delivery day; an attempt can follow without an out-for-delivery scan.
  [/^loaded onto delivery van$/, 'out_for_delivery'],
  [/^out for delivery$/, 'out_for_delivery'],
  // Followed by the reason, as "Unable To Deliver - No-One Home - Carded".
  [/^unable to deliver - .+$/, 'failed_attempt'],
  [/^delivery success(?: electronic signature captured)?$/, 'delivered'],
  // Held until the retailer sorts it out.
  [/^order held - contact supplier$/, 'exception'],
  [/^despatched to client return site$/, 'returned'],
];

// Bookings and plans for a delivery day, which the wording dates, and the
// customer service's notes: none moves the parcel.
const NOTICES: readonly RegExp[] = [
  /^(?:customer booked|route planned for|customer postponed) \d{2}-[a-z]{3}-\d{4}$/,
  /^available to make booking$/,
  /^customer contact - (?:details|address) updated$/,
  /^arrowxl will contact customer$/,
];

const key = (wording: string) => normalizeStatusWording(wording);

/** The stage ArrowXL's own wording gives a scan, if the map knows it. */
export function arrowXlMappedStage(wording: string): Stage | undefined {
  const text = key(wording);
  return SCANS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A booking, a plan or a note, which leaves the parcel where it was. */
export function isArrowXlNotice(wording: string): boolean {
  const text = key(wording);
  return NOTICES.some((pattern) => pattern.test(text));
}

/** A scan's stage: the map, else nothing for a notice, else the shared wording rules. */
export function arrowXlStage(wording: string): ClassifiedWording | null {
  const mapped = arrowXlMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (isArrowXlNotice(wording)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

const NOTE = 'A booking or a note from customer service; the parcel keeps the stage it had.';

/**
 * Scans come without a code. A booking, a route plan and a postponement
 * carry the day they are for in their wording, so only the undated notes can
 * be listed as gaps.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? arrowXlMappedStage(wording) : undefined),
  gaps: [
    { wording: key('Available To Make Booking'), note: 'The parcel is at the depot and the customer can book a delivery day; it moves nothing.' },
    { wording: key('Customer Contact - Details Updated'), note: NOTE },
    { wording: key('Customer Contact - Address Updated'), note: NOTE },
    { wording: key('Arrowxl Will Contact Customer'), note: NOTE },
  ],
};
