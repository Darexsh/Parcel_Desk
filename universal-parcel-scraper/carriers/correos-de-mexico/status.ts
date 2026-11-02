import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Correos de México's tracker names each scan in Spanish, without a code.
 * Foreign posts' events relayed for international items use the same names,
 * so an arrival abroad is worded as an arrival in Mexico. The shared rules
 * read most of these names as no milestone at all.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['depósito en oficina de correos', 'accepted'],
  ['en tránsito hacia destino', 'in_transit'],
  ['recepción en oficina de correos', 'in_transit'],
  // The outward office of exchange, in Mexico or abroad, before the item is sent on.
  ['en zona de intercambio int. hacia el país destino, previo aduana', 'in_transit'],
  ['pieza depositada en valija y enviada a oficina del país destino', 'in_transit'],
  // Arrived at the destination's office of exchange, waiting to be presented to customs.
  ['arribo a zona intercambio méxico, en espera de ingreso a la aduana', 'customs'],
  ['inicio de la revisión aduanal en país destino', 'customs'],
  ['inicio de la revisión aduanal en el país destino', 'customs'],
  // Customs is done with the item: a release.
  ['revisión aduanal concluida', 'in_transit'],
  ['con mensajero para entrega', 'out_for_delivery'],
  // Left at the post office's counter, for the addressee to collect.
  ['puesta en ventanilla', 'ready_for_pickup'],
  ['entrega', 'delivered'],
  ['entrega internacional', 'delivered'],
]);

// The posting abroad names the country: "Deposito del Cliente en el país de origen", "… en Japan".
const POSTED_ABROAD = /^deposito del cliente\b/;
// Sent back, with the reason: "Pieza devuelta por domicilio destino incorrecto".
const SENT_BACK = /^pieza devuelta\b/;

/** The stage the map gives Correos de México's wording, if it knows it. */
export function correosDeMexicoScanStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  if (POSTED_ABROAD.test(key)) return 'accepted';
  if (SENT_BACK.test(key)) return 'returned';
  return STAGES.get(key);
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function correosDeMexicoStage(wording: string): ClassifiedWording | null {
  const mapped = correosDeMexicoScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : correosDeMexicoScanStage(wording)),
  gaps: [],
};
