import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Typed, since entries without a stage carry none.
const ENTRIES: readonly { readonly code: string; readonly wording: string; readonly stage?: string; readonly note?: string }[] = statuses.entries;
const STAGES = new Map<string, Stage>(ENTRIES.flatMap((entry) => (entry.stage ? [[entry.code, entry.stage as Stage]] : [])));
const WORDINGS = new Map<string, string>(ENTRIES.map((entry) => [entry.code, entry.wording]));

/**
 * The stage a status's category gives it, for a status the page's labels do
 * not list yet. Categories that note something about the parcel without
 * moving it give none.
 */
const CATEGORIES: ReadonlyMap<string, Stage> = new Map([
  ['CREATED', 'registered'],
  ['IN_TRANSIT', 'in_transit'],
  ['CUSTOMS', 'customs'],
  ['SORTING_CENTER', 'in_transit'],
  ['DISPATCH', 'in_transit'],
  ['LOCAL_WAREHOUSE', 'in_transit'],
  ['WAREHOUSE', 'in_transit'],
  ['STAGING', 'in_transit'],
  ['IN_TRANSIT_TO_DSP', 'in_transit'],
  ['IN_DELIVERY', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['DELIVERY_FAILED', 'failed_attempt'],
  ['RETURNED', 'returned'],
  ['DAMAGED', 'exception'],
  ['STOLEN', 'exception'],
  ['THEFT', 'exception'],
  ['LOST', 'exception'],
  ['CANCELLED', 'exception'],
  ['BLOCKED', 'exception'],
  ['DESTROYED', 'exception'],
  ['POTENTIALLY_LOST', 'exception'],
  ['MISSING', 'exception'],
]);

/** The stage Quick Rabbit's map gives a status by its name. */
export function quickRabbitMappedStage(code: string | null): Stage | undefined {
  return code === null ? undefined : STAGES.get(code);
}

/**
 * A status's stage: its own name's, else, for a name the page does not label,
 * its category's. A labelled status without a stage notes something about the
 * parcel without moving it.
 */
export function quickRabbitStage(code: string, category: string | null): { stage: Stage; source: 'carrier_map' } | null {
  const stage = WORDINGS.has(code) ? STAGES.get(code) : (category === null ? undefined : CATEGORIES.get(category));
  return stage ? { stage, source: 'carrier_map' } : null;
}

/** The page's English label for a status, else its name in words. */
export function quickRabbitWording(code: string): string {
  const label = WORDINGS.get(code);
  if (label) return label;
  const words = code.toLowerCase().replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => quickRabbitMappedStage(code),
  gaps: ENTRIES.filter((entry) => !entry.stage).map((entry) => ({ code: entry.code, note: entry.note! })),
};
