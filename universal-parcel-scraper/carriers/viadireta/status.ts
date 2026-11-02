import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** "Nova data: 02-10-2026" at the end of a movement: the day the next delivery is set for. */
const NEW_DAY = /\s*nova data:\s*(\d{2})-(\d{2})-(\d{4})\.?$/i;

/** The wording without its new delivery day or closing full stop, with one kind of dash. */
function keyOf(wording: string): string {
  return normalizeStatusWording(wording).replace(/[–—]/g, '-').replace(NEW_DAY, '').replace(/\.$/, '');
}

/**
 * The movements of ViaDireta's tracking page, which carry no code: the ones
 * seen on the page, and the delivery problems complaints quote from it. Some
 * end with the new delivery day (`Nova data: 02-10-2026`), which the map
 * reads without. Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Registo na Plataforma da Viadirecta', 'registered'],
  // Written with the registration, before the parcel reaches the warehouse.
  ['Atribuição da Zona de Distribuição', 'registered'],
  // Also after a failed round, when the parcel comes back.
  ['Entrada no Armazém da Viadirecta', 'in_transit'],
  // A delivery day agreed with the recipient, before a round or in place of one.
  ['Agendado com Destinatário para', 'in_transit'],
  ['O Serviço encontra-se em Distribuição', 'out_for_delivery'],
  ['Entrega não conseguida - Nova tentativa a', 'failed_attempt'],
  ['Cliente ausente e incontactável', 'failed_attempt'],
  ['Morada incompleta/errada', 'failed_attempt'],
  ['Realizado com Sucesso', 'delivered'],
] as const).map(([wording, stage]) => [keyOf(wording), stage]));

/** The new delivery day a movement ends with, as written: day, month and year. */
export function newDeliveryDay(wording: string): [day: number, month: number, year: number] | null {
  const match = NEW_DAY.exec(wording.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The stage ViaDireta's map gives a wording, if it knows it. */
export function viadiretaMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(keyOf(wording));
}

/** A movement's stage: the map, else the shared wording rules, else nothing, which keeps it visible for review. */
export function viadiretaStage(wording: string): ClassifiedWording | null {
  const mapped = viadiretaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : viadiretaMappedStage(wording)),
  gaps: [],
};
