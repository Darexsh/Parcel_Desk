import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The event wordings of 4-72's tracker, in the normalized form, that replies
 * showed. Events come without a code; another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['admitido', 'accepted'],
  ['en proceso', 'in_transit'],
  // Put on another delivery round after a visit that did not deliver.
  ['reasignado', 'in_transit'],
  ['envío recibido en la oficina de cambio internacional', 'in_transit'],
  // Customs handed the item back to the post.
  ['envío recibido de aduanas', 'in_transit'],
  ['salida de aduana y transferencia entre oficinas', 'in_transit'],
  ['envío no entregado', 'failed_attempt'],
  ['registro de entrega no exitosa', 'failed_attempt'],
  ['entregado', 'delivered'],
  ['registro de entrega exitosa', 'delivered'],
  // The item goes back to the sender: ordered, on its way and handed over.
  ['devolucion (dev)', 'returned'],
  ['transito(dev)', 'returned'],
  ['en proceso de devolución a remitente', 'returned'],
  ['devolución entregada a remitente', 'returned'],
]);

// A visit's reason followed by the order to send the item back: "No reside - dev a remitente".
const SENT_BACK = /dev\.? a remitente$/;
// A visit that did not deliver, for a reason outside the tracker's list: "Otros: cerrado 1ra vez".
const OTHER = /^otros:/;

function mapped(key: string): Stage | undefined {
  return WORDINGS.get(key) ?? (SENT_BACK.test(key) ? 'returned' : undefined);
}

/**
 * The stage the map gives an event's wording. A wording the adapter followed
 * with the event's remark (`Registro de entrega no exitosa: Otros: …`) is
 * read by the event before the remark.
 */
export function fourSeventyTwoMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  if (OTHER.test(key)) return 'failed_attempt';
  return mapped(key) ?? mapped(key.split(':', 1)[0]!.trim());
}

/** An event's stage: its wording in the map, else the shared wording rules, else nothing. */
export function fourSeventyTwoStage(wording: string): ClassifiedWording | null {
  const stage = fourSeventyTwoMappedStage(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scan of the signed delivery or return document, which moves nothing. */
export const DIGITIZED = 'digitalizado';

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : fourSeventyTwoMappedStage(wording)),
  gaps: [
    { wording: DIGITIZED, note: 'The signed delivery or return document scanned into the tracker after the visit; the item does not move.' },
  ],
};
