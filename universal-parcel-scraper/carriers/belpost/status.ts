import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Belpost's scan wordings, mapped whole: those of its Statuses and Events
 * page and of its tracker. Belpost's own scans and those another post reports
 * share them, each with its own numeric code, so the wording sets the stage.
 */
export const BELPOST_EVENTS: Readonly<Record<string, Stage>> = {
  'Принято от отправителя': 'accepted',
  // A First Class item, accepted and sent on without sorting scans.
  'Принято': 'accepted',
  'Поступило в обработку': 'in_transit',
  'Отправлено': 'in_transit',
  // At an office of exchange, on the way out of a country or into one.
  'Принято в обработку в учреждении международного почтового обмена': 'in_transit',
  'Направлено из страны по назначению': 'in_transit',
  'Направлено по назначению': 'in_transit',
  'Подготовлено для проведения таможенного контроля': 'customs',
  // Customs needs more data from the recipient, then has it.
  'Для проведения таможенного контроля необходимо уточнить данные': 'customs',
  'Введенные данные сохранены': 'customs',
  // Customs finished with the item, which moves on.
  'Завершение таможенного контроля': 'in_transit',
  // At the office that delivers the item or hands it out.
  'Поступило в учреждение доставки': 'ready_for_pickup',
  'Заложено в почтомат': 'ready_for_pickup',
  'Попытка доставки': 'failed_attempt',
  // Left in the parcel locker past its 72 hours and taken out.
  'Не получено через почтомат': 'exception',
  'Вручено': 'delivered',
  'Подготовлено для возврата': 'returned',
  'Вручено отправителю': 'returned',
  // A delivery scan made by mistake and cancelled.
  'Аннулирование операции вручения': 'exception',
  'Поступило на временное хранение нерозданных отправлений': 'exception',
  'Нерозданное отправление уничтожено': 'exception',
};

const EVENTS = new Map(Object.entries(BELPOST_EVENTS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function belpostEventStage(wording: string): Stage | undefined {
  return EVENTS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function belpostStage(wording: string): ClassifiedWording | null {
  const mapped = belpostEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The wording sets the stage whatever its code; Belpost's map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => belpostEventStage(wording),
  gaps: [],
};
