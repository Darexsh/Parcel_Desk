import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The order's `state`, as Dellin's API reference lists them with their
 * Russian names. A paid-storage state is cargo waiting at a terminal or an
 * airport for its recipient; storage is charged only while it waits there.
 * An order is finished once the cargo is handed out.
 */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['draft', 'registered'], // Черновик
  ['processing', 'registered'], // В обработке: the request is being processed.
  ['pickup', 'registered'], // Забор груза от адреса: Dellin is to collect the cargo from the sender.
  ['waiting', 'registered'], // Ожидает сдачи на терминал: the sender has yet to bring the cargo in.
  ['received', 'accepted'], // Груз принят к перевозке
  ['received_warehousing', 'accepted'], // Груз принят к перевозке. Платное хранение
  ['inway', 'in_transit'], // Груз в пути
  ['arrived', 'in_transit'], // Груз прибыл на терминал: it may not be ready to hand out yet.
  ['warehousing', 'ready_for_pickup'], // Груз прибыл на терминал. Платное хранение
  ['arrived_to_airport', 'in_transit'], // Груз прибыл в аэропорт
  ['airport_warehousing', 'ready_for_pickup'], // Груз прибыл в аэропорт. Платное хранение
  ['delivery', 'out_for_delivery'], // Доставка груза до адреса
  ['accompanying_documents_return', 'delivered'], // Груз выдан. Возврат СД: handed out, its papers on their way back.
  ['finished', 'delivered'], // Заказ завершен
  ['declined', 'exception'], // Отклонен
]);

/** The milestones the tracker words, without the town some of them end with. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['отправлен с адреса клиента', 'accepted'],
  ['принят на терминале отправки', 'accepted'],
  ['прибыл на терминал', 'in_transit'],
  ['доставлен на адрес получения', 'delivered'],
]);
const TOWN = /\s+г\.\s.*$/u;

/** The stage an order's state gives it. */
export function dellinState(state: string): Stage | undefined {
  return STATES.get(state.trim().toLowerCase());
}

/** The stage the map gives a milestone's wording, if it knows it. */
export function dellinMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording).replace(TOWN, ''));
}

/** A milestone's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function dellinStage(wording: string): ClassifiedWording | null {
  const mapped = dellinMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? dellinState(code) : dellinMappedStage(wording)),
  gaps: [],
};
