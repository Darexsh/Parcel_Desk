import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** A status code's label on the tracker and its stage; null leaves it without one. */
type Entry = readonly [label: string, stage: Stage | null];

const IN_TRANSIT: Entry = ['In Transit', 'in_transit'];
const RETURN_STARTED: Entry = ['Return Initiated', 'returned'];
const RETURNED: Entry = ['Returned To Sender', 'returned'];

/**
 * The status codes the tracker on tracking.shreemaruti.com labels, with its
 * labels. It shows every hub, bag and dispatch scan as In Transit.
 */
const CODES: ReadonlyMap<string, Entry> = new Map([
  ['order_placed', ['Order Placed', 'registered']],
  ['accept', ['Order Placed', 'registered']],
  ['order_confirmed', ['Order Confirmed', 'registered']],
  ['ready_for_dispatch', ['Ready For Dispatch', 'registered']],
  ['error_order', ['Order Issue', 'exception']],
  ['pickup_scheduled', ['Pickup Scheduled', 'registered']],
  ['pickup_awaited', ['Pickup Pending', 'registered']],
  ['pickup_pending', ['Pickup Pending', 'registered']],
  ['pickup_rescheduled', ['Pickup Rescheduled', 'registered']],
  ['reschedule', ['Pickup Rescheduled', 'registered']],
  // The courier did not collect the parcel; it is still with its sender.
  ['not_picked_up', ['Pickup Failed', 'exception']],
  ['pickup_cancelled', ['Pickup Cancelled', 'exception']],
  ['pickup_completed', ['Picked Up', 'accepted']],
  ['pickedup', ['Picked Up', 'accepted']],
  ...['in_transit', 'departed', 'arrived', 'reachedathub', 'intransittohub', 'inscan_at_hub', 'inscanned_at_cp', 'outscan_at_hub',
    'outscan_to_cp', 'outscan_to_3pl', 'outscanned_by_cp', 'added_to_bag', 'bag_open', 'bag_close', 'item_dispatched',
    'item_redirect', 'item_return', 'clearance_completed'].map((code) => [code, IN_TRANSIT] as const),
  // At the delivery branch.
  ['ready_for_delivery', ['Ready For Delivery', 'in_transit']],
  ['out_for_delivery', ['Out For Delivery', 'out_for_delivery']],
  ['delivered', ['Delivered', 'delivered']],
  ['undelivered', ['Delivery Attempted', 'failed_attempt']],
  // Not delivered today and carried forward to the next day.
  ['carry_forward_to_next_day', ['Delivery Rescheduled', 'failed_attempt']],
  ['on_hold', ['On Hold', 'exception']],
  ['item_on_hold', ['On Hold', 'exception']],
  ['damaged', ['Shipment Damaged', 'exception']],
  ['lost', ['Shipment Lost', 'exception']],
  ['cancelled', ['Cancelled', 'exception']],
  ['rto', RETURN_STARTED],
  ['rto_initiated', RETURN_STARTED],
  ['return', RETURN_STARTED],
  ['rto_requested', ['Return Requested', 'returned']],
  ['rto_in_transit', ['Return In Transit', 'returned']],
  ['rto_out_for_delivery', ['Return Out For Delivery', 'returned']],
  ['rto_undelivered', ['Return Attempt Failed', 'returned']],
  ['rto_delivered', RETURNED],
  ['return_delivered', RETURNED],
  // A return called off: the parcel goes on to its recipient, which the next scan shows.
  ['rto_revoked', ['Return Cancelled', null]],
  ['return_revoked', ['Return Cancelled', null]],
]);

/** Bookkeeping rows the tracker leaves out of the history. */
const HIDDEN = new Set(['exception', 'cod_reconcile', 'pod_reconcile', 'softdata_update', 'consignment_verification']);

/** A status or category in the tracker's form: lower case, with underscores between words. */
export function shreeMarutiCode(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Whether the tracker leaves rows with this status out of the history. */
export function isHiddenShreeMarutiCode(code: string): boolean {
  return HIDDEN.has(code);
}

/** The stage Shree Maruti's status codes give a code, in `shreeMarutiCode` form. */
export function shreeMarutiMappedStage(code: string): Stage | undefined {
  return CODES.get(code)?.[1] ?? undefined;
}

export interface ShreeMarutiReading {
  /** The tracker's label for the row. */
  readonly label: string;
  readonly staged: ClassifiedWording | null;
  /** Whether the tracker counts the row as a movement between hubs. */
  readonly movement: boolean;
}

const MOVEMENT = /inscan|outscan|arrived|depart|connected|bag|manifest|in_transit/;
// A code of the way back to the sender.
const RETURN_LEG = /^(?:rto|return)_/;
const humanize = (code: string) => code.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * A row's label and stage, read as the tracker reads it: by its status code,
 * else by its category, else by the shape of an unknown code. An unknown code
 * of the way back is part of the return, whatever its words. A code none of
 * them settles keeps its own words and goes to the shared wording rules.
 */
export function shreeMarutiReading(status: string, category: string, wording: string): ShreeMarutiReading {
  const entry = CODES.get(status) ?? CODES.get(category);
  if (entry) {
    return { label: entry[0], staged: entry[1] ? { stage: entry[1], source: 'carrier_map' } : null, movement: entry === IN_TRANSIT };
  }
  if (MOVEMENT.test(status)) return { label: IN_TRANSIT[0], staged: { stage: 'in_transit', source: 'carrier_map' }, movement: true };
  const label = humanize(status) || 'Status Updated';
  if (RETURN_LEG.test(status)) return { label, staged: { stage: 'returned', source: 'carrier_map' }, movement: false };
  if (/(?:^|_)delivered$/.test(status) && !/undelivered/.test(status)) {
    return { label: 'Delivered', staged: { stage: 'delivered', source: 'carrier_map' }, movement: false };
  }
  const worded = classifyWording(wording || label, 'in_transit');
  return { label, staged: worded.source === 'none' ? null : worded, movement: false };
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? shreeMarutiMappedStage(code) : undefined),
  gaps: [
    { code: 'rto_revoked', note: 'A return called off; the parcel goes on to its recipient, which the next scan shows.' },
    { code: 'return_revoked', note: 'A return called off; the parcel goes on to its recipient, which the next scan shows.' },
  ],
};
