import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The tracker's status codes, `cod`, with the wording it gives each. Only codes seen in replies are mapped. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['0', 'registered'], // Documentado: the sender recorded the shipment.
  ['1', 'in_transit'], // En tránsito.
  ['11', 'in_transit'], // En agencia distribución: at the depot that delivers.
  ['2', 'out_for_delivery'], // En reparto.
  ['4', 'delivered'], // Realizado con éxito.
]);

/** An incident, worded "Incidencia - " and its reason. */
export const INCIDENT = '3';
/** Pendiente de realizar: set with an incident when the delivery is to be made again; it moves nothing. */
const PENDING = '5';

/** Incident reasons, with or without the "Incidencia - " the history puts before them. */
const INCIDENTS: ReadonlyMap<string, Stage> = new Map([
  ['pendiente nuevo reparto', 'failed_attempt'], // The delivery failed and goes out again.
  ['ausente', 'failed_attempt'],
  ['dirección incorrecta o incompleta', 'failed_attempt'],
  ['rechazado', 'failed_attempt'], // The recipient refused the parcel.
  ['no cumplimiento agencia', 'exception'], // The delivering agency did not deliver.
  ['incumplimiento de la agencia', 'exception'],
]);

/** Wordings quoted from the tracker without their code. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['documentado', 'registered'],
  ['en tránsito', 'in_transit'],
  ['en agencia distribución', 'in_transit'],
  ['en reparto', 'out_for_delivery'],
  ['en realización', 'out_for_delivery'], // Shown while the delivery is under way.
  ['realizado con éxito', 'delivered'],
  ['entregado con éxito', 'delivered'],
  ['devuelto', 'returned'],
]);

const INCIDENT_PREFIX = /^incidencia\s*-\s*/;

/**
 * The stage A Tu Hora Express's map gives a scan code (null without one) and
 * its wording in `normalizeStatusWording` form: the code, else an incident
 * reason, else the wording.
 */
export function aTuHoraMappedStage(code: string | null, wording: string): Stage | undefined {
  if (code !== null) {
    const mapped = CODES.get(code);
    if (mapped) return mapped;
    if (code === PENDING) return undefined;
  }
  return INCIDENTS.get(wording.replace(INCIDENT_PREFIX, '')) ?? WORDINGS.get(wording);
}

/**
 * A scan's stage: the map, else the shared wording rules. An incident the
 * map and the rules do not read is still a problem with the shipment.
 */
export function aTuHoraStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = aTuHoraMappedStage(code || null, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code === PENDING) return null;
  const incident = code === INCIDENT;
  const worded = classifyWording(wording, incident ? 'exception' : 'in_transit');
  if (worded.source !== 'none') return worded;
  return incident ? { stage: 'exception', source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: aTuHoraMappedStage,
  gaps: [
    { code: PENDING, note: 'Pendiente de realizar, set with an incident when the delivery is to be made again; the incident carries the stage.' },
  ],
};
