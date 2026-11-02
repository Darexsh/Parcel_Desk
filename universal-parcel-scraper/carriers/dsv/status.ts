import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * myDSV names each row of a shipment's history with a date type: the booking,
 * the pickup, the departure and arrival at each port and the handover at the
 * end. The same codes name the page's date filters. The former DB Schenker
 * tracker names a road shipment's rows with three-letter event codes; the two
 * sets share only DEP, a departure in both.
 */
const CODES: Readonly<Record<string, Stage>> = {
  BOOKING: 'registered',
  CREATION: 'registered',
  // The cargo reached DSV, at a terminal or from the pickup.
  IRP: 'accepted',
  ACTUAL_PICKUP: 'accepted',
  DEP: 'in_transit',
  ATD: 'in_transit',
  ARV: 'in_transit',
  ATA: 'in_transit',
  // The end of DSV's responsibility for the cargo, which completes the shipment.
  Z70: 'delivered',
  HANDOVER: 'delivered',
  ACTUAL_DELIVERY: 'delivered',
  // Former DB Schenker road shipments.
  ENT: 'registered',
  COT: 'registered',
  COL: 'accepted',
  DET: 'accepted',
  // Not collected: the pickup failed.
  NCL: 'exception',
  ENM: 'in_transit',
  MAN: 'in_transit',
  ARR: 'in_transit',
  TIN: 'in_transit',
  VLO: 'in_transit',
  VUL: 'in_transit',
  TLO: 'in_transit',
  TUL: 'in_transit',
  VTL: 'in_transit',
  VTU: 'in_transit',
  // Held back from the load it was planned on; a reason says why.
  NLO: 'exception',
  CCL: 'customs',
  CCF: 'in_transit',
  DOT: 'out_for_delivery',
  NDL: 'failed_attempt',
  DIS: 'ready_for_pickup',
  DIF: 'ready_for_pickup',
  DLV: 'delivered',
  PUP: 'delivered',
  PUF: 'delivered',
  // The electronic proof of delivery, which follows the delivery.
  POD: 'delivered',
};

// Dates DSV plans or a customer asked for: not scans.
const ESTIMATES = new Map<string, string>([
  ['ETD', 'The estimated departure from a port.'],
  ['ETA', 'The estimated arrival at a port.'],
  ['ESTIMATED_PICKUP', 'The estimated pickup.'],
  ['REQUESTED_PICKUP', 'The pickup the booking asked for.'],
  ['ESTIMATED_DELIVERY', 'The estimated delivery; the adapter reads it as the delivery estimate.'],
  ['REQUESTED_DELIVERY', 'The delivery the booking asked for.'],
]);
const ESTIMATE_WORDING = /^(?:estimated|requested|expected|planned)\b/i;

/** Whether a row is a planned or requested date rather than something that happened. */
export function isDsvEstimate(code: string, wording: string): boolean {
  return ESTIMATES.has(code) || /^(?:ESTIMATED|REQUESTED)_/.test(code) || ESTIMATE_WORDING.test(wording.trim());
}

export function dsvCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

/**
 * A row's stage from its code, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function dsvStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = dsvCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (isDsvEstimate(code, wording)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: code => (code ? dsvCodeStage(code) : undefined),
  gaps: [...ESTIMATES].map(([code, note]) => ({ code, note: `${note} An estimate, not a scan: the adapter leaves it out of the history.` })),
};
