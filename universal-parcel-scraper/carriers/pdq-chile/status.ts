import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * PDQ's scan codes. The tracking page places each on a step of its progress
 * rail; only codes seen in replies with their wording, and the first and the
 * city steps' codes, are mapped. The page puts LLPT and DIAN on its delivery
 * step and DIAE, CLEN and LOCK on its delivered step without saying more, so
 * those fall to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ALTA', 'registered'], // The rail's first step, En preparación.
  ['CPCE', 'in_transit'], // En viaje a destino: left the origin centre.
  ['LLCD', 'in_transit'], // On the rail's En tu ciudad step, beside LLEG.
  ['LLEG', 'in_transit'], // Llego a tu ciudad.
  ['REPA', 'out_for_delivery'], // En reparto; the page counts these as delivery attempts.
  ['ENTR', 'delivered'], // Entregado.
]);

/** The stage PDQ's codes give a scan code. */
export function pdqMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function pdqStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = pdqMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The shipment's `estado`, without accents and in capitals, as the page compares it. */
export function pdqSummaryKey(estado: string): string {
  return estado.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim().split(/\s+/).join(' ');
}

/** The shipment's `estado` values: the steps of the page's rail, and its label for a parcel waiting at a branch. */
const SUMMARY: ReadonlyMap<string, Stage> = new Map([
  ['EN PREPARACION', 'registered'],
  ['TRANSITO', 'in_transit'],
  ['EN TU CIUDAD', 'in_transit'],
  ['REPARTO', 'out_for_delivery'],
  ['LISTA PARA RETIRO', 'ready_for_pickup'],
  ['ENTREGADA', 'delivered'],
]);

/** The stage of the shipment's `estado`, or nothing for one the page does not name. */
export function pdqSummaryStage(estado: string): Stage | undefined {
  return SUMMARY.get(pdqSummaryKey(estado));
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? pdqMappedStage(code) : undefined),
  gaps: [],
};
