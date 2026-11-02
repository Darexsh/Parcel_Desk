import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * CDEK names each milestone of an order and each scan within it with a code
 * of its own, such as SENT_TO_NEXT_CITY, and words it in Russian. Milestones
 * and scans share one vocabulary: an order's creation and its arrival at a
 * pickup point are both.
 */
const CODES: Readonly<Record<string, Stage>> = {
  // Milestones, as the app lists them.
  CREATED: 'registered',
  IN_PROGRESS: 'in_transit',
  COURIER_IN_PROGRESS: 'out_for_delivery',
  READY_FOR_PICK_UP: 'ready_for_pickup',
  DELIVERED: 'delivered',
  // The recipient took part of the order and refused the rest.
  PARTIALLY_DELIVERED: 'delivered',
  // "Не вручён": the order ended without reaching its recipient, who did not collect it or refused it.
  NOT_DELIVERED: 'exception',
  CANCELLED: 'exception',
  // Scans.
  // A courier is on the way to collect the order from its sender.
  COURIER_APPOINTED: 'registered',
  // "Курьер забрал заказ у отправителя": collected from the sender.
  COURIER_DELIVERY_COMPLETED: 'accepted',
  ACCEPTED_FOR_DELIVERY: 'accepted',
  // An order from abroad entered CDEK's Russian network.
  ACCEPTED_AT_RUSSIA: 'in_transit',
  SENT_TO_SORTING_CENTER: 'in_transit',
  ACCEPTED_AT_SORTING_CENTER: 'in_transit',
  SENT_TO_NEXT_CITY: 'in_transit',
  // The courier point is the depot couriers deliver from.
  SENT_TO_COURIER_POINT: 'in_transit',
  ACCEPTED_AT_COURIER_POINT: 'in_transit',
  SENT_TO_PICK_UP_POINT: 'in_transit',
  // "Выдан курьеру": handed to the courier who delivers it.
  PICKED_UP_BY_COURIER: 'out_for_delivery',
  COURIER_DELIVERY_FAILED: 'failed_attempt',
};

/** The stage a CDEK code gives a milestone or scan, if the map knows it. */
export function cdekStage(code: string): Stage | undefined {
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

// ParcelsApp relays CDEK's scans as labels that name the leg of the trip
// rather than a code. Each keeps its relayed wording.
const RELAYED: ReadonlyArray<readonly [label: string, stage: Stage]> = [
  ['Принят в городе отправителя', 'accepted'],
  ['Отправлен в город получателя', 'in_transit'],
  ['В транзитном городе', 'in_transit'],
  ['Принят в городе получателя', 'in_transit'],
  ['На доставке у курьера', 'out_for_delivery'],
  ['Вручено', 'delivered'],
];

const key = (label: string) => label.trim().replace(/\.+$/, '').toLocaleLowerCase('ru');
const BY_LABEL = new Map(RELAYED.map(([label, stage]) => [key(label), stage]));

/** The stage of one CDEK scan label a provider relays, with its wording unchanged. */
export function cdekScan(label: string): { stage: Stage; wording: string } | undefined {
  const stage = BY_LABEL.get(key(label));
  return stage && { stage, wording: label };
}

/** A code alone gives the stage; a relayed label without one gives it by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? cdekStage(code) : cdekScan(wording)?.stage),
  gaps: [
    { code: 'UNKNOWN', note: "The app's milestone for a state it cannot name; it says nothing about where the order is." },
  ],
};
