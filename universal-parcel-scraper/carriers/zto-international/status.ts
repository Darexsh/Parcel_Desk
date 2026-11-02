import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The stage of each scan code ZTO International's tracker sends. Codes up to
 * 16 are ZTO's own network, at home and abroad; codes from 150 are ZTO
 * International's warehouses, line hauls and customs. On an export to Europe,
 * codes 100, 375 and 415 copy the last-mile carrier's scans.
 */
const CODES = new Map<string, Stage>([
  ['1', 'accepted'],
  ['2', 'in_transit'],
  ['3', 'in_transit'],
  ['4', 'out_for_delivery'],
  ['5', 'delivered'],
  // Signed for with the pickup code a parcel station gave the recipient.
  ['15', 'delivered'],
  // Taken in by a parcel station or a neighbour for the recipient; the page
  // calls it delivered, but the collection follows as code 15.
  ['16', 'ready_for_pickup'],
  // The order checked before the overseas warehouse receives the parcel.
  ['30', 'registered'],
  // Copied from the last-mile carrier abroad, as an arrival.
  ['100', 'in_transit'],
  // The overseas warehouse received the parcel: the first scan of an import.
  ['150', 'accepted'],
  ['180', 'in_transit'],
  ['190', 'in_transit'],
  ['213', 'customs'],
  ['220', 'in_transit'],
  ['221', 'in_transit'],
  ['222', 'in_transit'],
  ['230', 'in_transit'],
  ['231', 'in_transit'],
  ['232', 'in_transit'],
  ['235', 'in_transit'],
  ['330', 'customs'],
  ['360', 'customs'],
  // Cleared: the parcel moves on to ZTO's domestic network.
  ['370', 'in_transit'],
  ['371', 'in_transit'],
  ['373', 'customs'],
  // The destination's import clearance, finished.
  ['375', 'in_transit'],
  // A hand-over in the warehouse or to the last-mile carrier abroad.
  ['415', 'in_transit'],
  ['-581', 'exception'],
]);

/** A scan's stage by its code, or by its wording when the code is new. */
export function ztoInternationalStage(code: string, wording: string): ClassifiedWording | null {
  const stage = CODES.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = { stage: (code) => (code ? CODES.get(code) : undefined), gaps: [] };
