import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * PDN Express's status codes, which the page names beside each scan. Only
 * codes seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['D800', 'registered'], // Pre-alert: the merchant's data, before PDN has the parcel.
  ['D830', 'in_transit'], // In Transit: depot scans, the courier's collection, a parcel back at the depot.
  ['D840', 'out_for_delivery'],
  ['D850', 'exception'], // Delivery Exception: a delay; an attempt that did not deliver is read from its wording.
  ['D814', 'exception'], // Incorrect address: the courier gives up on the address, and a return follows.
  ['D860', 'delivered'],
  ['D890', 'returned'], // Returned to Sender: back to the merchant's warehouse.
]);

// PDN's own intake scan, the first with the parcel in hand, under In Transit.
const RECEIVED = /^we've got your package\b/i;
// A delivery exception after a visit: the courier found nobody, or not the address.
const NOT_DELIVERED = /^unable to deliver\b/i;
// Update Message: a note such as the recipient's confirmed address. It moves nothing.
const NOTICE = 'D810';

/** The stage PDN Express's codes give a scan, read with its wording where a code covers several milestones. */
export function pdnExpressMappedStage(code: string, wording: string): Stage | undefined {
  const key = code.toUpperCase();
  if (key === 'D830' && RECEIVED.test(wording.trim())) return 'accepted';
  if (key === 'D850' && NOT_DELIVERED.test(wording.trim())) return 'failed_attempt';
  return CODES.get(key);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function pdnExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = pdnExpressMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code.toUpperCase() === NOTICE) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? pdnExpressMappedStage(code, wording) : undefined),
  gaps: [
    { code: NOTICE, note: 'An update message, such as the recipient confirming the address; it moves nothing.' },
  ],
};
