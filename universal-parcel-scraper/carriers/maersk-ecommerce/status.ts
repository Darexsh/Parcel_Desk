import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Maersk eCommerce codes its own scans 70000 to 72999 and the scans it relays
 * from the last-mile carrier 77000 onwards. The map is the codes recorded in
 * `statuses.json`.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [entry.code, entry.stage as Stage]));

/**
 * The groups of the tracker's progress rail, for a code the map does not
 * know. A delivery needs its code: the group alone is not proof of one.
 */
const GROUPS: ReadonlyMap<string, Stage> = new Map([
  ['expecting parcel', 'registered'],
  ['in transit', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
]);

/** A scan's stage: its code, else its exception flag, else its group. */
export function maerskStage(code: string, group: string, exception: boolean): ClassifiedWording | null {
  const mapped = CODES.get(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (exception) return { stage: 'exception', source: 'carrier_map' };
  const grouped = GROUPS.get(group.trim().toLowerCase());
  return grouped ? { stage: grouped, source: 'carrier_map' } : null;
}

/** By code. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code) : undefined),
  gaps: [],
};
