import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The order statuses of 5Post's app, as its `GET /v3/mobile/order-statuses`
 * words them. A history row names the warehouse in the wording of
 * WAREHOUSE_PROCESSING and READY_FOR_SHIPMENT, such as "Покинул склад РЦ …".
 * An uncollected parcel's statuses start with "Не востребован" and a
 * cancelled order's with "Отменён"; such a parcel is on its way back, though
 * one taken from its pickup point can still be sent to another point.
 */
const CODES: ReadonlyMap<string, readonly [Stage, string]> = new Map([
  ['INFORMATION_RECEIVED', ['registered', 'Ожидается передача заказа в 5post']],
  ['INCEPTION_PROBLEM', ['exception', 'Проблема']],
  ['PROCESS_WITHDRAWN', ['accepted', 'Передан службе доставки']], // The sender left the parcel at a pickup point.
  ['WAREHOUSE_PROCESSING', ['in_transit', 'Обрабатывается на складе']],
  ['READY_FOR_SHIPMENT', ['in_transit', 'Покинул склад']],
  ['DELIVERED', ['ready_for_pickup', 'Доставлен в пункт выдачи']], // Waiting at the pickup point or locker.
  ['DONE', ['delivered', 'Получен']],
  ['UNCLAIMED_APPROVED', ['returned', 'Не востребован. Ожидается передача заказа в 5post']],
  ['UNCLAIMED_TRANSFERRED_TO_DELIVERY_SERVICE', ['returned', 'Не востребован. Передан службе доставки']],
  ['UNCLAIMED_RECEIVED_IN_WAREHOUSE', ['returned', 'Не востребован. Обрабатывается на складе']],
  ['UNCLAIMED_SHIPPED', ['returned', 'Не востребован. Покинул склад']],
  ['UNCLAIMED_RETURN_TO_PARTNER', ['returned', 'Возвращен партнеру']],
  ['UNCLAIMED_PLACED_IN_POSTAMAT', ['returned', 'Не востребован. Доставлен в пункт выдачи']], // At a point for the sender.
  ['UNCLAIMED_READY_FOR_REPICKUP', ['in_transit', 'Готов к повторной доставке']], // To be sent to a pickup point again.
  ['UNCLAIMED_RECEIVED_IN_COURIER_WAREHOUSE', ['returned', 'Не востребован. Обрабатывается на складе курьерской службы']],
  ['UNCLAIMED_RETURNING_TO_PARTNER', ['returned', 'Не востребован. Возвращается отправителю']],
  ['RETURNING_BY_EXPRESS_DELIVERY', ['returned', 'Не востребован. Возвращается курьерской службой']],
  ['LOST', ['exception', 'Утерян']],
  ['UTILIZED', ['exception', 'Утилизирован']],
  ['CANCELLED', ['exception', 'Отменен']],
  ['CANCELLED_APPROVED', ['exception', 'Отменён. Ожидается передача заказа в 5post']], // Cancelled before 5Post had it.
  ['CANCELLED_TRANSFERRED_TO_DELIVERY_SERVICE', ['returned', 'Отменён. Передан службе доставки']],
  ['CANCELLED_SHIPPED', ['returned', 'Отменён. Покинул склад']],
  ['CANCELLED_RECEIVED_IN_WAREHOUSE', ['returned', 'Отменён. Обрабатывается на складе']],
  ['CANCELLED_PLACED_IN_POSTAMAT', ['returned', 'Отменён. Доставлен в пункт выдачи']],
  ['CANCELLED_RETURNING_BY_COURIER', ['returned', 'Отменен. Возвращается курьером']],
  ['CANCELLED_RETURNING_TO_PARTNER', ['returned', 'Отменен. Возвращается отправителю']],
  ['CANCELLED_IN_INTERNATIONAL_TRANSIT', ['exception', 'Отменён. Обратитесь к продавцу']],
  ['RETURNED_TO_PARTNER', ['returned', 'Отправлен в интернет-магазин']],
  ['RETURNED_TO_CLIENT', ['returned', 'Возвращен отправителю']],
  ['REGISTRATION_ERROR_INCORRECT_PHONE_NUMBER', ['exception', 'Ошибка регистрации заказа: требуется уточнить номер телефона']],
  ['REGISTRATION_ERROR_INCORRECT_DELIVERY_DATE', ['exception', 'Ошибка регистрации заказа: требуется уточнить дату доставки']],
  ['REGISTRATION_ERROR_INCORRECT_CLIENT_ADDRESS', ['exception', 'Ошибка регистрации заказа: требуется уточнить адрес доставки']],
  // Courier delivery to the door.
  ['EXPRESS_DELIVERY_PREPARATION', ['in_transit', 'Подготовка к передаче курьерской службе']],
  ['RECEIVED_BY_EXPRESS_DELIVERY', ['in_transit', 'Передан курьерской службе']],
  ['RECEIVED_IN_COURIER_WAREHOUSE', ['in_transit', 'Обрабатывается на складе курьерской службы']],
  ['RECEIVED_BY_COURIER', ['out_for_delivery', 'Передан курьеру']],
  ['RETURNING_BY_COURIER', ['failed_attempt', 'Неуспешная попытка вручения']],
  ['RECEIVED_IN_WAREHOUSE_AFTER_ATTEMPTED_DELIVERY', ['failed_attempt', 'Вернулся после неуспешной попытки доставки на склад партнера']],
  // Parcels from abroad. The customs rows are the broker's, beside 5Post's own.
  ['CUSTOMS_AWAITING_PAYMENT', ['customs', 'Требуется оплата таможенных платежей']],
  ['CUSTOMS_CLEARANCE_STARTED', ['customs', 'Начато таможенное оформление']],
  ['CUSTOMS_CLEARANCE_COMPLETED', ['in_transit', 'Таможенное оформление завершено']],
  ['CUSTOMS_DATA_REQUIRED', ['customs', 'Требуется предоставить данные таможенному представителю']],
  ['CUSTOMS_CLEARANCE_REJECTED', ['exception', 'Отказано таможней в выпуске']],
  ['CUSTOMS_SENT_TO_COURIER', ['in_transit', 'Подготовлено к передаче 5post']],
  ['CUSTOMS_RETURNED_TO_STORE', ['returned', 'Возврат в интернет-магазин']],
  ['IN_INTERNATIONAL_TRANSIT_SHIPPED_FROM_WAREHOUSE', ['in_transit', 'В пути на таможню в стране отправления. Обычно занимает до 10 дней']],
  ['IN_INTERNATIONAL_TRANSIT_CUSTOMS_CLEARANCE_STARTED_ORIG', ['customs', 'Начато таможенное оформление в стране отправления']],
  ['IN_INTERNATIONAL_TRANSIT_CUSTOMS_CLEARANCE_COMPLETED', ['in_transit', 'Таможенное оформление завершено']],
  ['IN_INTERNATIONAL_TRANSIT_LINEHAUL_TRANSIT_DEPARTURE', ['in_transit', 'Отправлен в страну назначения']],
  ['IN_INTERNATIONAL_TRANSIT_CUSTOMS_CLEARANCE_STARTED_DEST', ['customs', 'Начато таможенное оформление в стране назначения']],
  ['IN_INTERNATIONAL_TRANSIT_DATA_REQUIRED', ['customs', 'Требуется предоставить данные таможенному представителю']],
  ['IN_INTERNATIONAL_TRANSIT_READY_FOR_5POST', ['in_transit', 'Подготовлено к передаче 5post']],
  ['RECEIVED_BY_AIR_CARRIER', ['in_transit', 'Передан авиаперевозчику']],
  ['DEPARTED_BY_AIR', ['in_transit', 'Отправлен авиарейсом']],
  ['DELIVERED_BY_AIR', ['in_transit', 'Доставлен авиарейсом']],
  ['RETURNING_BY_AIR_CARRIER', ['returned', 'Возвращается авиаперевозчиком']],
]);

/** Statuses that say nothing about where the parcel is or how its journey ended. */
const UNSTAGED: ReadonlyMap<string, string> = new Map([
  ['UNDEFINED', 'В работе'],
  ['COMPLETED_BY_PARTNER', 'Заказ перешел в терминальный статус на стороне партнера'],
]);

/** The stage the map gives a status code. */
export function fivePostMappedStage(code: string): Stage | undefined {
  return CODES.get(code)?.[0];
}

/** How the app words a status code, when the map knows it. */
export function fivePostWording(code: string): string | undefined {
  return CODES.get(code)?.[1] ?? UNSTAGED.get(code);
}

/** A status's stage: its code, else the shared wording rules for a code the map does not know, else nothing. */
export function fivePostStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = fivePostMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? fivePostMappedStage(code) : undefined),
  gaps: [
    { code: 'UNDEFINED', note: '"В работе", in progress: an order status that says nothing of where the parcel is. One followed a loss in the history.' },
    { code: 'COMPLETED_BY_PARTNER', note: 'The sender closed the order on its side, which does not say whether the parcel was delivered or went back.' },
  ],
};
