/**
 * Whether a fallback's history should replace a carrier's partial answer, and what of the carrier's
 * own answer it keeps, and which of a fallback's rows are the carrier's forecasts. The tracker
 * applies this to every partial direct answer and every direct answer without history; hosts that
 * route lookups themselves apply the same rules.
 */
import { deliveryHandoff } from '../catalog/handoff.js';
import { carrierBrand } from '../catalog/networks.js';
import { isValidS10TrackingNumber } from '../detection/index.js';
import { EXPLICIT_OFFSET_PATTERN, explicitOffsetTime } from '../time/index.js';
import { eventTimestamp } from '../time/result.js';
import type { Stage } from '../../generated/catalog.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { withoutEvents } from './due.js';
import { deliveredToDoor } from './pickup.js';
import { resolveResult, type ResolvedEvent, type ResolvedResult } from './resolve.js';

/**
 * How far along a parcel is, for comparing two answers about it. Stages a parcel
 * moves between in either order share a rank; `exception` has none.
 */
export const PROGRESS: Partial<Record<Stage, number>> = {
  pending: 0, registered: 1, accepted: 2, in_transit: 3, customs: 3,
  out_for_delivery: 4, failed_attempt: 4, ready_for_pickup: 4, delivered: 5, returned: 5,
};
const FINAL_STAGES = new Set(['delivered', 'returned']);

/** A provider relaying the carrier's newest scan can drop its seconds. */
const SAME_SCAN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The span of instants a clock can name: one with an offset, else its wall time in any zone, UTC−12 to UTC+14. */
interface ClockSpan { earliest: number; latest: number }

function clockSpan(value: unknown): ClockSpan | null {
  if (typeof value !== 'string') return null;
  const exact = explicitOffsetTime(value);
  if (exact) return { earliest: exact.timestamp, latest: exact.timestamp };
  // A wall clock needs a whole calendar date: a time alone would read as today, a month as its first day.
  if (EXPLICIT_OFFSET_PATTERN.test(value.trim()) || !/^\s*(?:\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{4})/.test(value)) return null;
  const wall = Date.parse(eventTimestamp(value, 'UTC') ?? '');
  if (!Number.isFinite(wall)) return null;
  // A date alone can be any time of that day.
  return { earliest: wall - 14 * HOUR_MS, latest: wall + (/\d:\d\d/.test(value) ? 12 : 36) * HOUR_MS };
}

/** Where a result's newest clock can fall, from every clock it states, or null without one. */
function newestSpan(result: ResolvedResult): ClockSpan | null {
  const spans = [result.last_update, result.last_update_local, ...result.events.flatMap(event => [event.time, event.local_time])]
    .map(clockSpan).filter((span): span is ClockSpan => span !== null);
  return spans.length ? { earliest: Math.max(...spans.map(span => span.earliest)), latest: Math.max(...spans.map(span => span.latest)) } : null;
}

/** Where an event's own clock can fall, or null without one. */
const eventSpan = (event: ResolvedEvent): ClockSpan | null => clockSpan(event.time) ?? clockSpan(event.local_time);

/**
 * How many scans a history holds. A provider can relay one scan twice in two wordings, so events
 * at the same minute and stage count once; an event without a time of day counts on its own.
 */
function scanCount(result: ResolvedResult): number {
  return new Set(result.events.map((event, index) => {
    const clock = [event.time, event.local_time]
      .find((value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value));
    return clock ? `${clock.slice(0, 16).replace(' ', 'T')}|${event.stage}` : index;
  })).size;
}

/**
 * Whether a history holds the carrier's final stage no earlier than the carrier, with only scans
 * of an earlier rank after it: its newest event at that stage is not behind the carrier's own, or
 * behind the carrier's state for a summary.
 */
