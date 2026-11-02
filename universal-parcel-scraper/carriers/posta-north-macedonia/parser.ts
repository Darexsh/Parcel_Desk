import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postaNorthMacedoniaStage, wordingKey } from './status.js';

export const PROVIDER = 'Pošta na Severna Makedonija';
// A long history is a few kilobytes.
export const POSTA_NORTH_MACEDONIA_MAX_BYTES = 512 * 1024;

// A firewall's or CDN's page in place of the service's JSON.
const CHALLENGE = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|The requested URL was rejected|_cf_chl_opt|cf-turnstile|captcha/i;
// "28.07.2026 08:46", the day and the clock to the minute.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/;
// An international row's office: an IMPC or office code led by its country, "MKSKPB" or "HU350".
const OFFICE_CODE = /^([A-Z]{2})[A-Z0-9-]{1,10}$/;
const MAX_ROWS = 500;
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Pošta na Severna Makedonija's tracker takes UPU S10 item codes: its own,
 * ending MK, and those of the posts that send mail to North Macedonia. The
 * code needs a valid check digit. The service matches the code exactly and in
 * capitals, so it gets the normalized code.
 */
export function normalizePostaNorthMacedoniaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Pošta na Severna Makedonija tracks S10 item codes');
}

/** The service's reply, which is JSON; a firewall's page in its place is a challenge. */
export function parsePostaNorthMacedoniaBody(body: string): unknown {
  if (!body) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned an empty reply');
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pošta na Severna Makedonija answered with a firewall page', { cause });
    throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned a reply that is not JSON', { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Pošta na Severna Makedonija returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * `DATA_PERPUNIMIT`, the day and wall clock the row was processed, with no
 * zone: a wall clock without a verified offset, so it stays `local_time`.
 */
function clockOf(raw: string): string {
  const match = CLOCK.exec(raw);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned an invalid scan time');
  if (match[4] === undefined) return day;
  const [hour, minute, second] = [match[4], match[5]!, match[6] ?? '00'];
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned an invalid scan time');
  }
  return `${day}T${hour}:${minute}:${second}`;
}

/** The country an international row's office code starts with, if it is one. */
function officeCountry(code: string): string | null {
  const country = OFFICE_CODE.exec(code)?.[1];
  return country ? countryCode(country) : null;
}

interface Scan { event: CarrierEvent; country: string | null; inward: boolean }

/**
 * A row of the item's history. Rows from the post's own offices name the
 * office in `EMRI` beside its postcode. Rows from the UPU's exchange of
 * events leave `EMRI` blank and give an office code led by its country, so
 * they name only that country. Neither the next office (`POSTA_FUND`), the
 * dispatch numbers nor the postman's name are read.
 */
function scanOf(row: Record<string, unknown>): Scan {
  const description = text(row, 'ZABELESKA', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned a scan without wording');
  const localTime = clockOf(text(row, 'DATA_PERPUNIMIT', 40));
  const office = text(row, 'EMRI', 120);
  const country = office ? null : officeCountry(text(row, 'POSTA_FILLIM', 20));
  const location = office || (country ? countryNames.of(country) ?? '' : '');
  const staged = postaNorthMacedoniaStage(description);
  return {
    event: {
      local_time: localTime,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    country,
    // Arrived at the inward office of exchange: the country of destination.
    inward: wordingKey(description).endsWith('(vlez)'),
  };
}

/**
 * The service's reply to `shipment?code=`: an array of the item's rows, in no
 * set order. An empty array is the tracking page's "no data found", which it
 * gives an unknown code and one whose records expired. Each row names its item
 * in `NR_R_DERGESES`, and every one must name the whole code asked. A row with
 * `PRAPRIEMENBROJ` instead is the item's delivery record, without a scan; its
 * recipient fields are never read.
 */
export function parsePostaNorthMacedonia(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePostaNorthMacedoniaNumber(rawNumber);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned an invalid reply');
  if (payload.length === 0) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned an oversized history');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const row of payload) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned an invalid row');
    const scanned = Object.hasOwn(row, 'NR_R_DERGESES');
    if (!scanned && !Object.hasOwn(row, 'PRAPRIEMENBROJ')) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija returned a row without its item');
    const named = text(row, scanned ? 'NR_R_DERGESES' : 'PRAPRIEMENBROJ', 64);
    if (normalizeTrackingNumber(named) !== number) throw new SchemaError(PROVIDER, 'Pošta na Severna Makedonija answered for a different item');
    if (!scanned) continue;
    const scan = scanOf(row);
    // A row the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'Pošta na Severna Makedonija knows the item but lists no scan');
  // Newest first by clock; rows with the same clock keep the reply's order.
  const ordered = scans.map((scan, index) => ({ scan, index })).sort((left, right) =>
    String(right.scan.event.local_time).localeCompare(String(left.scan.event.local_time)) || left.index - right.index)
    .map(({ scan }) => scan);
  const events = ordered.map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destinations = new Set(ordered.filter((scan) => scan.inward && scan.country).map((scan) => scan.country!));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(destinations.size === 1 ? { destination_country: [...destinations][0]! } : {}),
    events,
  };
}
