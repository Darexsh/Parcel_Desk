import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const key = (wording: string) => normalizeStatusWording(wording.normalize('NFD').replace(/\p{M}/gu, ''));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['PROCESADO', 'accepted'],
  ['ENVIO EN TRANSITO HACIA EL DESTINO', 'in_transit'],
  ['EN TRANSITO HACIA EL DESTINO', 'in_transit'],
  ['EN PROCESO DE ENTREGA', 'in_transit'],
  ['DISPUESTO PARA RETIRAR POR LA TAQUILLA DESTINO', 'ready_for_pickup'],
  ['ENTREGADO', 'delivered'],
  ['INGRESADO A TRAVES DEL PORTAL MIZOOM', 'registered'],
  ['ENVIO PROCESADO EN ORIGEN', 'accepted'],
  ['EN TRANSITO A SU DESTINO', 'in_transit'],
  ['RETRASO NO PROGRAMADO', 'exception'],
  ['PROCESADO EN LA SUCURSAL DE DESTINO', 'in_transit'],
  ['DESPACHADO AL LUGAR DE ENTREGA', 'in_transit'],
  ['RECIBIDO EN LA TAQUILLA DESTINO', 'in_transit'],
  ['DISPONIBLE PARA EL RETIRO EN TAQUILLA', 'ready_for_pickup'],
  ['ENTREGADO AL CLIENTE', 'delivered'],
  ['ENVIO PROCESADO', 'accepted'],
  ['EN CAMINO', 'in_transit'],
  ['EN GESTIÓN PARA LA ENTREGA', 'in_transit'],
  ['EN CIUDAD DESTINO', 'in_transit'],
] as const).map(([wording, stage]) => [key(wording), stage]));

/** The carrier appends a recipient and a second clock to its handover wording. */
export function zoomWording(wording: string): string {
  return /^ENTREGADO AL CLIENTE\b/i.test(wording) ? 'ENTREGADO AL CLIENTE' : wording;
}

export function zoomMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(zoomWording(wording)));
}

export function zoomStage(wording: string): ClassifiedWording | null {
  const stage = zoomMappedStage(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : zoomMappedStage(wording),
  gaps: [],
};