function reached(answer: ResolvedResult, direct: ResolvedResult, stage: string): boolean {
  const index = answer.events.findIndex(event => event.stage === stage);
  if (index < 0) return false;
  // A scan uploaded late, such as processing, may follow it; a delivery, a return or an exception may not.
  const rank = PROGRESS[stage as Stage] ?? 0;
  if (answer.events.slice(0, index).some(event => (PROGRESS[event.stage] ?? rank) >= rank)) return false;
  const theirs = answer.events[index]!;
  const own = direct.events.find(event => event.stage === stage);
  const ours = own ? eventSpan(own) : newestSpan(direct);
  const their = eventSpan(theirs);
  return !(ours && their && their.latest + SAME_SCAN_MS < ours.earliest);
}

/**
 * Whether a provider names one of `carriers`. A brand's networks can share a number's shape and
 * providers name the brand ("gofo" for a GOFO France parcel), so another network of the same
 * brand counts as that carrier.
 */
function namesOneOf(named: string, carriers: readonly string[]): boolean {
  const brand = carrierBrand(named);
  return carriers.some((id) => id === named || (brand !== undefined && carrierBrand(id) === brand));
}

/**
 * Whether a provider's answer should replace a partial direct one. It must hold more scans, name
 * no other carrier than `carriers` (any carrier when null), and not be behind the carrier's own
 * state. Clocks rule a provider out when even its latest reading is before the carrier's earliest
 * one. A final direct stage needs the same stage, or a history that reached it too with only
 * scans of an earlier rank after it, such as a scan uploaded after the delivery; otherwise an
 * earlier stage never replaces it. A different stage of the same rank, or an exception against
 * another stage, needs a newest scan that is certainly later. Two exceptions can be two problems,
 * so the provider's must be certainly no earlier, as when it relays the carrier's own.
 */
function fuller(answer: ResolvedResult, direct: ResolvedResult, carriers: readonly string[] | null): boolean {
  if (scanCount(answer) <= scanCount(direct)) return false;
  if (carriers && typeof answer.discovered_carrier === 'string' && !namesOneOf(answer.discovered_carrier, carriers)) return false;
  const ours = newestSpan(direct);
  const theirs = newestSpan(answer);
  if (ours && theirs && theirs.latest + SAME_SCAN_MS < ours.earliest) return false;
  const was = direct.current_stage;
  const now = answer.current_stage;
  if (was === undefined || (now === was && now !== 'exception')) return true;
  const from = PROGRESS[was as Stage];
  const to = PROGRESS[now as Stage];
  if (FINAL_STAGES.has(was)) return from !== undefined && to !== undefined && to < from && reached(answer, direct, was);
  if (from !== undefined && to !== undefined && from !== to) return to > from;
  if (now === was) return Boolean(ours && theirs && theirs.earliest + SAME_SCAN_MS >= ours.latest);
  return Boolean(ours && theirs && theirs.earliest > ours.latest + SAME_SCAN_MS);
}

/** What the carrier states about the parcel beside its scans, recipient details aside; each group is kept whole. */
const CARRIER_FACTS = [
  ['expected_delivery', 'expected_delivery_from'], ['delivery_carrier', 'delivery_tracking_number'],
  ['destination_country', 'destination_country_name'], ['canonical_tracking_number'], ['international_tracking_number'],
  ['sender_name'], ['pickup_point'], ['delivered_at'], ['weight_kg'], ['dimensions_text'], ['service_name'], ['import_charges'],
] as const;

/** The carrier's current status, which a final stage keeps over a history that scanned on after reaching it. */
const CARRIER_STATE = ['status', 'current_stage', 'current_stage_source', 'last_status_text', 'provider_code'] as const;

/**
 * `raw`, the provider's answer as it came, with the carrier's own facts it lacks. An estimate does
 * not outlive a final stage, and a pickup point does not outlive a door delivery the history shows.
 * Both answers are compared resolved.
 */
