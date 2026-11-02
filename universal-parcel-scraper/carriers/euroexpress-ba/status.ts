import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status codes of a shipment's summary. EuroExpress's app draws a progress
 * rail from them: picked up from code 0, in delivery from 2 and delivered from
 * 20; a delivered summary seen live had code 30. Its scans carry no codes.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['0', 'accepted'], // Pokupljena, the rail's first step: collected from the sender.
  ['2', 'out_for_delivery'], // U dostavi.
  ['20', 'delivered'], // Dostavljena, the rail's last step.
  ['30', 'delivered'], // DOSTAVLJENA.
]);

/** The stage EuroExpress's map gives a summary code. */
export function euroexpressMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A summary's or scan's stage: its code, else the shared wording rules, else nothing. */
export function euroexpressStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = code ? euroexpressMappedStage(code) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (!wording) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? euroexpressMappedStage(code) : undefined),
  gaps: [],
};
