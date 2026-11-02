import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { morningGlobalStage } from './status.js';

export const PROVIDER = 'Morning Global';
/** The WordPress endpoint the tracker's script posts the number to. */
export const MORNING_GLOBAL_API = 'https://www.morninglobal.com/wp-admin/admin-ajax.php';
/** The tracking plugin's action. */
export const MORNING_GLOBAL_ACTION = 'mg_tr_lookup';
// The tracker page is about 80 kB of site around the plugin's configuration.
export const MORNING_GLOBAL_PAGE_MAX_BYTES = 1_000_000;
// A whole history is under two kilobytes.
export const MORNING_GLOBAL_MAX_BYTES = 256 * 1024;

// The tracker sends whatever is typed, and a comma separates several numbers.
// The adapter sends one number of eight to forty letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z\d]{8,40}$/;
const NONCE = /^[0-9a-f]{10}$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied)|_cf_chl_opt|cf-turnstile|challenge-platform/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}(?::\d{2})?$/;
// A scan's location: the country code and the offset of the scan's clock, as "CA (UTC-4)".
const PLACE = /^([A-Z]{2})\s*\(UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who signed for or received the parcel, after a delivery's wording.
const SIGNATORY = /\s*[,;:.\-–(]?\s*\b(?:signed|received)\s+by\b[\s\S]*$/i;
const ARRIVAL = 'arrive destination';
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A number for Morning Global's tracker, in capitals; anything else is not one it issues. */
export function normalizeMorningGlobalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Morning Global numbers are eight to forty letters and digits');
  return number;
}

/**
 * The nonce the tracker page gives its lookup, from the plugin's
 * configuration. A page without it is a block page or a changed site.
 */
export function parseMorningGlobalNonce(html: string): string {
  const raw = load(html)('.mg-tracking-results[data-mg-tr-config]').first().attr('data-mg-tr-config');
  let config: unknown;
  try {
    config = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    config = undefined;
  }
  if (isRecord(config) && config.action === MORNING_GLOBAL_ACTION && config.ajaxUrl === MORNING_GLOBAL_API
    && typeof config.nonce === 'string' && NONCE.test(config.nonce)) return config.nonce;
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Morning Global answered with a block page');
  throw new SchemaError(PROVIDER, 'Morning Global tracker page did not carry its lookup nonce');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Morning Global returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wording: its status, then its description when that says more, without a signatory or phone numbers. */
export function morningGlobalWording(status: string, description: string): string {
  const tidy = (value: string) => clean(value.replace(SIGNATORY, '').replace(PHONE, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  const title = tidy(status);
  const line = tidy(description);
  if (!line || line.toLowerCase() === title.toLowerCase()) return title;
  return title ? `${title}: ${line}` : line;
}

/**
 * A scan's clock. `date` and `time` are a wall clock to the minute. A
 * location that names the offset beside the country makes it an instant,
 * unless the country keeps one zone whose clock had another offset then;
 * a scan without one keeps its wall clock.
 */
function scanClock(row: Record<string, unknown>, place: RegExpExecArray | null): { time: string } | { local_time: string } {
  const date = text(row, 'date', 16);
  const clock = text(row, 'time', 16);
  const local = `${date}T${clock.length === 5 ? `${clock}:00` : clock}`;
  // Parsing in UTC checks the calendar digits only; no offset is assigned.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!DATE.test(date) || !CLOCK.test(clock) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Morning Global returned an invalid scan time');
  }
  if (!place) return { local_time: local };
  const minutes = (place[2] === '-' ? -1 : 1) * (Number(place[3] ?? 0) * 60 + Number(place[4] ?? 0));
  if (minutes < -12 * 60 || minutes > 14 * 60) throw new SchemaError(PROVIDER, 'Morning Global returned an invalid scan offset');
  const zone = countryTimeZone(place[1]);
  if (zone && firstOccurrence(DateTime.fromISO(local, { zone })).offset !== minutes) return { local_time: local };
  const sign = minutes < 0 ? '-' : '+';
  const offset = `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
  const time = DateTime.fromISO(`${local}${offset}`, { setZone: true }).toISO({ suppressMilliseconds: true });
  if (!time) throw new SchemaError(PROVIDER, 'Morning Global returned an invalid scan time');
  return { time };
}

function projectRow(row: unknown): { key: string; event: CarrierEvent; country: string | null; arrival: boolean } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Morning Global returned an invalid scan');
  const status = text(row, 'status');
  const description = morningGlobalWording(status, text(row, 'description', 500));
  if (!description) throw new SchemaError(PROVIDER, 'Morning Global returned a scan without wording');
  const label = text(row, 'location', 120);
  const place = PLACE.exec(label);
  const country = place ? countryCode(place[1]) : null;
  const location = place ? place[1]! : label;
  const clock = scanClock(row, place && country ? place : null);
  const staged = morningGlobalStage(status || description);
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  const at = 'time' in clock ? clock.time : clock.local_time;
  return { key: JSON.stringify([at, description, location]), event, country, arrival: status.toLowerCase() === ARRIVAL };
}

/**
 * The reply of the tracker's WordPress action for one number: one result per
 * number asked, each with `found`, a summary and its scans oldest first. An
 * unknown number is a result with `found: false`, which the page reports as
 * not found. The result must name the number asked. The signatory, origin,
 * reference, weight, pieces and estimate are never read.
 */
export function parseMorningGlobal(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMorningGlobalNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Morning Global returned an invalid envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Morning Global did not complete the lookup');
  const results = isRecord(payload.data) ? payload.data.results : undefined;
  if (!Array.isArray(results) || results.length > 20) throw new SchemaError(PROVIDER, 'Morning Global returned invalid results');
  if (results.some((result) => !isRecord(result) || typeof result.tracking_number !== 'string' || typeof result.found !== 'boolean')) {
    throw new SchemaError(PROVIDER, 'Morning Global returned a result without its number');
  }
  const own = (results as Record<string, unknown>[]).find((result) => {
    const named = result.tracking_number as string;
    return named.length <= 64 && normalizeTrackingNumber(named).toUpperCase() === number;
  });
  if (!own) throw new IndeterminateError(PROVIDER, 'Morning Global answered for another number');
  if (!own.found) throw new NotFoundError(PROVIDER);
  const rows = own.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Morning Global returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Morning Global returned an oversized history');

  const seen = new Set<string>();
  const scans: ReturnType<typeof projectRow>[] = [];
  for (const row of rows) {
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The reply lists the scans oldest first; the result lists them newest first.
  const clockOf = (event: CarrierEvent) => String(event.time ?? event.local_time).slice(0, 16);
  if (clockOf(scans[0]!.event) <= clockOf(scans.at(-1)!.event)) scans.reverse();
  const events = scans.map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = text(own, 'service', 80);
  const country = countryCode(text(own, 'destination', 80)) ?? scans.find((scan) => scan.arrival && scan.country)?.country ?? null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
