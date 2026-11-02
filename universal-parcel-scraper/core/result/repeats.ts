/**
 * A step a carrier records again within minutes, read once.
 * Every adapter's and provider's result goes through it before it leaves the package.
 */
import type { Stage } from '../../generated/catalog.js';
import { isRecord } from '../types.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { clocks, reading } from './registration.js';

/** How long after a scan the same wording at the same place still repeats it. */
const REPEAT_MS = 10 * 60_000;

const text = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';

/**
 * A scan with an earlier scan's wording, place and stage, at most ten minutes after it, is left
 * out: a gateway that records one departure several times, or a failed attempt written once by
 * each of a carrier's systems, is one step. A scan of another stage between them keeps the
 * repeat, as a second round after a failed attempt. Scans without a wording or a clock stay.
 */
export function withoutRepeatedScans(result: CarrierResult): CarrierResult {
  const events: unknown[] = Array.isArray(result.events) ? result.events : [];
  if (events.length < 2) return result;
  const at = clocks(events);
  const read = events.map(reading);
  // Scans dated alike in the carrier's order (`tie_order`), so the first record of a step is the one kept.
  const tie = (index: number): number => { const event = events[index]; return isRecord(event) && typeof event.tie_order === 'number' ? event.tie_order : 0; };
  const order = events.flatMap((_, index) => at[index] === null ? [] : [index]).sort((left, right) => at[left]! - at[right]! || tie(left) - tie(right));
  // The newest kept scan of each wording, place and stage, and the stages of the scans kept since.
  const kept = new Map<string, { at: number; since: (Stage | null)[] }>();
  const repeats = new Set<number>();
  for (const index of order) {
    const event = events[index];
    const wording = isRecord(event) ? text(event.description) : '';
    const key = isRecord(event) && wording ? `${wording}\n${text(event.location)}\n${text(event.stage)}` : '';
    const earlier = key ? kept.get(key) : undefined;
    if (earlier && at[index]! - earlier.at <= REPEAT_MS && earlier.since.every(stage => stage === null || stage === read[index])) {
      repeats.add(index);
      continue;
    }
    for (const scan of kept.values()) scan.since.push(read[index] ?? null);
    if (key) kept.set(key, { at: at[index]!, since: [] });
  }
  if (!repeats.size) return result;
  return { ...result, events: events.filter((_, index) => !repeats.has(index)) as CarrierEvent[] };
}
