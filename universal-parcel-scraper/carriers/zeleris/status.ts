import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** Lower case, single spaces and no accents: the page writes some of its sentences without them. */
function key(wording: string): string {
  return normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * The sentences Zeleris's tracker shows the recipient for each scan. They
 * carry no code. The first one, under the rail's "admisión" step, is the scan
 * Zeleris's older tracker called "RECEPCION TRANSPORTE", at the same clock:
 * Zeleris has the parcel, which has not left yet. A parcel left for the next
 * round after a delivery round waits at its depot.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map([
  ['tu envio ya esta preparado. te avisaremos cuando este en camino.', 'accepted'],
  ['tu envio esta en reparto.', 'out_for_delivery'],
  ['tu envio esta pendiente para el proximo reparto.', 'in_transit'],
  ['no hemos podido entregarte el envio.', 'failed_attempt'],
  ['tu envio ha sido entregado.', 'delivered'],
]);

/**
 * Messages to the recipient that move nothing, as the page words them; the
 * parcel keeps the stage of the scan before them.
 */
const QUIET_WORDING: readonly (readonly [string, string])[] = [
  ['Te hemos enviado un SMS al número de teléfono registrado en el pedido.',
    'A text message to the recipient after a delivery round; it moves nothing.'],
];
const QUIET = new Set(QUIET_WORDING.map(([wording]) => key(wording)));

/**
 * The progress rail's steps. Its current step is the shipment's state in
 * Zeleris's system, which moves without a scan for the recipient; the delivered
 * step carries the delivery's date and time, which the adapter drops. The
 * states named only by the tracker's help page are listed for when the rail
 * shows them.
 */
const RAIL: ReadonlyMap<string, Stage> = new Map([
  ['admision', 'accepted'],
  ['en camino', 'in_transit'],
  ['en transito', 'in_transit'],
  ['pendiente en plataforma', 'in_transit'],
  ['en reparto', 'out_for_delivery'],
  ['con incidencia', 'failed_attempt'],
  ['incidencia por ausencia', 'failed_attempt'],
  ['contacte con el remitente', 'exception'],
  ['no entrega definitiva', 'exception'],
  ['entregada', 'delivered'],
  ['entregado', 'delivered'],
]);

/** The stage the map gives a scan's sentence, if it knows it. */
export function zelerisScanStage(wording: string): Stage | undefined {
  return SCANS.get(key(wording));
}

/** Whether a scan's sentence moves nothing. */
export function zelerisQuiet(wording: string): boolean {
  return QUIET.has(key(wording));
}

/** The stage the rail's current step gives the shipment, if the map knows it. */
export function zelerisRailStage(label: string): Stage | undefined {
  return RAIL.get(key(label));
}

/**
 * A scan's stage from the map, else from the shared wording rules. A quiet
 * message, and wording neither knows, stays without a stage.
 */
export function zelerisStage(wording: string): ClassifiedWording | null {
  const mapped = zelerisScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (zelerisQuiet(wording)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. The rail's steps never come as scans. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : zelerisScanStage(wording)),
  gaps: QUIET_WORDING.map(([wording, note]) => ({ wording: normalizeStatusWording(wording), note })),
};
