import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { isValidSscc, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { earlyBirdStage, isEarlyBirdNotice } from './status.js';

export const PROVIDER = 'Early Bird';
// A parcel's reply is a few kilobytes: at most twenty short scans.
export const EARLY_BIRD_MAX_BYTES = 128 * 1024;
// The service sends a parcel's newest twenty scans at most; the page rejects more.
export const SERVICE_SCAN_LIMIT = 20;

// What the tracking page sends: eight to thirty letters and digits.
const NUMBER = /^[A-Z0-9]{8,30}$/;
// The earlier system's clock, a wall time without an offset: "2024-12-05T03:34:05".
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// The place an arrival names, after "the terminal in" or "sorteringsterminal".
// A name with a digit is a route or a dock, so only names of letters are kept.
const ARRIVAL = /^(?:Your package has arrived at the terminal in|Ditt paket har kommit till terminalen i|Paketet har ankommit till sorteringsterminal) ([\p{L} '-]{2,60}?)\.?$/u;
// The partners a parcel can be handed over to, by the origin of the page's link.
const PARTNERS: ReadonlyMap<string, string> = new Map([
  ['https://www.postnord.se', 'PostNord'],
  ['https://www.dsv.com', 'DSV'],
  ['https://www.dbschenker.com', 'DB Schenker'],
]);
const MAX_ROWS = 200;

/** A number as Early Bird's tracking page takes it; an SSCC's check digit must pass. */
export function normalizeEarlyBirdNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Early Bird numbers are eight to thirty letters and digits');
  if (/^00\d{18}$/.test(number) && !isValidSscc(number)) {
    throw new InvalidInputError(PROVIDER, 'Early Bird parcel numbers starting 00 are SSCCs whose check digit passes');
  }
  return number;
}

/** A scan's clock: an instant when it carries an offset, else the earlier system's wall clock. */
function clockOf(value: unknown): { time: string } | { local_time: string } | null {
  const stamp = clean(value, 40);
  const instant = explicitOffsetTime(stamp);
  if (instant) return { time: instant.iso };
  const match = WALL_CLOCK.exec(stamp);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (!calendarDay(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return { local_time: `${year}-${month}-${day}T${hour}:${minute}:${second}` };
}

/** The town an arrival names, without Early Bird's name before its own terminals. */
function arrivalPlace(description: string): string {
  const place = ARRIVAL.exec(description)?.[1]?.trim() ?? '';
  return place.replace(/^Early Bird /, '');
}

function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row) || typeof row.text !== 'string' || typeof row.occurredAt !== 'string') {
    throw new SchemaError(PROVIDER, 'Early Bird returned a scan without its wording or clock');
  }
  const description = clean(row.text, 500);
  const clock = clockOf(row.occurredAt);
  if (!description || !clock) throw new SchemaError(PROVIDER, 'Early Bird returned a scan without its wording or clock');
  const location = arrivalPlace(description);
  return { ...clock, description, ...(location ? { location } : {}) };
}

/**
 * The partner a parcel was handed over to, from the origin of the page's link;
 * the page follows only these three. The partner tracks it under the same number.
 */
function handover(action: unknown): Pick<CarrierResult, 'delivery_carrier'> {
  if (!isRecord(action) || typeof action.url !== 'string') throw new SchemaError(PROVIDER, 'Early Bird returned a handover without its link');
  let url: URL;
  try { url = new URL(action.url); } catch { throw new SchemaError(PROVIDER, 'Early Bird returned a handover without its link'); }
  const name = url.protocol === 'https:' && !url.username && !url.password ? PARTNERS.get(url.origin) : undefined;
  if (!name) throw new SchemaError(PROVIDER, 'Early Bird returned a handover to an unknown partner');
  const partner = carrierIdFromPartner(name, url.href);
  return partner && partner !== 'early-bird' ? { delivery_carrier: partner } : {};
}

/**
 * The reply of `POST /api/tracking` for one number. It does not echo the
 * number: the scans belong to the one in the request. A `timeline` lists the
 * parcel's scans newest first, its current status being the newest. An
 * `external_link` names no scan: the parcel was handed over to PostNord, DSV or
 * DB Schenker, whose tracking page the link opens.
 */
export function parseEarlyBird(payload: unknown, raw: string): CarrierResult {
  normalizeEarlyBirdNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.status) || typeof payload.status.text !== 'string' || !Array.isArray(payload.events)) {
    throw new SchemaError(PROVIDER, 'Early Bird returned an unexpected reply');
  }
  const rows = payload.events as unknown[];
  if (payload.type === 'external_link') {
    const text = clean(payload.status.text, 500);
    if (rows.length || !text) throw new SchemaError(PROVIDER, 'Early Bird returned an unexpected handover');
    // Early Bird has the parcel's record and has passed it on: the partner's scans tell the rest.
    return { status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: text,
      last_update: null, expected_delivery: null, summary_only: true, ...handover(payload.action), events: [] };
  }
  if (payload.type !== 'timeline') throw new SchemaError(PROVIDER, 'Early Bird returned an unexpected reply');
  // The page refuses a timeline without scans, as the service never sends one.
  if (!rows.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Early Bird returned an invalid parcel history');

  const seen = new Set<string>();
  const events = rows.map(scanOf).filter((event) => {
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  // Oldest first, so a notice keeps the stage before it.
  let previous: Stage | undefined;
  for (const event of [...events].reverse()) {
    if (isEarlyBirdNotice(event.description!)) {
      Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
      continue;
    }
    const classified = earlyBirdStage(event.description!);
    if (!classified) continue;
    Object.assign(event, { stage: classified.stage, stage_source: classified.source });
    previous = classified.stage;
  }
  const newest = events[0]!;
  const decider = events.find((event) => event.stage && event.stage_source !== 'none');
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && decider === newest && newest.time ? { delivered_at: newest.time } : {}),
    events,
    ...(rows.length >= SERVICE_SCAN_LIMIT ? { history_truncated: true } : {}),
  };
}

/** The error code a refused lookup names, as the page reads it. */
export function earlyBirdErrorCode(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const error = payload.error;
  const code = payload.code ?? (isRecord(error) ? error.code : error);
  return typeof code === 'string' ? code : '';
}
