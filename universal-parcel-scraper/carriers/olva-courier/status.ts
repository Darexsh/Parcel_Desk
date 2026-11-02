import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The codes whose every scan means one stage. */
const CODES: Readonly<Record<string, Stage>> = {
  // The sender booked the shipment; the parcel may not be with Olva yet.
  REGISTRADO: 'registered',
  // At a warehouse, on the way out or at the destination.
  ALMACEN: 'in_transit',
  EN_RUTA: 'in_transit',
  ENTREGADO: 'delivered',
};

/**
 * `REPARTO` files every move after the booking under the title "En camino a
 * tu domicilio", and its wording says which: a store took the parcel in, it
 * travels to a town or a store, it waits at a store, or it is out for delivery.
 */
const REPARTO: readonly (readonly [RegExp, Stage])[] = [
  [/^recepcionado por /, 'accepted'],
  [/^ya puedes recoger tu env[ií]o /, 'ready_for_pickup'],
  [/^en camino a tu domicilio$/, 'out_for_delivery'],
  [/^en camino a /, 'in_transit'],
];

/** The stage the map gives a scan's code and wording, in `normalizeStatusWording` form. */
function mappedStage(code: string, wording: string): Stage | undefined {
  if (Object.hasOwn(CODES, code)) return CODES[code];
  if (code === 'REPARTO') return REPARTO.find(([pattern]) => pattern.test(wording))?.[1];
  // An incident: a failed delivery names its reason after the colon; any other is a problem.
  if (code === 'INCIDENCIA') return /^entrega fallida\b/.test(wording) ? 'failed_attempt' : 'exception';
  return undefined;
}

/** The stage Olva's code and wording give a scan, if the map knows them. */
export function olvaMappedStage(code: string, wording: string): Stage | undefined {
  return mappedStage(code.trim().toUpperCase(), normalizeStatusWording(wording));
}

/** A scan's stage from its code and wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function olvaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = olvaMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Olva's map leaves nothing out on purpose: a code or wording it does not know falls to the wording rules. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? olvaMappedStage(code, wording) : undefined),
  gaps: [],
};
