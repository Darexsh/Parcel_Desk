import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * L-POST's delivery statuses by the code its API manual classifies them with,
 * which the tracking page's summary carries as `TXT_Status`. A delivery to a
 * pickup point waits there for collection at `PLACED_IN_PICKUP_POINT`; a
 * courier delivery waits there for the courier, so that code alone has no
 * stage. `ARCHIVE` closes the books and moves nothing.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['CREATED', 'registered'],
  ['ACT_CREATED', 'registered'], // On a handover act: the shop has yet to hand the parcel over.
  ['READY_FOR_RETURN', 'accepted'], // Dropped at a pickup point, ready to go to the L-POST warehouse.
  ['SENT_TO_WAREHOUSE', 'in_transit'],
  ['ARRIVED_AT_THE_WAREHOUSE', 'in_transit'],
  ['ACCEPTED_BY_PLACES', 'in_transit'],
  ['SENT_TO_PICKUP_POINT', 'in_transit'],
  ['ISSUED_TO_COURIER', 'out_for_delivery'],
  ['RECEIVED', 'delivered'], // Handed over by the courier.
  ['DONE', 'delivered'], // All or part of the order bought out.
  ['CANCELLED', 'returned'], // A full return: uncollected, refused or called off.
]);

/**
 * The tracking page's numeric status ids (`ID_Status`, `ID_StatusNew`) whose
 * code a reply has shown beside them.
 */
const IDS: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // CREATED
  ['4', 'registered'], // ACT_CREATED
  ['10', 'returned'], // CANCELLED
]);

/** The page's own wordings, and the manual's for the delivery statuses the page has not been seen to word. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['создано', 'registered'],
  ['создан акт', 'registered'],
  ['готово к отгрузке со склада интернет-магазина', 'registered'],
  ['готово к отгрузке на склад л-пост', 'accepted'],
  ['отправлено на склад л-пост', 'in_transit'],
  ['прибыло на склад', 'in_transit'],
  ['принято по местам', 'in_transit'],
  ['отправлено в пункт доставки', 'in_transit'],
  ['выдано курьеру', 'out_for_delivery'],
  ['выдано получателю', 'delivered'],
  ['выполнено', 'delivered'],
  ['аннулировано', 'returned'],
]);

const PLACED_CODE = 'PLACED_IN_PICKUP_POINT';
const PLACED_WORDING = 'размещено в пункте доставки';
// A history row of the return classifier: the page flags it and the adapter prefixes its id with R.
const RETURN_ROW = /^R\d+$/;
// The return classifier's own wordings, which share codes with delivery statuses.
const RETURN_WORDINGS = new Set(['готово к возврату', 'возвращено партнеру']);

/** The stage a status's code or wording gives, when that does not depend on the delivery method. */
export function lPostMappedStage(code: string | null, wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if ((code && RETURN_ROW.test(code)) || RETURN_WORDINGS.has(normalized)) return undefined;
  return (code ? CODES.get(code) ?? IDS.get(code) : undefined) ?? WORDINGS.get(normalized);
}

/**
 * A status's stage. A parcel placed at its last-mile point is ready for
 * collection there, or waits for its courier, which is still transit. A
 * return has none: a return of some items can follow a delivery, and a full
 * return is the delivery's own `CANCELLED`.
 */
export function lPostStage(code: string | null, wording: string, courier: boolean): ClassifiedWording | null {
  if (code && RETURN_ROW.test(code)) return null;
  if (code === PLACED_CODE || normalizeStatusWording(wording) === PLACED_WORDING) {
    return { stage: courier ? 'in_transit' : 'ready_for_pickup', source: 'carrier_map' };
  }
  const stage = lPostMappedStage(code, wording);
  return stage ? { stage, source: 'carrier_map' } : null;
}

const RETURN_NOTE = 'A status of a return of the order\'s items, which can be the part the recipient refused at a delivery; it does not move the delivery, whose own CANCELLED marks a full return.';

export const statusMap: CarrierStatusMap = {
  codeKey: (code) => (RETURN_ROW.test(code) ? 'R' : code),
  stage: (code, wording) => lPostMappedStage(code, wording),
  gaps: [
    { code: 'R', note: RETURN_NOTE },
    { code: 'READY_FOR_RETURN', wording: 'готово к возврату', note: RETURN_NOTE },
    { code: 'RETURNED_TO_PARTNER', note: RETURN_NOTE },
    { code: 'ARCHIVE', note: 'Every process for the parcel, financial ones included, is closed; it moves nothing.' },
  ],
};