function withCarrierFacts<T extends CarrierResult>(raw: T, answer: ResolvedResult, direct: ResolvedResult): T {
  const merged: CarrierResult = { ...raw };
  let stage = answer.current_stage;
  if (FINAL_STAGES.has(direct.current_stage ?? '') && answer.current_stage !== direct.current_stage) {
    for (const field of CARRIER_STATE) {
      if (direct[field] === undefined) delete merged[field];
      else Object.assign(merged, { [field]: direct[field] });
    }
    stage = direct.current_stage;
  }
  for (const group of CARRIER_FACTS) {
    if (group[0] === 'expected_delivery' && FINAL_STAGES.has(stage ?? '')) continue;
    if (group[0] === 'pickup_point' && deliveredToDoor({ ...answer, current_stage: stage })) continue;
    if (group.every(field => answer[field] == null) && group.some(field => direct[field] != null)) {
      for (const field of group) if (direct[field] != null) Object.assign(merged, { [field]: direct[field] });
    }
  }
  return merged as T;
}

/** A carrier's answer that holds only its current status or only part of its history. */
export function isPartialAnswer(result: CarrierResult): boolean {
  return result.summary_only === true || result.history_truncated === true;
}

/**
 * A fallback's answer in place of the carrier's partial one, `direct`, with the carrier's own facts
 * the fallback lacks, or null when the carrier's answer stands. The fallback must hold more scans,
 * name no carrier other than `carrier`, the one the carrier hands the parcel to or the partner it
 * names, or another network of their brand, and not be behind the carrier's state. A checksum-valid S10 number is one postal item for
 * every operator that carries it, so a fallback for it may name any of them. Its copies of the
 * rows the carrier holds back as written ahead (`written_ahead`) are no scans and are set aside.
 */
export function fillPartialAnswer<T extends CarrierResult>(carrier: string, number: string, direct: CarrierResult, answer: T): T | null {
  const relayed = withoutWrittenAhead(answer, direct.written_ahead ?? []);
  if (!relayed) return null;
  const ours = resolveResult(direct);
  const theirs = resolveResult(relayed);
  const owners = isValidS10TrackingNumber(number) ? null
    : [carrier, ours.delivery_carrier, deliveryHandoff(carrier, number, ours)?.carrier].filter((id): id is string => typeof id === 'string');
  return fuller(theirs, ours, owners) ? withCarrierFacts(relayed, theirs, ours) : null;
}

/** A clock's wall time, its minute and its seconds when it states them, or null without a date and a time of day. */
function wallTime(value: unknown): { minute: string; seconds?: string } | null {
  const match = typeof value === 'string' ? /^\s*(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/.exec(value) : null;
  return match ? { minute: `${match[1]}T${match[2]}`, ...(match[3] ? { seconds: match[3] } : {}) } : null;
}

/**
 * Whether an event is at `clock`: the same instant within a minute, or the same wall time, its
 * seconds too when both state them, as when a provider puts the carrier's wall clock in another
 * zone or labels it UTC.
 */
function atClock(event: CarrierEvent, clock: string): boolean {
  const ahead = explicitOffsetTime(clock);
  const instant = explicitOffsetTime(event.time);
  if (ahead && instant && Math.abs(ahead.timestamp - instant.timestamp) < SAME_SCAN_MS) return true;
  const wall = wallTime(clock);
  return wall !== null && [event.time, event.local_time].map(wallTime).some(other => other?.minute === wall.minute
    && (!other.seconds || !wall.seconds || other.seconds === wall.seconds));
}

/**
 * A fallback's answer without its rows at `clocks`, those the carrier holds back as written ahead
 * of them (`writtenAheadClocks` of its error), or null when nothing else remains. When the newest
 * row goes, the status is read again from the rows left.
 */
export function withoutWrittenAhead<T extends CarrierResult>(answer: T, clocks: readonly string[]): T | null {
  return clocks.length ? withoutEvents(answer, event => clocks.some(clock => atClock(event, clock))) : answer;
}
