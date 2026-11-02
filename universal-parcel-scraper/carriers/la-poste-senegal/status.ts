import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event numbers of the UPU's IPS, which La Poste du Sénégal and the posts
 * abroad record. IPS numbers an event the same in every post's system: Uzbekistan
 * Post's IPS replies carry these numbers for the same English names. The name's
 * leg, "(Inb)" or "(Otb)", follows the number and does not change the stage.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'accepted'], // Receive item from customer (Otb).
  ['2', 'in_transit'], // Send item to domestic location (Otb).
  ['3', 'in_transit'], // Receive item at office of exchange (Otb).
  ['8', 'in_transit'], // Insert item into bag (Otb).
  ['13', 'in_transit'], // Insert item into domestic bag.
  ['30', 'in_transit'], // Receive item at office of exchange (Inb).
  ['31', 'customs'], // Send item to customs (Inb).
  // Receive item at delivery office (Inb): the office delivers it from there.
  ['32', 'in_transit'],
  ['34', 'customs'], // Record item customs information (Inb).
  ['35', 'in_transit'], // Send item to domestic location (Inb).
  ['37', 'delivered'], // Deliver item (Inb).
  // Return item from customs (Inb): customs released the item into the post's network.
  ['38', 'in_transit'],
]);

/** The stage the map gives an IPS event number. */
export function laPosteSenegalMappedStage(code: string | null | undefined): Stage | undefined {
  return code ? CODES.get(code.trim()) : undefined;
}

/** A scan's stage: its event number, else the shared wording rules, else nothing, which keeps it visible for review. */
export function laPosteSenegalStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = laPosteSenegalMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The event number sets the stage; the map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => laPosteSenegalMappedStage(code),
  gaps: [],
};
