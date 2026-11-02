import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Intel-Valley's scans are English wording without codes: its warehouse in
 * Shenzhen, its air line and the destination's clearance. The map is the
 * wording recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// A flight booked for a day, given as its month and day.
const FLIGHT_BOOKED = /^estimated \d{1,2}\.\d{1,2} flights?$/;

/** A flight booked for a day: something still to come, not a scan. */
export const flightBooked = (wording: string): boolean => FLIGHT_BOOKED.test(normalizeStatusWording(wording));

function mappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function intelValleyStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry no codes: the map reads their wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : mappedStage(wording)),
  gaps: [],
};
