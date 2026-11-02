/**
 * A registration a carrier writes after the parcel has moved, read as no step back.
 * Every adapter's and provider's result goes through it before it leaves the package.
 */
import { STAGES, type Stage } from '../../generated/catalog.js';
import { classifyWording } from '../status/index.js';
import { explicitOffsetTime } from '../time/index.js';
import { isRecord } from '../types.js';
import type { CarrierEvent, CarrierResult } from './index.js';

const stages = new Set<string>(STAGES);
/** Stages that show the parcel has moved. A customs filing or a problem can come before it has. */
const MOVED = new Set<Stage>(['accepted', 'in_transit', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'delivered', 'returned']);
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** The stage a scan is read in, as the consumer reads it: declared, else by its wording. Null when no map or rule read it. */
export function reading(event: unknown): Stage | null {
  if (!isRecord(event)) return null;
  const declared = typeof event.stage === 'string' && stages.has(event.stage) ? event.stage as Stage : undefined;
  if (declared) return event.stage_source === 'none' ? null : declared;
  const wording = classifyWording(typeof event.description === 'string' ? event.description : '', 'in_transit');
  return wording.source === 'none' ? null : wording.stage;
}

/**
 * Each scan's instant, or, in a history with none, its wall clock. A scan with neither,
 * or with a wall clock among instants, is not ordered.
 */
export function clocks(events: readonly unknown[]): (number | null)[] {
  const field = (event: unknown, key: 'time' | 'local_time') => isRecord(event) && typeof event[key] === 'string' ? event[key] : '';
  const instants = events.map(event => explicitOffsetTime(field(event, 'time'))?.timestamp ?? null);
  if (instants.some(at => at !== null)) return instants;
  return events.map(event => {
    const wall = [field(event, 'local_time'), field(event, 'time')].find(value => WALL_CLOCK.test(value));
    const at = wall ? Date.parse(`${wall}Z`) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  });
}

/**
 * A registration (a label created, data received, a pre-advice) dated after a scan that moved
 * the parcel, such as a partner's label or a line's order row written once the parcel is on its
 * way, is no step back: it is in transit, even after an acceptance, since a label is not one.
 * One dated first, or at the instant of the first movement, stays registered. Its stage then
 * comes from this reading of the carrier's sequence, so its source is `carrier_map`. A result
 * whose current stage is registered for its newest scan, read so, takes that scan's stage.
 */
export function readLateRegistrations(result: CarrierResult): CarrierResult {
  const events: unknown[] = Array.isArray(result.events) ? result.events : [];
  if (events.length < 2) return result;
  const read = events.map(reading);
  const at = clocks(events);
  const order = events.flatMap((_, index) => at[index] === null ? [] : [index]).sort((left, right) => at[left]! - at[right]!);
  const settled = new Set<number>();
  let moved = false;
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end < order.length && at[order[end]!] === at[order[start]!]) end++;
    const together = order.slice(start, end);
    for (const index of together) if (moved && read[index] === 'registered') settled.add(index);
    if (together.some(index => MOVED.has(read[index] as Stage))) moved = true;
    start = end;
  }
  if (!settled.size) return result;
  const newest = order.filter(index => at[index] === at[order.at(-1)!]);
  const headline = result.current_stage === 'registered' && newest.some(index => settled.has(index))
    && newest.every(index => read[index] !== 'registered' || settled.has(index));
  return {
    ...result,
    ...(headline ? { current_stage: 'in_transit', current_stage_source: 'carrier_map', ...(result.status === 'pending' ? { status: 'in_transit' } : {}) } : {}),
    events: events.map((event, index) => settled.has(index)
      ? { ...event as CarrierEvent, stage: 'in_transit', stage_source: 'carrier_map' } : event) as CarrierEvent[],
  };
}
