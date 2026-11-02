import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Typed, since the list was once empty.
const ENTRIES: readonly { readonly code: string; readonly wording: string; readonly stage: string }[] = statuses.entries;
const STATUSES = new Map(ENTRIES.map((entry) => [entry.code, { stage: entry.stage as Stage, title: entry.wording }]));

/**
 * Statuses the tracking page names without saying where the parcel is: a
 * driver found or assigned, for the pickup or the delivery alike, and a missed
 * service level.
 */
const GAPS: ReadonlyMap<string, { title: string; note: string }> = new Map([
  ['driver_assigned', { title: 'Driver assigned', note: 'A driver assigned for the pickup or the delivery alike.' }],
  ['requesting_driver', { title: 'Allocating a driver', note: 'A driver sought for the pickup or the delivery alike.' }],
  ['need_review', { title: 'Allocating New Delivery Driver', note: 'Another driver sought; the page does not say for which leg.' }],
  ['package_breached', { title: 'Package Breached', note: 'A missed service level, not a place in the journey.' }],
]);

/**
 * The stage and the tracking page's title of a status key of Lazada's LEX
 * platform, shared by its sites: a key the page names without a stage has the
 * title alone, and an unknown key nothing.
 */
export function lexStatus(key: string): { stage?: Stage; title: string } | undefined {
  return STATUSES.get(key) ?? (GAPS.has(key) ? { title: GAPS.get(key)!.title } : undefined);
}

/** The map by status key. Titles repeat across keys of different stages, so a title alone stages nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STATUSES.get(code)?.stage : undefined),
  gaps: [...GAPS].map(([code, { note }]) => ({ code, note })),
};
