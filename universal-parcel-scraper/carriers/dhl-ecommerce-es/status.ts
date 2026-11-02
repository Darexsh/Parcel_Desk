/**
 * DHL eCommerce Iberia status vocabulary.
 *
 * A scan carries a short code and the portal's wording in the requested
 * language. `statuses.json` holds the codes seen and the stage each one means.
 * A code the list does not know has no stage; the shipment's own status number
 * then says where the parcel is.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage: string };
const ENTRIES: readonly Entry[] = statuses.entries;
const CODES = new Map<string, Stage>(ENTRIES.flatMap((entry) => entry.code ? [[entry.code, entry.stage as Stage]] : []));
/** A scan sent without a code that is no depot scan: its wording alone says the stage. */
const UNCODED = new Map<string, Stage>(ENTRIES.filter((entry) => !entry.code)
  .map((entry) => [entry.wording.toLowerCase(), entry.stage as Stage]));
/** Depot scans end in a preposition and are completed by the scan's town. */
const MOVEMENTS = new Map<string, Stage>(ENTRIES.filter((entry) => entry.code === 'ZZZ')
  .map((entry) => [entry.wording.toLowerCase(), entry.stage as Stage]));

// The shipment status enum of the tracking page: 0 is unset, 3 is the
// destination depot, 4 a courier assignment and 6 a planned new attempt.
const SUMMARIES: Record<number, Stage> = {
  1: 'registered', 2: 'in_transit', 3: 'in_transit', 4: 'out_for_delivery',
  5: 'ready_for_pickup', 6: 'failed_attempt', 7: 'returned', 8: 'delivered',
};

const STATUSES: Record<Stage, CarrierStatus> = {
  pending: 'pending', registered: 'pending', accepted: 'in_transit', in_transit: 'in_transit', customs: 'in_transit',
  ready_for_pickup: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered',
  failed_attempt: 'exception', returned: 'exception', exception: 'exception',
};

export interface DhlEcommerceEsStatus { movement: boolean; stage?: Stage }

/** A depot scan is sometimes sent without its code; its wording is then the only sign. */
export function dhlEcommerceEsStatus(code: string | undefined, wording: string): DhlEcommerceEsStatus {
  const known = MOVEMENTS.get(wording.toLowerCase());
  const movement = code === 'ZZZ' || (code === undefined && known !== undefined);
  // A pickup is the first movement; any other depot scan is transit.
  const stage = movement ? known ?? 'in_transit' : code === undefined ? UNCODED.get(wording.toLowerCase()) : CODES.get(code);
  return { movement, ...(stage ? { stage } : {}) };
}

export function dhlEcommerceEsSummaryStage(status: unknown): Stage | undefined {
  return typeof status === 'number' && Object.hasOwn(SUMMARIES, status) ? SUMMARIES[status] : undefined;
}

export function statusForStage(stage: Stage): CarrierStatus {
  return STATUSES[stage];
}

/**
 * What the map says about one scan: its code and wording, as the parser reads them. A depot scan
 * is stored with its town after its wording, which still tells a pickup from transit and names a
 * depot scan that came without a code.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const movement = [...MOVEMENTS.keys()].find((key) => wording === key || wording.startsWith(`${key} `));
    return dhlEcommerceEsStatus(code ?? undefined, movement ?? wording).stage;
  },
  gaps: [],
};
