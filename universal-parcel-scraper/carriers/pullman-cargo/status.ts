import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scans carry no code, only the web wording (`estadoWeb`). Those
 * seen in replies are mapped; other wording falls to the shared rules. Archived
 * replies of the former tracker, which named the internal state beside the
 * wording, show what each one stands for.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // Sold at a counter or distribution centre, where the sender leaves the parcel:
  // the former tracker sorted it there within minutes.
  ['Venta Creada', 'accepted'],
  ['Encomienda recibida en agencia', 'in_transit'], // At an agency or distribution centre on the way.
  ['Encomienda viajando entre regiones', 'in_transit'], // On a trip between regions.
  ['Encomienda recibida en agencia de destino', 'in_transit'], // At the agency that delivers it or hands it over.
  ['Encomienda viajando entre agencias', 'in_transit'], // Sorted for the delivering agency's round.
  ['En espera de reparto', 'in_transit'], // Waiting for a delivery round.
  ['En reparto', 'out_for_delivery'],
  ['Encomienda entregada', 'delivered'], // At the door, or collected at the agency.
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording. */
export function pullmanCargoMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function pullmanCargoStage(wording: string): ClassifiedWording | null {
  const mapped = pullmanCargoMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => pullmanCargoMappedStage(wording),
  gaps: [],
};
