import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scan codes of the tracker's history, with the English label its page
 * script shows for each (`scanCode` on the English page). The history's own
 * text has typos and follows the page's language, so the label is kept.
 */
export const GEODIS_PL_LABELS: Readonly<Record<string, string>> = {
  '10': 'Received from the sender',
  '14': 'Failed collection (SMS)',
  '15': 'Collected (SMS)',
  '20': 'Inbound Scan From Driver to Terminal',
  '30': 'Outbound Scan from (Collection) Terminal to Line-haul',
  '40': 'Inbound Scan from Line-haul to (Delivery) Terminal',
  '50': 'Outbound for Delivery',
  '60': 'Stopped at Collection Terminal',
  '61': 'Stopped at Hub',
  '62': 'Not Dispatched',
  '63': 'Failure',
  '64': 'Delivery Refusal',
  '65': 'Consignee Absent',
  '66': 'Awaiting Delivery',
  '67': 'Awaiting Decision',
  '68': 'Failed delivery (SMS)',
  '90': 'Delivered (SMS)',
  '100': 'Delivered',
  '300': 'Pseudoscan – delete all previous 100, 400, 500 scans',
  '400': 'Request for Return',
  '450': 'Awaiting designation of new delivery date',
  '500': 'Claim Received',
};

const CODES: ReadonlyMap<string, Stage> = new Map([
  ['10', 'accepted'],
  ['15', 'accepted'],
  // The driver could not collect the shipment from the sender.
  ['14', 'exception'],
  ['20', 'in_transit'],
  ['30', 'in_transit'],
  ['40', 'in_transit'],
  ['50', 'out_for_delivery'],
  // Held at a terminal or a hub ("zatrzymana"), and a breakdown ("awaria").
  ['60', 'exception'],
  ['61', 'exception'],
  ['63', 'exception'],
  // Missed its line-haul or round ("nie wyjechała"): a delay, still in the network.
  ['62', 'in_transit'],
  ['64', 'exception'],
  ['65', 'failed_attempt'],
  ['68', 'failed_attempt'],
  // Waiting at the delivery terminal for a round, or for a new delivery date.
  ['66', 'in_transit'],
  ['450', 'in_transit'],
  // Waiting for the sender's instructions.
  ['67', 'exception'],
  // A return instruction: the shipment is on its way back, not yet returned.
  ['400', 'exception'],
  ['90', 'delivered'],
  ['100', 'delivered'],
]);

/** Cancels the delivery, return and claim scans before it; it moves nothing itself. */
export const GEODIS_PL_CANCEL = '300';
/** The scans a cancelling pseudo-scan removes. */
export const GEODIS_PL_CANCELLED = new Set(['100', '400', '500']);
/** A claim filed with the carrier: a record about the shipment, not a movement. */
export const GEODIS_PL_CLAIM = '500';

/** The stage a scan code gives, if any. */
export function geodisPlCodeStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function geodisPlStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code === GEODIS_PL_CLAIM || code === GEODIS_PL_CANCEL) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code) : undefined),
  gaps: [
    { code: GEODIS_PL_CLAIM, note: 'A claim filed with the carrier, not a movement: the shipment keeps the stage it had.' },
    { code: GEODIS_PL_CANCEL, note: 'A bookkeeping row that cancels earlier delivery, return and claim scans; the adapter drops it with them.' },
  ],
};
