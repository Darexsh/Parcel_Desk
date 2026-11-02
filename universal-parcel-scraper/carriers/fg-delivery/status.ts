import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * FG Delivery's scan codes, the reply's `EventCode` beside each scan's
 * Italian `Causale`. Only codes seen in replies are mapped; another code falls
 * to FG Delivery's own wordings, then to the shared wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['292', 'in_transit'], // Dispaccio in partenza: the dispatch carrying the parcel left for the branch.
  ['287', 'in_transit'], // Merce in filiale: at the delivering branch.
  ['259', 'out_for_delivery'], // In consegna.
  ['262', 'delivered'], // Consegnato al destinatario.
]);

/**
 * Wordings for a round that did not deliver, whose codes no reply has shown:
 * the help centre explains "lasciato avviso", and customers quote the other
 * two as the tracker's reason. The shared rules read none of them.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['lasciato avviso', 'failed_attempt'],
  ['non in casa', 'failed_attempt'],
  ['indirizzo non trovato', 'failed_attempt'],
]);

/** The stage FG Delivery's codes, else its own wordings, give a scan. */
export function fgDeliveryMappedStage(code: string, wording: string): Stage | undefined {
  return CODES.get(code) ?? WORDINGS.get(wording.toLowerCase().trim().split(/\s+/).join(' '));
}

/** A scan's stage: its code or FG Delivery's wording, else the shared wording rules, else nothing. */
export function fgDeliveryStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = fgDeliveryMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => fgDeliveryMappedStage(code ?? '', wording),
  gaps: [],
};
