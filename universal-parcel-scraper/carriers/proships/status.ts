import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings ProShips' tracker gives its scans and its current status,
 * which carry no code. Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['orden generada', 'registered'],
  // MailAmericas parcels get it when the container reaches the intermediate
  // warehouse in Colombia; the page presents the parcel as at customs.
  ['recepción en aduana', 'customs'],
  ['paquete ingresó al centro de clasificación', 'in_transit'],
  ['envío en tránsito a destino', 'in_transit'], // Handed to the delivering network.
  ['envío ingresó a ciudad destino', 'in_transit'],
  ['salida de manifiesto en manos del cartero', 'out_for_delivery'],
  ['entregado', 'delivered'],
  // The progress rail of ProShips' earlier tracking page.
  ['orden creda', 'registered'],
  ['almacen de origen', 'accepted'],
  ['tránsito a país destino', 'in_transit'],
  ['arribado a país destino', 'in_transit'],
  ['aduana', 'customs'],
  ['recepción correo', 'in_transit'],
  ['sucursal de entrega', 'in_transit'],
  ['retener', 'exception'], // The parcel is held.
  ['recepción en aduana / almacén intermedio', 'customs'],
]);

/** The stage ProShips' map gives a wording in `normalizeStatusWording` form. */
export function proshipsMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function proshipsStage(wording: string): ClassifiedWording | null {
  const mapped = proshipsMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => proshipsMappedStage(wording),
  gaps: [],
};
