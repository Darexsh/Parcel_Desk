import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SAT's state codes (`statusRef`), which its tracker page reads to light the
 * four steps of its progress bar: at a SAT branch, on the road, arrived at
 * the delivery branch, received. Another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['Создан', 'registered'], // The waybill is made out.
  // "Заявлено до відправки": the sender listed the waybill for a SAT pickup; the page lights no step.
  ['ДобавленВВедомостьПередачи', 'registered'],
  ['Принят', 'accepted'], // Accepted at a branch.
  ['ВПути', 'in_transit'], // Left the branch.
  ['ОжидаетПередачиВПартнерскуюПочтовуюСеть', 'in_transit'], // Waiting for a partner's network.
  ['ПрибылНаНачальныйТерминал', 'in_transit'],
  ['ВыехалСНачальногоТерминала', 'in_transit'],
  ['ПрибылНаКонечныйТерминал', 'in_transit'],
  ['ВыехалСКонечногоТерминала', 'in_transit'],
  ['ЗадерживаетсяВПути', 'in_transit'], // Delayed on the road; the page keeps it on the road step.
  ['Переадресован', 'in_transit'], // Sent to another branch.
  // At the delivery branch, waiting for the courier who takes it to the door.
  ['ОжидаетПередачиКурьеру', 'in_transit'],
  ['ПереданКурьеру', 'out_for_delivery'],
  ['ПоступилНаСкладВыдачи', 'ready_for_pickup'], // Arrived at the branch that issues it.
  ['ПопыткаДоставки', 'failed_attempt'],
  ['ВыданПолучателю', 'delivered'], // Issued at the branch.
  ['ДоставленПолучателю', 'delivered'], // Brought to the recipient.
]);

/** The stage SAT's codes give a state code. */
export function satMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A state's stage: its code, else the shared wording rules, else nothing. */
export function satStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = satMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? satMappedStage(code) : undefined),
  gaps: [
    { code: 'Списан', note: 'A written-off waybill, which the tracker page reports as not found; the adapter answers not found too.' },
  ],
};
