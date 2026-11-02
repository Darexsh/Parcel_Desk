import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bangladeshPostDomesticStage, bangladeshPostStage, ROLLBACK, UNDONE } from './status.js';

export const PROVIDER = 'Bangladesh Post';
// A long history is a few kilobytes; the domestic page is smaller.
export const BANGLADESH_POST_MAX_BYTES = 512 * 1024;
// Bangladesh has one zone, without daylight saving time.
const ZONE = 'Asia/Dhaka';

const MAX_ROWS = 500;
const MAX_PAIRS = 50;
// The international tracker's answers that are not a history: "item not found" and "database error".
const NOT_FOUND = 'আইটেমটি পাওয়া যায়নি';
const DATABASE_ERROR = 'ডাটাবেজ এরর হয়েছে';
const COLUMNS = ['Event Date', 'Origin Country', 'Destination Country', 'Location', 'Status'];
// The tracker's placeholder for a country its record does not name yet.
const UNNAMED = 'Not Found';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|captcha/i;
const INTERNATIONAL_CLOCK = /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/;
const DOMESTIC_DATE = /^\d{2}-\d{2}-\d{4}$/;
// Luxon reads "13:00:00 AM" as 1 p.m., so the twelve-hour clock is checked here.
const DOMESTIC_TIME = /^(?:0[1-9]|1[0-2]):[0-5]\d:[0-5]\d [AP]M$/;
const CODE = /^[A-Za-z][A-Za-z_]{0,39}$/;
const TOKEN = /^[\w.-]{16,512}$/;
// Branch_Info is the office's type and, after this separator, its code and name.
const BRANCH_SEPARATOR = '*-^*';
// An office code: the office's postcode and two more digits.
const OFFICE_CODE = /^\d{4,6}\s+/;
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The page's labels for the domestic codes; those it shows with the scan's remarks take them after a colon.
const LABELS: Readonly<Record<string, string>> = {
  Item_Booked: 'Booked', Receive_Item: 'Received', Forwarded: 'Forwarded', Delivered_To_Receipent: 'Delivered to Customer',
  Return_To_Sender: 'Return', Item_Deleted: 'Deleted', [ROLLBACK]: 'Rollback', NonDeliver: 'NonDeliver', Bag_Movement: 'Bag Movement',
};
const WITH_REMARKS = new Set(['Forwarded', 'NonDeliver', ROLLBACK, 'Bag_Movement']);

/**
 * Bangladesh Post's trackers take S10 item codes: its own, ending BD, which
 * its domestic items use too, and those of the posts that send items to
 * Bangladesh. The code needs a valid check digit.
 */
export function normalizeBangladeshPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Bangladesh Post tracks S10 item codes');
}

/** Whether the domestic tracker can know the code: Bangladesh Post issued it. */
export function isBangladeshPostCode(number: string): boolean {
  return number.endsWith('BD');
}

interface Scan { event: CarrierEvent; index: number }

/** Newest first; scans at the same clock put the later one in the reply first. */
function newestFirst(scans: Scan[], clock: (event: CarrierEvent) => string): CarrierEvent[] {
  return [...scans].sort((left, right) => {
    const a = clock(left.event);
    const b = clock(right.event);
    return a < b ? 1 : a > b ? -1 : right.index - left.index;
  }).map(({ event }) => event);
}

