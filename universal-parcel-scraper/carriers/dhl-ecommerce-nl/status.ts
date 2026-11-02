/**
 * DHL eCommerce Netherlands status vocabulary.
 *
 * The gateway sends a status code and a coarse category on every event. The
 * codes and their English wording come from the translation file the tracking
 * page loads; `statuses.json` holds that list with the stage each code means.
 * A code the list does not know falls back to its category.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage: Stage }

const CODES = new Map<string, Entry>(statuses.entries.map((entry) => [entry.code, { wording: entry.wording, stage: entry.stage as Stage }]));

// The page files CUSTOMS and IN_DELIVERY under movement too: both hold sorting
// scans and next-day plans next to the clearance and courier scans the codes name.
const CATEGORIES: Record<string, Stage> = {
  DATA_RECEIVED: 'registered', LEG: 'registered', COLLECTION_EXPECTED: 'registered',
  COLLECTED: 'accepted',
  PREPROCESS: 'in_transit', UNDERWAY: 'in_transit', POSTPROCESS: 'in_transit', CUSTOMS: 'in_transit',
  IN_DELIVERY: 'in_transit', INTERVENTION: 'in_transit',
  DELIVERED: 'delivered',
  NOT_COLLECTED: 'exception', EXCEPTION: 'exception', PROBLEM: 'exception',
};

const STATUSES: Record<Stage, CarrierStatus> = {
  pending: 'pending', registered: 'pending', accepted: 'in_transit', in_transit: 'in_transit', customs: 'in_transit',
  ready_for_pickup: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  failed_attempt: 'exception', returned: 'exception', exception: 'exception',
};

export interface DhlEcommerceNlStatus { description: string; stage?: Stage }

export function dhlEcommerceNlStatus(code: string, category: unknown): DhlEcommerceNlStatus {
  const known = CODES.get(code);
  if (known) return { description: known.wording, stage: known.stage };
  const stage = typeof category === 'string' && Object.hasOwn(CATEGORIES, category) ? CATEGORIES[category] : undefined;
  const words = code.replaceAll(/[_/-]+/g, ' ').toLowerCase();
  return { description: words.charAt(0).toUpperCase() + words.slice(1), ...(stage ? { stage } : {}) };
}

export function statusForStage(stage: Stage): CarrierStatus {
  return STATUSES[stage];
}

/** The stage of each recorded wording, left out where two codes word it alike with different stages. */
const WORDINGS = new Map<string, Stage | undefined>();
for (const { wording, stage } of CODES.values()) {
  const key = normalizeStatusWording(wording);
  WORDINGS.set(key, WORDINGS.has(key) && WORDINGS.get(key) !== stage ? undefined : stage);
}

/**
 * What the map says about one scan: its code, else, for a copy without one, the wording the
 * tracking page gives a code. A code the list does not know stays open, since its category
 * staged it and the stored scan does not keep that.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code)?.stage : WORDINGS.get(wording)),
  gaps: [],
};
