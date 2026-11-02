import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Pošta Srbije names each event with a short status code, the same for its own
 * offices and for the events foreign posts relay about an item sent abroad.
 * The English wording is terse ("Receipt", "Dispatch"), a relayed failed
 * delivery keeps its Serbian wording, and a delivery back to the sender reads
 * as a delivery, so the codes decide.
 */
const CODES: Readonly<Record<string, Stage>> = {
  // Accepted at the counter, weighed.
  PR: 'accepted',
  // Dispatched to the next office, or handed to transport abroad at the office of exchange.
  OT: 'in_transit',
  PS: 'in_transit',
  // The addressee notified, naming the office that holds the item ("Izveštena").
  IZ: 'ready_for_pickup',
  // Assigned for handover at that office's counter ("Zadužena za isporuku").
  ZI: 'ready_for_pickup',
  VR: 'failed_attempt',
  UR: 'delivered',
  // Delivered back to the sender.
  UO: 'returned',
};

/** The stage the first code the map knows gives a scan; a scan can carry several, separated by ";". */
export function postaSrbijeCodeStage(code: string): Stage | undefined {
  for (const part of code.split(';')) {
    if (Object.hasOwn(CODES, part)) return CODES[part];
  }
  return undefined;
}

/**
 * A scan's stage from its code, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function postaSrbijeStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = postaSrbijeCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every scan carries a code; the map reads the code alone. */
export const statusMap: CarrierStatusMap = {
  stage: code => (code ? postaSrbijeCodeStage(code) : undefined),
  gaps: [],
};
