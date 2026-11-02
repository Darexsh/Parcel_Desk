import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * CSE's event names, as its tracker words them for an order (before the
 * pickup) and for its waybill. The tracker sends no codes. "Информация по
 * отправлению" and "Оформлена добавочная накладная" name only a kind of
 * event, so the adapter words them with the reason they carry, as in
 * "Информация по отправлению. Получатель/ компания на адресе не найдены".
 * Older names come from the Cargo 3 portal cse.ru embedded before, and from
 * CSE's API documentation.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The order, before a courier collects it.
  ['принят. идет обработка', 'registered'],
  ['заказ принят, идет обработка заказа.', 'registered'],
  ['заказ создан', 'registered'],
  ['на основании заказа оформлена накладная', 'registered'],
  ['на основании заказа оформлена накладная.', 'registered'],
  ['накладная сохранена, но ещё не была обработана', 'registered'],
  ['зарегистрирована накладная', 'registered'],
  ['отправление создано', 'registered'],
  // The courier on the way to the sender.
  ['курьер уже в пути', 'registered'],
  ['отправлен курьер.', 'registered'],
  ['отправление забрано', 'accepted'],
  ['отправление получено курьером', 'accepted'],
  ['груз забран', 'accepted'],
  ['заказ принят на складе службы доставки', 'accepted'],
  ['груз получен на склад кс', 'in_transit'],
  ['отправление подготовлено к отправке', 'in_transit'],
  ['отправление выбыло со склада.', 'in_transit'],
  ['отправление в пути', 'in_transit'],
  ['отправление прибыло в город', 'in_transit'],
  ['заказ поступил в город назначения', 'in_transit'],
  // Parcels from China, before they reach Russia.
  ['отправление поступило на склад (китай)', 'in_transit'],
  ['груз в транзите китай-россия', 'in_transit'],
  // Taken back from the pickup point to CSE's office.
  ['груз выбыл из пвз', 'in_transit'],
  ['груз передан на доставку', 'out_for_delivery'],
  ['ожидайте курьера сегодня', 'out_for_delivery'],
  ['информация по отправлению. получатель/ компания на адресе не найдены', 'failed_attempt'],
  ['ожидает в пункте выдачи', 'ready_for_pickup'],
  ['получатель самостоятельно заберет отправку из офиса кс.', 'ready_for_pickup'],
  ['доставка завершена', 'delivered'],
  ['отправление доставлено получателю', 'delivered'],
  ['заказ выполнен.', 'delivered'],
  // A return waybill for the cargo, issued after the delivery run.
  ['оформлена добавочная накладная. возврат груза', 'returned'],
]);

/** Events that move nothing: the parcel keeps the stage of the one before. */
const NOTICES: ReadonlyMap<string, string> = new Map([
  ['информация по отправлению', 'A note on the shipment whose reason the reply leaves out; it moves nothing.'],
  ['информация по отправлению. уточнение данных по накладной (доставке) клиентом',
    'The customer added details to the waybill or its delivery; it moves nothing.'],
  ['информация по отправлению. переадресация через виджет', 'The customer changed the delivery through CSE\'s widget; it moves nothing.'],
  ['параметры заказа были изменены', 'The order\'s delivery details were changed; it moves nothing.'],
  ['оформлена добавочная накладная', 'A supplementary waybill whose purpose the reply leaves out; it moves nothing.'],
  ['оформлена переадресация доставки', 'The delivery was redirected; the parcel keeps its stage.'],
  ['перенос доставки по запросу клиента', 'The delivery was postponed at the customer\'s request, an instruction rather than a problem.'],
]);

/** The stage the map gives an event's wording, if it knows it. */
export function cseMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** Whether an event's wording is a notice, which moves nothing. */
export function cseNotice(wording: string): boolean {
  return NOTICES.has(normalizeStatusWording(wording));
}

/**
 * An event's stage: its Russian wording from the map, else the shared rules on
 * the English name the reply sends beside it. A notice gets none.
 */
export function cseStage(wording: string, english = ''): ClassifiedWording | null {
  const mapped = cseMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (cseNotice(wording) || !english.trim()) return null;
  const worded = classifyWording(english, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => cseMappedStage(wording),
  gaps: [...NOTICES].map(([wording, note]) => ({ wording, note })),
};
