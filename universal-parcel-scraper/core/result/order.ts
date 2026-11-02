import type { CarrierEvent } from './index.js';

// A time that names its offset is an instant; one without is a wall clock.
const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

interface ScanTime { wall: boolean; at: number }

/**
 * When a scan happened, as its answer's other scans compare with it: an instant, or a wall clock
 * without a zone, read the same whatever the host's zone and compared only with the answer's other
 * wall clocks; null when it has no time.
 */
function scanTime(event: CarrierEvent): ScanTime | null {
  for (const time of [event.time, event.local_time]) {
    if (typeof time !== 'string' || !time) continue;
    const wall = !OFFSET.test(time);
    const at = Date.parse(wall && time.includes('T') ? `${time}Z` : time);
    if (Number.isFinite(at)) return { wall, at };
  }
  return null;
}

/**
 * Whether an answer lists its newest scan first (true) or last (false), from its scans of
 * different instants; null when it dates every scan alike or lists them both ways as often.
 */
export function listsNewestFirst(events: CarrierEvent[]): boolean | null {
  let [later, earlier] = [0, 0];
  const previous = new Map<boolean, number>();
  for (const time of events.map(scanTime)) {
    if (time === null) continue;
    const before = previous.get(time.wall);
    if (before !== undefined && time.at !== before) {
      if (time.at > before) later += 1;
      else earlier += 1;
    }
    previous.set(time.wall, time.at);
  }
  return later === earlier ? null : earlier > later;
}

/**
 * Numbers the scans an answer dates alike (`tie_order`), from the oldest, in the order the
 * answer lists them: a carrier lists two scans of one second in the order they happened, which
 * their times cannot tell. An adapter that sorts a carrier's scans keeps the order of those it
 * dates alike in the direction the carrier listed them; one that turns an oldest-first list
 * newest first reverses it rather than sorting it.
 */
export function withTieOrder(events: CarrierEvent[]): void {
  for (const event of events) delete event.tie_order;
  const newestFirst = listsNewestFirst(events);
  if (newestFirst === null) return;
  const ties = new Map<string, CarrierEvent[]>();
  for (const event of events) {
    const time = scanTime(event);
    if (time === null) continue;
    const key = `${time.wall ? 'wall' : 'instant'} ${time.at}`;
    ties.set(key, [...ties.get(key) ?? [], event]);
  }
  for (const tie of ties.values()) {
    if (tie.length < 2) continue;
    for (const [order, event] of (newestFirst ? [...tie].reverse() : tie).entries()) event.tie_order = order;
  }
}
