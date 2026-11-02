import { languageStageStatus, trackingLanguageStage, type ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** A label or place without accents, in capitals, with single spaces. */
export function comparable(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// TIPSA's history labels, as the shipment page lists them.
const LABELS = new Map<string, ClassifiedStatus>([
  ['PENDIENTE DE ENTREGAR A TIPSA', { status: 'pending', stage: 'registered' }],
  ['TRANSITO', { status: 'in_transit', stage: 'in_transit' }],
  ['LEIDO EN DESTINO', { status: 'in_transit', stage: 'in_transit' }],
  ['REPARTO', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['AUSENTE', { status: 'exception', stage: 'failed_attempt' }],
  // Delivery asked for at another address: the parcel is rerouted.
  ['SOLICITADA EN OTRA DIRECCION', { status: 'in_transit', stage: 'in_transit' }],
  // Data missing from or wrong in the address, noted on the round before another one.
  ['FALTAN DATOS / DATOS INCORRECTOS', { status: 'exception', stage: 'failed_attempt' }],
  // Between hub scans, before the destination agency reads the parcel.
  ['PENDIENTE DE LLEGADA', { status: 'in_transit', stage: 'in_transit' }],
  // Held at the agency after a missed round, both lines at the same minute.
  ['DISPONIBLE', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['PENDIENTE DE RECOGER EN TIPSA', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['ENTREGADO', { status: 'delivered', stage: 'delivered' }],
]);

/** A label's stage: TIPSA's own vocabulary first, then the shared Spanish and Portuguese wording rules. */
export function tipsaStatus(label: string): ClassifiedStatus | undefined {
  const key = comparable(label);
  // The destination agency's name follows ("LECTURA EN AGENCIA DESTINO EJEMPLO 01").
  if (/^LECTURA EN AGENCIA DESTINO\b/.test(key)) return { status: 'in_transit', stage: 'in_transit' };
  const known = LABELS.get(key);
  if (known) return known;
  const worded = trackingLanguageStage(label);
  return worded ? { status: languageStageStatus(worded), stage: worded } : undefined;
}

/**
 * What the map says about one history label, the only key a scan has: TIPSA's
 * own labels, else the shared wording rules the adapter reads them with.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : tipsaStatus(wording)?.stage),
  gaps: [],
};
