import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * PEC's client statuses, as its tracker and its API documentation word them.
 * A cargo is handed over at a terminal or a pickup point (выдан) or brought to
 * the door (доставлен). "Прибыл" is an arrival at the receiving terminal that
 * does not say the cargo can be collected yet.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['заявка на забор зарегистрирована', 'registered'],
  ['забор груза заказан', 'registered'],
  ['забор груза запланирован', 'registered'],
  ['ожидается передача груза от отправителя', 'registered'],
  ['аннулировано до приемки груза', 'exception'],
  ['принят', 'accepted'],
  ['принят к перевозке', 'accepted'],
  ['принят на пвз', 'accepted'],
  ['оформлен', 'accepted'],
  ['в пути', 'in_transit'],
  ['в пути на терминал', 'in_transit'],
  ['прибыл', 'in_transit'],
  ['прибыл частично', 'in_transit'],
  ['разгружается. ожидайте оповещения', 'in_transit'],
  ['выполняется адресная доставка', 'out_for_delivery'],
  ['выдан получателю', 'delivered'],
  ['выдан на складе', 'delivered'],
  ['доставлен получателю', 'delivered'],
  ['отправлен на возврат', 'returned'],
  ['возвращен отправителю', 'returned'],
  ['изъят на таможне', 'customs'],
  ['утилизирован', 'exception'],
]);

// A transit row the tracker words as its status, then the kind and name of the
// terminal it concerns: "Отправлен на терминал выдачи Раменское".
const TRANSIT = /^(?:отправлен|прибыл) (?:на|в) \S/u;

/** The stage the map gives a status's wording, if it knows it. */
export function pecomMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.get(normalized) ?? (TRANSIT.test(normalized) ? 'in_transit' : undefined);
}

/** A status's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function pecomStage(wording: string): ClassifiedWording | null {
  const mapped = pecomMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => pecomMappedStage(wording),
  gaps: [],
};
