import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';

/** Reject malformed clock/offset digits before the date library can normalize them. */
export function inpostClock(value: unknown): ParsedTime | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const raw = value.trim();
  const clock = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):?(\d{2}))$/i.exec(raw);
  if (!clock) return null;
  if (clock[1]) {
    const hours = Number(clock[2]);
    const minutes = Number(clock[3]);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  }
  return explicitOffsetTime(raw);
}
