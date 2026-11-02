import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Border Express's tracking status codes, which the tracker's rows carry as
 * `integrationCode`. Codes seen in replies are mapped, and two more from the
 * tracker's own script: one whose wording the shared rules would misread, and
 * the final one beside it. Another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['SDR', 'registered'], // Shipment Data Received: the sender's details have arrived.
  ['PUP', 'accepted'],
  ['TRN', 'in_transit'],
  ['OBD', 'out_for_delivery'], // On Board For Delivery.
  // Partially Delivered: some units are delivered and the rest are still on their way.
  ['PAR', 'in_transit'],
  ['DEL', 'delivered'],
  // Partially Delivered - Final: the consignment closes with the units that arrived, and the
  // tracker shows it as delivered.
  ['FIN', 'delivered'],
]);

/**
 * The states of the sender's own booking, before Border Express has its data:
 * Editing, Unsaved, Invalid, Initial and Ready For Despatch. The tracker hides
 * their rows, and so does the adapter.
 */
export const BOOKING_CODES: ReadonlySet<string> = new Set(['EDI', 'PEN', 'INV', 'INI', 'ACT']);

/** The stage Border Express's codes give a status code. */
export function borderExpressMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A row's stage: its code, else the shared wording rules, else nothing. */
export function borderExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = borderExpressMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? borderExpressMappedStage(code) : undefined),
  gaps: [
    { code: 'PEN', note: 'Unsaved: the sender\'s own draft of the consignment before Border Express has its data. The tracker hides the row, and the adapter leaves it out.' },
  ],
};
