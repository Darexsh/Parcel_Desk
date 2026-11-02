/**
 * Rows set aside from an answer: scans a carrier lists at their planned time, before they happen,
 * and a fallback's copies of rows a carrier wrote ahead (`withoutWrittenAhead`).
 */
import { NoHistoryError } from '../errors/index.js';
import { explicitOffsetTime } from '../time/index.js';
import type { CarrierEvent, CarrierResult } from './index.js';

// A clock a few minutes fast is no plan.
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * `answer` without the events `drop` picks, or null when nothing is left of it. When the newest
 * event goes, the status is read again from the events left.
 */
export function withoutEvents<T extends CarrierResult>(answer: T, drop: (event: CarrierEvent) => boolean): T | null {
  const events = answer.events ?? [];
  const kept = events.filter(event => !drop(event));
  const stale = typeof answer.last_update === 'string' && drop({ time: answer.last_update });
  if (kept.length === events.length && !stale) return answer;
  if (!kept.length) return null;
  if (!stale && kept[0] === events[0]) return { ...answer, events: kept };
  const reread: CarrierResult = { ...answer, status: 'unknown', last_status_text: kept[0]!.description ?? null,
    last_update: kept[0]!.time ?? null, events: kept };
  delete reread.current_stage;
  delete reread.current_stage_source;
  delete reread.provider_code;
  return reread as T;
}

/**
 * A carrier's answer without the scans it dates more than a few minutes after `readAt`, for a
 * carrier that enters some scans at their planned time: they show once they are due.
 */
export function dueScans<T extends CarrierResult>(answer: T, provider: string, readAt = Date.now()): T {
  const due = withoutEvents(answer, event => (explicitOffsetTime(event.time)?.timestamp ?? -Infinity) > readAt + CLOCK_SKEW_MS);
  if (!due) throw new NoHistoryError(provider, `${provider} lists only scans still to come`);
  return due;
}
