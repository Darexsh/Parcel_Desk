import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * nox's scan wordings, which carry no code. Only wordings seen on its
 * tracker are mapped; another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // The sender has the parcel ready for nox to collect; nox has not taken it yet.
  ['collo durch versender bereitgestellt zur abholung', 'registered'],
  ['collo in der nox niederlassung eingetroffen', 'in_transit'],
  ['collo von der nox niederlassung weiterverladen', 'in_transit'],
  // The parcel waits at the branch for a later delivery night; the shared
  // rules would read "Zustellung" as out for delivery.
  ['collo steht am lager in nox niederlassung, zustellung nicht im geplanten zeitfenster', 'in_transit'],
  ['collo in nox zustellfahrzeug geladen', 'out_for_delivery'],
  ['collo von nox zugestellt', 'delivered'],
  // The remarks the former tracker showed beside each scan.
  ['kommissionierung versenderkunde', 'registered'],
  ['sendung eingetroffen', 'in_transit'],
  ['sendung weiterverladen', 'in_transit'],
  ['sendung in zustellung', 'out_for_delivery'],
  ['sendung zugestellt', 'delivered'],
]);

/** The stage nox's wording gives a scan. */
export function noxMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function noxStage(wording: string): ClassifiedWording | null {
  const mapped = noxMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => noxMappedStage(wording),
  gaps: [],
};
