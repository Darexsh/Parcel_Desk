import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event names of the UPU's IPS system, in the Spanish the tracker prints,
 * with their leg: "(salida)" in the posting country, "(entrada)" in the
 * destination. The map reads a name without its leg.
 */
const IPS: ReadonlyMap<string, Stage> = new Map([
  ['recibir envío del cliente', 'accepted'],
  ['recibir envío en oficina de cambio', 'in_transit'],
  ['enviar envío a ubicación nacional', 'in_transit'],
  ['recibir envío en ubicación', 'in_transit'],
  ['insertar envío en saca nacional', 'in_transit'],
  ['recibir envío en oficina de entrega', 'in_transit'],
  // Handed to the delivery agent for the round.
  ['transferir envío al agente de entrega', 'out_for_delivery'],
  ['entregar envío', 'delivered'],
]);

/** The former tracker's wordings for the same events, kept with their stages. */
const FORMER: ReadonlyMap<string, Stage> = new Map([
  ['item recibido por parte del cliente', 'accepted'],
  ['item recibido en la oficina de cambio', 'in_transit'],
  ['item insertado en una bolsa de transporte especial de correo', 'in_transit'],
  ['item removido de la bolsa de transporte especial de correo', 'in_transit'],
  ['item enviado a la aduana', 'customs'],
  // Customs handed the item back to the post: a release, not a return to the sender.
  ['item devuelto de la aduana', 'in_transit'],
  ['item recibido en el lugar de deposito de correo nacional', 'in_transit'],
  ['item recibido en la oficina de entrega', 'in_transit'],
  ['item asignado a un agente de entrega', 'out_for_delivery'],
  ['item entregado en destino', 'delivered'],
]);

// The leg a name ends with.
const LEG = /\s*\((?:entrada|salida)\)$/;
const UPDATED = 'item actualizado';
const DETAILS = 'registro de mas detalles del item';
const NOT_ARRIVED = 'su paquete aún no ha ingresado al país. por favor consulte más adelante.';

/** The stage the map gives a scan's wording, if it knows it. */
export function correosElSalvadorEventStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return IPS.get(key.replace(LEG, '')) ?? FORMER.get(key);
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function correosElSalvadorStage(wording: string): ClassifiedWording | null {
  const mapped = correosElSalvadorEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

// The reply's `mensajeAmigable`, which the page shows above the history.
const SUMMARIES: ReadonlyMap<string, Stage> = new Map([
  ['¡paquete entregado con exito!', 'delivered'],
]);

/** The stage the summary message gives, if any. */
export function summaryStage(message: string): Stage | undefined {
  return SUMMARIES.get(normalizeStatusWording(message));
}

/** The wording sets the stage; the scan's code, the IPS event type, is kept for review. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => correosElSalvadorEventStage(wording),
  gaps: [
    { wording: UPDATED, note: 'The former tracker\'s record update, which moves nothing.' },
    { wording: DETAILS, note: 'The former tracker\'s note that more item details were recorded, which moves nothing.' },
    { wording: NOT_ARRIVED, note: 'The page\'s notice for a code the tracker does not know; no scan.' },
  ],
};
