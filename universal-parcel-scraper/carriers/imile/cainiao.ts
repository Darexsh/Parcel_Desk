/**
 * Cainiao's leg of the parcels it hands to iMile.
 *
 * iMile's tracker starts with its order record and its own centres. For a
 * parcel Cainiao carries out of China, Cainiao's global tracker holds the
 * pickup, sorting, export, flight and import scans under the same iMile
 * number, then relays iMile's own scans at their own clocks. Those older scans
 * go in front of iMile's history; iMile's own scans stay as iMile gave them.
 */
import { IndeterminateError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { cainiaoCarrierNames, parseCainiaoTrackingResponse } from '../aliexpress/adapter.js';
import { imileSummary } from './parser.js';

export const CAINIAO = 'Cainiao';
/** How Cainiao names iMile as the parcel's destination carrier or a scan's carrier ("Imile"). */
const IMILE_NAME = /^imile\b/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2})?$/;
// A clock without an offset may be any instant up to 14 hours before its wall time.
const EARLIEST_OFFSET_MS = 14 * 3_600_000;
const SUMMARY_KEYS = ['status', 'current_stage', 'current_stage_source', 'last_status_text', 'last_update', 'last_update_local'] as const;

/**
 * Cainiao's scans of an iMile parcel, from its `detail.json` reply for the
 * number. The record must name iMile as a carrier of the parcel: the same
 * number in Cainiao's feed may be another network's parcel. A scan Cainiao
 * does not place keeps its wall clock in `local_time`, as iMile's do.
 */
export function cainiaoScans(payload: unknown, number: string): CarrierEvent[] {
  const events = parseCainiaoTrackingResponse(payload, number).events ?? [];
  if (!events.length) return [];
  if (![...cainiaoCarrierNames(payload, number)].some((name) => IMILE_NAME.test(name))) {
    throw new IndeterminateError(CAINIAO, 'Cainiao does not name iMile as a carrier of the parcel', { reason: 'carrier_unconfirmed' });
  }
  return events.flatMap(({ time, local_time, location, stage, stage_source, ...event }): CarrierEvent[] => {
    const clock = typeof time === 'string' && time ? time : typeof local_time === 'string' ? local_time : '';
    if (!event.description || !clock) return [];
    const placed = explicitOffsetTime(clock) ? { time: clock } : WALL_CLOCK.test(clock) ? { local_time: clock.replace(' ', 'T') } : null;
    if (!placed) return [];
    return [{ ...placed, ...(location ? { location } : {}), ...event,
      ...(stage ? { stage, stage_source: typeof stage_source === 'string' ? stage_source : 'carrier_map' } : {}) }];
  });
}

interface Clock {
  /** The instant, when the scan's offset is known. */
  instant: number | null;
  /** The wall clock, to the second or the day. */
  wall: string;
  /** The earliest instant the scan may be. */
  earliest: number;
  /** Where the scan sorts: its instant, else its wall clock read in UTC. */
  key: number;
}

function clockOf(event: CarrierEvent): Clock {
  const time = typeof event.time === 'string' ? event.time : '';
  const placed = explicitOffsetTime(time);
  if (placed) return { instant: placed.timestamp, wall: time.slice(0, 19), earliest: placed.timestamp, key: placed.timestamp };
  const wall = (typeof event.local_time === 'string' ? event.local_time : time).replace(' ', 'T');
  const read = WALL_CLOCK.test(wall) ? Date.parse(`${wall.length === 10 ? `${wall}T00:00:00` : wall}Z`) : Number.NaN;
  const key = Number.isFinite(read) ? read : Number.NEGATIVE_INFINITY;
  return { instant: null, wall, earliest: key - EARLIEST_OFFSET_MS, key };
}

/** The same scan in both feeds: Cainiao relays iMile's scans on iMile's own wall clock. */
function sameScan(cainiao: Clock, imile: Clock): boolean {
  if (cainiao.instant !== null && imile.instant !== null) return cainiao.instant === imile.instant;
  return cainiao.wall.length === 19 && cainiao.wall === imile.wall;
}

/** Two histories newest first in one, each in its own order; iMile's scan first when they sort alike. */
function interleave(imile: readonly CarrierEvent[], cainiao: readonly CarrierEvent[]): CarrierEvent[] {
  const merged: CarrierEvent[] = [];
  let i = 0;
  let c = 0;
  while (i < imile.length || c < cainiao.length) {
    const takeImile = c >= cainiao.length || (i < imile.length && clockOf(imile[i]!).key >= clockOf(cainiao[c]!).key);
    merged.push(takeImile ? imile[i++]! : cainiao[c++]!);
  }
  return merged;
}

/**
 * iMile's answer with Cainiao's scans from before iMile handled the parcel.
 * iMile handles it from its first scan with a stage past its order record,
 * such as a pickup, a flight or a centre: Cainiao's scans count only up to
 * the last one that is older at every reading, and a scan both report stays
 * iMile's. Before iMile's first such scan, its order record is all it has,
 * and the newest scan of either feed gives the status.
 */
export function withCainiaoLeg(imile: CarrierResult, cainiao: readonly CarrierEvent[]): CarrierResult {
  const own = imile.events ?? [];
  // A history cut short has lost its oldest scans, which Cainiao's leg would go behind.
  if (!own.length || !cainiao.length || imile.history_truncated) return imile;
  const ownClocks = own.map(clockOf);
  const handled = own.flatMap((event, index) => (event.stage && event.stage !== 'registered' ? [index] : []));
  const cut = handled.length ? Math.min(...handled.map((index) => ownClocks[index]!.earliest)) : Number.POSITIVE_INFINITY;
  // Cainiao lists its scans newest first: its leg starts at its newest scan older than iMile's first.
  const start = cainiao.findIndex((event) => {
    const { instant } = clockOf(event);
    return instant !== null && instant < cut;
  });
  const leg = (start < 0 ? [] : cainiao.slice(start)).filter((event) => {
    const clock = clockOf(event);
    return !(clock.instant !== null && clock.instant >= cut) && !ownClocks.some((other) => sameScan(clock, other));
  });
  if (!leg.length) return imile;
  if (handled.length) {
    const kept = handled.at(-1)! + 1;
    return { ...imile, events: [...own.slice(0, kept), ...interleave(own.slice(kept), leg)] };
  }
  const events = interleave(own, leg);
  // The merged history's summary replaces iMile's whole: no key of iMile's stays beside it.
  const rest: CarrierResult = { ...imile };
  for (const key of SUMMARY_KEYS) delete rest[key];
  return { ...imileSummary(events), ...rest, events };
}
