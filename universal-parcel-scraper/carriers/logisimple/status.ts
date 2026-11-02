import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The states Logisimple's tracking page names its scans by, in Portuguese.
 * Each comes with a sentence that explains the state, the same for every scan
 * of it. Only states seen on the page are mapped; another falls to the shared
 * wording rules.
 */
const STATES: ReadonlyMap<string, Stage> = new Map(([
  // The central accepted the order. The page's progress bar puts it before the
  // collection, and the first warehouse scan comes days later.
  ['Aceite', 'registered'],
  ['Entrada Armazém', 'in_transit'],
  ['Em Transferência', 'in_transit'],
  // Waiting at the depot for a delivery day agreed with the recipient.
  ['A Agendar', 'in_transit'],
  ['Agendado', 'in_transit'],
  // Planned on a delivery round; the round itself is Em Distribuição.
  ['Em Rota', 'in_transit'],
  ['Em Distribuição', 'out_for_delivery'],
  ['Entregue', 'delivered'],
] as const).map(([state, stage]) => [normalizeStatusWording(state), stage]));

/** The stage Logisimple's map gives a state's name. */
export function logisimpleMappedStage(state: string): Stage | undefined {
  return STATES.get(normalizeStatusWording(state));
}

/** A scan's stage: its state's, else the shared wording rules' for the state, then for its explanation, else nothing. */
export function logisimpleStage(state: string, detail: string): ClassifiedWording | null {
  const mapped = logisimpleMappedStage(state);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const wording of [state, detail]) {
    if (!wording) continue;
    const worded = classifyWording(wording, 'in_transit');
    if (worded.source !== 'none') return worded;
  }
  return null;
}

/** The page shows state names without codes; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => logisimpleMappedStage(wording),
  gaps: [],
};
