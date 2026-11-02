import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Grupo ampm's movement types, the TIPO column of its tracker, each shown with
 * one wording. Only types seen on the tracker are mapped; another falls to the
 * shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ER-01', 'accepted'], // ENVIO RECOLECTADO: collected from the sender.
  ['AE', 'in_transit'], // ENTRADA A CENTRO OPERATIVO: into an operations centre.
  ['PI', 'in_transit'], // PROCESADO EN INSTALACIONES
  ['VI', 'in_transit'], // VERIFICACION EN LAS INSTALACIONES
  // DEVOLUCION A CENTRAL: back to the central hub. A parcel that did not get
  // delivered goes there too, so the type alone does not start a return.
  ['DAC', 'in_transit'],
  ['SR', 'in_transit'], // SALIDA DE RESGUARDO: out of safekeeping.
  ['CM', 'out_for_delivery'], // CON MENSAJERO DE ENTREGA
  // REENVÍO EN DESTINO - DETALLES DE ENTREGA ESPERADOS: delivery waits for details.
  ['TE', 'exception'],
  ['RC', 'returned'], // RETORNO CONVENIO: sent back as the client's agreement says.
  ['PDEV', 'returned'], // PROGRAMADO PARA DEVOLUCION INTERNACIONAL
  ['5561', 'exception'], // DESTRUIDO
]);

/**
 * `EN` closes a delivery run, and its wording says how it ended. Only the
 * outcome seen is mapped; another falls to the shared wording rules.
 */
const OUTCOMES: ReadonlyMap<string, Stage> = new Map([
  // DEVUELTO: the run ended with the parcel returned, not delivered.
  [normalizeStatusWording('DEVUELTO'), 'returned'],
]);

/** The stage Grupo ampm's map gives a movement type and its wording in `normalizeStatusWording` form. */
export function ampmMappedStage(code: string, wording: string): Stage | undefined {
  const type = code.toUpperCase();
  return type === 'EN' ? OUTCOMES.get(wording) : CODES.get(type);
}

/** A movement's stage: the map, else the shared wording rules, else nothing. */
export function ampmStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = ampmMappedStage(code, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every type seen is mapped; `EN` by its outcome. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? ampmMappedStage(code, wording) : undefined),
  gaps: [],
};
