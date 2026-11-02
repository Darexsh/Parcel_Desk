import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * OCA's states, as its tracking service words them without the branch. The
 * scans carry no code, so the wording seen in replies is mapped by how it
 * starts: a reason can follow in brackets.
 */
const STATES: readonly (readonly [RegExp, Stage])[] = [
  [/^en proceso de retiro\b/, 'registered'], // OCA is to pick the parcel up from the sender.
  [/^retirado\b/, 'accepted'], // Picked up from the sender; the tracker's summary says only "Retirado".
  [/^(?:en proceso|procesado) en oca\b/, 'in_transit'],
  [/^en viaje a (?:centro de distribución|sucursal) de destino\b/, 'in_transit'],
  [/^en tránsito a suc\. de destino\b/, 'in_transit'],
  [/^arribado a centro de distribución de destino\b/, 'in_transit'],
  [/^llegó a nuestra sucursal\b/, 'in_transit'],
  [/^(?:programado para visita|visita) a domicilio\b/, 'out_for_delivery'],
  [/^estado de visita online \(entregado\)/, 'delivered'], // The courier's handset reports the delivery.
  [/^no entregado\b/, 'failed_attempt'], // The reason follows in brackets.
  [/^reprogramado para nueva visita\b/, 'failed_attempt'],
  [/^(?:en espera de retiro por sucursal|disponible para que lo retires)\b/, 'ready_for_pickup'],
  [/^entregado\b/, 'delivered'],
  [/^(?:devolución en proceso|devuelto al remitente)\b/, 'returned'],
];

// The proof of delivery, scanned at OCA's plant days after the delivery: it
// moves nothing.
const PROOF = /^acuse digitalizado\b/;

const key = (text: string) => text.toLocaleLowerCase('es-AR').trim().split(/\s+/).join(' ');

/** The stage OCA's map gives a state, if it knows it. */
export function ocaMappedStage(wording: string): Stage | undefined {
  const state = key(wording);
  return STATES.find(([pattern]) => pattern.test(state))?.[1];
}

/** A scan's stage: its state, else the shared wording rules, else nothing. */
export function ocaStage(wording: string): ClassifiedWording | null {
  const mapped = ocaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (PROOF.test(key(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => ocaMappedStage(wording),
  gaps: [
    { wording: 'acuse digitalizado', note: 'The proof of delivery, scanned at OCA\'s plant days after the delivery; it moves nothing.' },
  ],
};
