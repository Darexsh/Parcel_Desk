import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * 4Sides' events carry no code. The tracker words each as the event, then in
 * brackets the state the shipment is in: "Отправка из СЦ (У перевозчика)".
 * The event gives the stage; a state names one only for an event the map does
 * not know. The names are the tracker script's own, which compares them in
 * lower case with ё read as е.
 */
const EVENTS: ReadonlyMap<string, Stage> = new Map([
  ['создание', 'registered'],
  ['заказ создан', 'registered'],
  ['накладная создана', 'registered'],
  // Collected from the sender.
  ['сбор', 'accepted'],
  // Taken in at a sorting centre, which a history shows at the destination after
  // the departure from Moscow; the collection is the acceptance.
  ['прием', 'in_transit'],
  ['прием в сц', 'in_transit'],
  ['в сц', 'in_transit'],
  ['отправка из сц', 'in_transit'],
  ['отбытие из москвы', 'in_transit'],
  ['прибытие', 'in_transit'],
  // Handed to the airline or haulier that carries it between towns.
  ['у перевозчика', 'in_transit'],
  ['передано в доставку', 'out_for_delivery'],
  ['в доставке', 'out_for_delivery'],
  ['доставлено', 'delivered'],
  ['задержка в а/п', 'exception'],
  ['задержка авто', 'exception'],
  ['утеря', 'exception'],
  ['утеряно', 'exception'],
  ['уничтожение', 'exception'],
  ['уничтожено', 'exception'],
  ['возврат', 'returned'],
]);

/** The states, for an event the map does not know. */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['в сц', 'in_transit'],
  ['у перевозчика', 'in_transit'],
  ['в доставке', 'out_for_delivery'],
  ['доставлено', 'delivered'],
]);

// A delivery attempt names its result in its state: a delivery, else an attempt that failed.
const ATTEMPT = 'попытка доставки';
// "Event (state)", as the parser words a scan.
const STATED = /^(.*?)\s*\(([^()]*)\)$/;

/** The stage the map gives a scan's wording, if it knows it. */
export function foursidesMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording).replaceAll('ё', 'е');
  const [, event = key, state = ''] = STATED.exec(key) ?? [];
  if (event === ATTEMPT) return state === 'доставлено' ? 'delivered' : 'failed_attempt';
  return EVENTS.get(event) ?? STATES.get(state);
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function foursidesStage(wording: string): ClassifiedWording | null {
  const mapped = foursidesMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : foursidesMappedStage(wording)),
  gaps: [],
};