/** Keeps a scan the reply lists twice once. */
function unique(events: Scan[]): Scan[] {
  const seen = new Set<string>();
  return events.filter(({ event }) => {
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function summary(events: CarrierEvent[]): Pick<CarrierResult, 'status' | 'current_stage' | 'current_stage_source' | 'last_status_text'> {
  // A scan without a stage keeps the newest staged scan's stage.
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: events[0]!.description!,
  };
}

/**
 * An international scan's "12-08-2026 06:46:51": the wall clock of the office
 * that recorded it, to the second, with no zone. The reply does not say
 * where that office is, so the clock stays local.
 */
function internationalClock(value: string): string {
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = INTERNATIONAL_CLOCK.test(value) ? DateTime.fromFormat(value, 'dd-MM-yyyy HH:mm:ss', { zone: 'UTC' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Bangladesh Post returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

const wallClock = (event: CarrierEvent): string => String(event.local_time);

/** The reply of the international lookup: a JSON string, either a message or the history's HTML. */
function internationalMessage(body: string): string {
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bangladesh Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Bangladesh Post returned a reply that is not JSON', { cause });
  }
  if (typeof reply !== 'string') throw new SchemaError(PROVIDER, 'Bangladesh Post returned an invalid reply');
  return reply;
}

/**
 * The reply of the international tracker's `search1.php` for one code: the
 * table its page shows, scans oldest first, each with its clock, the item's
 * origin and destination, the office and the IPS event's name. The table does
 * not name the item; the tracker matches whole codes only. An unknown or
 * expired code gets the page's "item not found".
 */
export function parseBangladeshPostInternational(body: string, rawNumber: string): CarrierResult {
  normalizeBangladeshPostNumber(rawNumber);
  const reply = internationalMessage(body);
  const message = clean(reply, 200);
  if (message === NOT_FOUND) throw new NotFoundError(PROVIDER);
  if (message === DATABASE_ERROR) throw new IndeterminateError(PROVIDER, 'Bangladesh Post’s tracker reported a database error');
  const $ = load(reply);
  const table = $('table#tbl_result');
  if (table.length !== 1) {
    if (BLOCKED.test(reply.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bangladesh Post answered with a browser check');
    throw new SchemaError(PROVIDER, 'Bangladesh Post returned an unexpected answer');
  }
  const rows = table.find('tr');
  if (rows.length > MAX_ROWS + 1) throw new SchemaError(PROVIDER, 'Bangladesh Post returned an oversized history');
  const headings = rows.first().children('th').toArray().map(cell => clean($(cell).text(), 40));
  if (headings.join('|') !== COLUMNS.join('|')) throw new SchemaError(PROVIDER, 'Bangladesh Post history columns changed');

  const scans: Scan[] = [];
  const destinations: Scan[] = [];
  rows.slice(1).each((index, node) => {
    const cells = $(node).children('td').toArray().map(cell => clean($(cell).text(), 200));
    if (cells.length !== COLUMNS.length) throw new SchemaError(PROVIDER, 'Bangladesh Post history columns changed');
    const [clock, , destination, place, description] = cells as [string, string, string, string, string];
    if (!description) throw new SchemaError(PROVIDER, 'Bangladesh Post returned a scan without wording');
    const location = clean(place, 120);
    const staged = bangladeshPostStage(description);
    const localTime = internationalClock(clock);
    const event: CarrierEvent = {
      local_time: localTime,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    scans.push({ event, index });
    if (destination && destination !== UNNAMED) destinations.push({ event: { local_time: localTime, description: clean(destination, 80) }, index });
  });
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Bangladesh Post returned its table without scans');
  const events = newestFirst(unique(scans), wallClock);
  // The newest scan that names the destination names it for the item.
  const named = newestFirst(destinations, wallClock)[0]?.description;
  const code = named ? countryCode(named) : null;
  return {
    ...summary(events),
    last_update: null,
    last_update_local: wallClock(events[0]!),
    expected_delivery: null,
    ...(code ? { destination_country: code } : named ? { destination_country_name: named } : {}),
    events,
  };
}

/** The token the domestic tracker's page carries, which its lookup must send. */
export function bangladeshPostDomesticToken(html: string): string {
  const token = load(html)('input#csrf_token').attr('value')?.trim() ?? '';
  if (TOKEN.test(token)) return token;
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bangladesh Post answered with a browser check');
  throw new SchemaError(PROVIDER, 'Bangladesh Post’s domestic tracker page has no lookup token');
}

/** The domestic lookup's JSON reply; a firewall's page in its place is a challenge. */
export function bangladeshPostDomesticReply(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bangladesh Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Bangladesh Post returned a domestic reply that is not JSON', { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Bangladesh Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A domestic scan's date, "03-01-2025", and time, "09:22:37 PM": the wall
 * clock of a Bangladeshi office, so Dhaka time.
 */
function domesticTime(date: string, time: string): string {
  const parsed = DOMESTIC_DATE.test(date) && DOMESTIC_TIME.test(time)
    ? firstOccurrence(DateTime.fromFormat(`${date} ${time}`, 'dd-MM-yyyy hh:mm:ss a', { zone: ZONE, locale: 'en-US' })) : null;
  const iso = parsed?.isValid ? parsed.toISO({ suppressMilliseconds: true }) : null;
  if (!iso) throw new SchemaError(PROVIDER, 'Bangladesh Post returned an invalid scan time');
  return iso;
}

/** The office's name, without its type and code. */
function officeOf(branch: string): string {
  const at = branch.indexOf(BRANCH_SEPARATOR);
  return at < 0 ? '' : clean(branch.slice(at + BRANCH_SEPARATOR.length).replace(OFFICE_CODE, ''), 120);
}

/** The scan's remarks as the page shows them, without phone numbers; a forward names the next office by its code and name. */
function remarksOf(code: string, remarks: string): string {
  const shown = clean(remarks.replace(PHONE, ''), 160);
  return (code === 'Forwarded' ? shown.replace(OFFICE_CODE, '') : shown).replace(/[\s,;:-]+$/, '');
}

interface DomesticRow { code: string; bag: boolean; event: CarrierEvent }

function domesticRow(row: unknown): DomesticRow {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bangladesh Post returned an invalid scan');
  const code = text(row, 'Status', 40);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Bangladesh Post returned an invalid scan status');
  const remarks = remarksOf(code, text(row, 'Remarks', 300));
  const label = Object.hasOwn(LABELS, code) ? LABELS[code]! : '';
  const description = !label ? remarks || code : WITH_REMARKS.has(code) && remarks
    ? code === 'Forwarded' ? `Forwarded to ${remarks}` : `${label}: ${remarks}` : label;
  const location = officeOf(text(row, 'Branch_Info', 200));
  const event: CarrierEvent = {
    time: domesticTime(text(row, 'Event_Date', 16), text(row, 'Event_Time', 16)),
    ...(location ? { location } : {}),
    description,
    provider_code: code,
  };
  return { code, bag: text(row, 'Event_Source', 16) === 'bag', event };
}

/** A domestic scan's stage from its code; an unknown code goes to the shared wording rules, and a rollback moves nothing. */
function staged(row: DomesticRow): CarrierEvent {
  const mapped = bangladeshPostDomesticStage(row.code, row.event.description);
  if (mapped) return { ...row.event, stage: mapped, stage_source: 'carrier_map' };
  if (row.code === ROLLBACK || Object.hasOwn(LABELS, row.code)) return row.event;
  const worded = classifyWording(row.event.description!, 'in_transit');
  return worded.source === 'none' ? row.event : { ...row.event, stage: worded.stage, stage_source: worded.source };
}

/** What the domestic tracker says when it has no such item: it names the code it looked up. */
function domesticRefusal(payload: Record<string, unknown>, number: string): never {
  const message = typeof payload.message === 'string' ? clean(payload.message, 300) : '';
  if (/^No information found for the ID\b/i.test(message)) {
    if (!message.toUpperCase().includes(number)) throw new SchemaError(PROVIDER, 'Bangladesh Post answered for a different item');
    throw new NotFoundError(PROVIDER);
  }
  if (/^Invalid Item ID format\b/i.test(message)) throw new InvalidInputError(PROVIDER, 'Bangladesh Post says the item ID is not in its format', { reason: 'wrong_number' });
  if (/^Invalid access$/i.test(message)) throw new SchemaError(PROVIDER, 'Bangladesh Post refused the domestic lookup request');
  throw new SchemaError(PROVIDER, 'Bangladesh Post returned an unexpected domestic answer');
}

/**
 * The reply of the domestic tracker's `get_data.php` for one code: the item's
 * bookings oldest first, each with its scans oldest first. The page shows the
 * last booking as the item's; earlier ones are other bookings under the same
 * code. A scan of the item after its delivery or return to the sender undoes
 * it, as a rollback does, and the page then shows a failed hand-over.
 */
export function parseBangladeshPostDomestic(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeBangladeshPostNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Bangladesh Post returned an invalid domestic reply');
  if (!payload.success) domesticRefusal(payload, number);
  const data = payload.data;
  if (!isRecord(data) || typeof data.item_id !== 'string') throw new SchemaError(PROVIDER, 'Bangladesh Post returned an item without its code');
  if (normalizeTrackingNumber(clean(data.item_id, 64)) !== number) throw new SchemaError(PROVIDER, 'Bangladesh Post answered for a different item');
  if (!Array.isArray(data.pairs) || data.pairs.length > MAX_PAIRS) throw new SchemaError(PROVIDER, 'Bangladesh Post returned invalid bookings');
  if (!data.pairs.length) throw new IndeterminateError(PROVIDER, 'Bangladesh Post returned the item without a booking');
  const booking: unknown = data.pairs[data.pairs.length - 1];
  if (!isRecord(booking) || !Array.isArray(booking.events)) throw new SchemaError(PROVIDER, 'Bangladesh Post returned an invalid booking');
  if (!booking.events.length) throw new IndeterminateError(PROVIDER, 'Bangladesh Post returned a booking without scans');
  if (booking.events.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Bangladesh Post returned an oversized history');

  const rows = booking.events.map(domesticRow);
  const lastItemScan = rows.reduce((last, row, index) => (row.bag ? last : index), -1);
  const scans = unique(rows.map((row, index): Scan => {
    const undone = !row.bag && index < lastItemScan && Object.hasOwn(UNDONE, row.code);
    return { event: staged(undone ? { ...row, event: { ...row.event, description: UNDONE[row.code]! } } : row), index };
  }));
  const events = newestFirst(scans, event => event.time!);
  return {
    ...summary(events),
    last_update: events[0]!.time!,
    expected_delivery: null,
    events,
  };
}
