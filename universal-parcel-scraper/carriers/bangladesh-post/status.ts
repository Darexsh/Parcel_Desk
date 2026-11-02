import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The international tracker's scan wordings, mapped whole: the UPU IPS event
 * names Bangladesh Post's offices record, as its page spells them.
 */
export const BANGLADESH_POST_INTERNATIONAL_EVENTS: Readonly<Record<string, Stage>> = {
  // An item from abroad reaching the office of exchange.
  'Incomming': 'in_transit',
  // An office on the way, which need not be the one the item waits at.
  'Arrived at post office': 'in_transit',
  'Delivered': 'delivered',
};

/** The domestic tracker's status codes, which its page labels. */
export const BANGLADESH_POST_DOMESTIC_CODES: Readonly<Record<string, Stage>> = {
  Item_Booked: 'accepted',
  Receive_Item: 'in_transit',
  Forwarded: 'in_transit',
  // The bag the item travels in, moved between offices.
  Bag_Movement: 'in_transit',
  // The page's tests for a delivered or returned item; spelled this way.
  Delivered_To_Receipent: 'delivered',
  Return_To_Sender: 'returned',
  // A delivery that failed, with the action the office set.
  NonDeliver: 'failed_attempt',
  // A booking the head office deleted at the sender's request.
  Item_Deleted: 'exception',
  // The former domestic tracker's script also checked for these closing statuses.
  Lost: 'exception',
  Garbage: 'exception',
  Expired: 'exception',
};

/** A rollback undoes the scan before it; the page reads the item as pending again. */
export const ROLLBACK = 'Item_Rollback';
/** The page's wording for a delivery, or a return to the sender, that a later scan of the item undid. */
export const UNDONE: Readonly<Record<string, string>> = {
  Delivered_To_Receipent: 'Delivered to customer was successful but due to rollback after set delivery attempt was unsuccessful',
  Return_To_Sender: 'Return to sender was successful but due to rollback set return item to sender was unsuccessful',
};

const INTERNATIONAL = new Map(Object.entries(BANGLADESH_POST_INTERNATIONAL_EVENTS)
  .map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const DOMESTIC = new Map(Object.entries(BANGLADESH_POST_DOMESTIC_CODES));
const UNDONE_WORDINGS = new Set(Object.values(UNDONE).map(normalizeStatusWording));

/** The stage the map gives an international scan's wording, if it knows it. */
export function bangladeshPostInternationalStage(wording: string): Stage | undefined {
  return INTERNATIONAL.get(normalizeStatusWording(wording));
}

/** The stage the map gives a domestic scan's code; an undone hand-over is a failed one, as the page marks it. */
export function bangladeshPostDomesticStage(code: string, wording = ''): Stage | undefined {
  if (Object.hasOwn(UNDONE, code) && UNDONE_WORDINGS.has(normalizeStatusWording(wording))) return 'failed_attempt';
  return DOMESTIC.get(code);
}

/** An international scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function bangladeshPostStage(wording: string): ClassifiedWording | null {
  const mapped = bangladeshPostInternationalStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Domestic scans carry the tracker's code, international ones only their wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? bangladeshPostDomesticStage(code, wording) : bangladeshPostInternationalStage(wording)),
  gaps: [
    { code: ROLLBACK, note: 'Undoes the scan before it: the page then reads a delivery or return before it as a failed one, and the item as pending again. The rollback itself moves nothing.' },
  ],
};
