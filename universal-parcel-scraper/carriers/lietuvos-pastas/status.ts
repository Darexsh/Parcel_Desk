import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Every row names a public event type, which Lietuvos paštas lists in its
// self-service API documentation with the public state it belongs to. Types
// ending in a UPU event code (EDB, EXA and others) carry that code's meaning.
const CODES: Readonly<Record<string, Stage>> = {
  // The sender's label, before Lietuvos paštas has the parcel.
  LABEL_CREATED: 'registered',
  ACCEPTED: 'accepted',
  ACCEPTED_TERMINAL: 'accepted',
  // Collected from the sender's parcel locker.
  RECEIVED_TERMINAL_OUT: 'in_transit',
  RECEIVED_LC: 'in_transit',
  RECEIVED_SENDER_LC: 'in_transit',
  RECEIVED_RECEIVER_LC: 'in_transit',
  DEPARTED_RECEIVER_LC: 'in_transit',
  RECEIVED_DELIVERY_POST: 'in_transit',
  DELIVERY_TRANSFER: 'in_transit',
  DELIVERY_TRANSFER2: 'in_transit',
  DELIVERY_EXPORTED: 'in_transit',
  EXPORT_PENDING: 'in_transit',
  DELIVERY_REDIRECTING: 'in_transit',
  DELIVERY_EDD: 'in_transit',
  DELIVERY_EDE: 'in_transit',
  TRANSIT_EMJ: 'in_transit',
  TRANSIT_EMK: 'in_transit',
  // Released by customs.
  CUSTOMS_EDC: 'in_transit',
  CUSTOMS_EXC: 'in_transit',
  CUSTOMS_EDB: 'customs',
  CUSTOMS_EME: 'customs',
  CUSTOMS_EXA: 'customs',
  CUSTOMS_EXB: 'customs',
  CUSTOMS_ON_HOLD: 'customs',
  CUSTOMS_AWAITING_PAYMENT: 'customs',
  CUSTOMS_PREPAID: 'customs',
  CUSTOMS_DECLARATION_REQUIRED: 'customs',
  CUSTOMS_DECLARATION_REVIEW_PENDING: 'customs',
  CUSTOMS_DECLARATION_SUBMITTED: 'customs',
  TRANSFERRED_FOR_DELIVERY_COURIER: 'out_for_delivery',
  TRANSFERRED_FOR_DELIVERY_POSTMAN: 'out_for_delivery',
  DELIVERY_UNSUCCESSFUL_DELIVERY: 'failed_attempt',
  // In the recipient's parcel locker, or at a collection point.
  RECEIVED_TERMINAL: 'ready_for_pickup',
  DELIVERY_EDH: 'ready_for_pickup',
  DELIVERY_DELIVERED: 'delivered',
  // On its way back to the sender: not delivered and not back yet.
  DELIVERY_RETURNED: 'exception',
  DELIVERY_REFUNDING: 'exception',
  DELIVERY_PARCEL_LOST: 'exception',
  DELIVERY_DESTROY: 'exception',
  DELIVERY_EXX: 'exception',
  HANDED_TO_GOVERNMENT: 'exception',
  LABEL_CANCELLED: 'exception',
};

/** The types that send a parcel back: a delivery after one reaches the sender. */
export const RETURN_STARTS: ReadonlySet<string> = new Set(['DELIVERY_RETURNED', 'DELIVERY_REFUNDING']);

// Messages to and from the recipient: no movement, so the parcel keeps its stage.
const NOTICES = new Map<string, string>([
  ['NOTIFICATIONS_INFORMED', 'The recipient was told about the parcel.'],
  ['NOTIFICATIONS_PDA_UNABLE_TO_CONTACT', 'The courier could not reach the recipient.'],
  ['ORDERS_PARCEL_DEMAND', 'The recipient asked for the parcel.'],
]);

// Holds whose meaning for the delivery is unclear: the row's wording decides.
const UNSTAGED = new Map<string, string>([
  ['DELIVERY_EDA', 'A hold on arrival in the destination country; the type does not say why.'],
  ['DELIVERY_EDF', 'Held at the delivery office; the type does not say whether for collection or for a round.'],
  ['DELIVERY_EXD', 'Held at the office of exchange before leaving; the type does not say why.'],
  ['DELIVERY_HOLDING', 'Held; the type does not say where or why.'],
  ['DELIVERY_STORING', 'Stored; the type does not say whether for collection.'],
]);

export function lietuvosPastasCodeStage(code: string): Stage | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

export function isLietuvosPastasNotice(code: string): boolean {
  return NOTICES.has(code);
}

/**
 * A row's stage from the type map, else from the shared wording rules. A type
 * neither knows stays without a stage, so it remains visible for review.
 */
export function lietuvosPastasStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = lietuvosPastasCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every row carries its public event type; a type the map leaves open takes the wording's stage, as rows do. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code && !isLietuvosPastasNotice(code) ? lietuvosPastasStage(code, wording)?.stage : undefined),
  gaps: [
    ...[...NOTICES].map(([code, note]) => ({ code, note: `${note} Not a movement: the parcel keeps the stage it had.` })),
    ...[...UNSTAGED].map(([code, note]) => ({ code, note })),
  ],
};
