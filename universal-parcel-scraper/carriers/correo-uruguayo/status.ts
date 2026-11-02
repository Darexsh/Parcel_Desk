import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Correo Uruguayo's scan wordings, mapped whole. Its own offices' scans and
 * the international exchange's are numbered apart, so one code can carry two
 * wordings and one wording two codes: the wording sets the stage.
 */
export const CORREO_URUGUAYO_EVENTS: Readonly<Record<string, Stage>> = {
  'INGRESO A CORREO URUGUAYO': 'accepted',
  // The sending post's acceptance of an item for Uruguay.
  'ADMISION PAIS DE ORIGEN': 'accepted',
  'PROCESADO EN OFICINA': 'in_transit',
  'PROCESADO EN OFICINA DE ORIGEN': 'in_transit',
  'RECEPCIÓN DE ENVIO': 'in_transit',
  'EN TRANSITO A DESTINO': 'in_transit',
  'ENVÍO EN TRANSITO': 'in_transit',
  'SALIDA DE ORIGEN': 'in_transit',
  'PREPARANDO SALIDA INTERNACIONAL': 'in_transit',
  'SALIDA INTERNACIONAL': 'in_transit',
  'LLEGADA DE CONTENEDOR A URUGUAY': 'in_transit',
  'CONTENEDOR EN PLANTA DE PROCESAMIENTO. (MONTEVIDEO)': 'in_transit',
  'RECEPCION DE ENVIO EN PLANTA DE PROCESAMIENTO INTERNACIONAL': 'in_transit',
  'LLEGADA A OFICINA DE DESTINO O DE TRANSITO': 'in_transit',
  'ENVIADO A ORGANISMO DE CONTRALOR (EJ. ADUANA, MSP, MGAP)': 'customs',
  // Held until the recipient declares the purchase; the page links the declaration form.
  'ENVÍO RETENIDO POR ORGANISMO DE CONTRALOR. (EJ. ADUANA, MSP, MGAP).': 'customs',
  // Customs released the item, which moves on.
  'ENVIO LIBERADO POR ADUANA, REINGRESA AL PROCESO POSTAL': 'in_transit',
  // Put on a postman's round.
  'ASIGNADO A DISTRIBUCION': 'out_for_delivery',
  'DISPONIBLE PARA RETIRAR EN SUCURSAL POR LOS PROXIMOS 30 DIAS CORRIDOS': 'ready_for_pickup',
  // "ENTREGADO A:" and "INTENTO DE ENTREGA:" without the name that follows.
  'ENTREGADO': 'delivered',
  'INTENTO DE ENTREGA': 'failed_attempt',
};

const EVENTS = new Map(Object.entries(CORREO_URUGUAYO_EVENTS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function correoUruguayoEventStage(wording: string): Stage | undefined {
  return EVENTS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function correoUruguayoStage(wording: string): ClassifiedWording | null {
  const mapped = correoUruguayoEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The item's `codigoEtapaEntrega`, the step of the page's progress bar:
 * started, moving, being delivered, delivered. Being delivered covers a parcel
 * at its delivery office as well as one on its round, so it says no more than
 * moving.
 */
const STEPS: ReadonlyMap<string, Stage> = new Map([
  ['INICIADO', 'accepted'],
  ['EN_PROCESO_TRASLADO', 'in_transit'],
  ['EN_PROCESO_ENTREGA', 'in_transit'],
  ['ENTREGADO', 'delivered'],
]);

/** The stage the progress bar's step gives, if any. */
export function summaryStage(step: string): Stage | undefined {
  return STEPS.get(step.trim().toUpperCase());
}

/** The wording sets the stage whatever its code; Correo Uruguayo's map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => correoUruguayoEventStage(wording),
  gaps: [],
};
