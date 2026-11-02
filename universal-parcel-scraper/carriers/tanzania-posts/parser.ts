import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { countryCode, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tanzaniaPostsStage } from './status.js';

export const PROVIDER = 'Tanzania Posts Corporation';
// A reply is a few kilobytes; a long history adds about a hundred bytes a scan.
export const TANZANIA_POSTS_MAX_BYTES = 512 * 1024;
/** The Posta Tracking System's search page, whose form posts the code to the lookup. */
export const TANZANIA_POSTS_TRACKER = 'https://tracking.posta.co.tz/index.php/Tracking/tracker';
/** The lookup the search form posts the code to. */
export const TANZANIA_POSTS_LOOKUP = 'https://tracking.posta.co.tz/index.php/Tracking/get_NEW_NEW_tracking_information';

const ZONE = 'Africa/Dar_es_Salaam';
const MAX_ROWS = 500;
// The tracker's own notice for a code it does not hold.
const NOT_FOUND = /^Barcode Not Found\b/i;
// Its notice for an item whose charge is unpaid, followed by the amount and the payment's control number.
const UNPAID = /^You cannot track unpaid transaction\b/i;
// A firewall's, CDN's or bot check's page in place of the reply, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// CodeIgniter's error pages, and the site's own page for a route it does not have.
const ERROR_PAGE = /A PHP Error was encountered|An uncaught Exception was encountered|A Database Error Occurred|<title>\s*(?:404 Page Not Found|Database Error|Error)\s*<\/title>|<title>[^<]*\|\s*404\s*<\/title>/i;
const BARCODE = /^Barcode:\s*(.*)$/;
// The origin's label ends with a full-width colon.
const END = /^(Origin|Destination)\s*[:：]$/;
// "Arusha - Branch: Sample Hpo": the region, then the post office.
const PLACE = /^(.*?)\s+-\s+Branch:/;
// "Acceptance Sample Hpo": the counter scan names the office after its wording.
const ACCEPTANCE = /^(Acceptance)\s+(.+)$/i;
// "Monday 2 March 2026, 15:20:30 PM": a 24-hour clock followed by AM or PM.
const CREATED = /^(\p{L}+) (\d{1,2}) (\p{L}+) (\d{4}), (\d{2}):([0-5]\d):([0-5]\d) (AM|PM)$/u;
const WEIGHT = /^\d{1,5}(?:\.\d{1,3})?$/;
const FINAL = new Set<Stage>(['delivered', 'returned']);
// Tanzania's regions, which the page names for an item's origin and destination, with the
// English names of Pwani and of Zanzibar's and Pemba's regions.
const REGIONS = new Set([
  'Arusha', 'Dar es Salaam', 'Dodoma', 'Geita', 'Iringa', 'Kagera', 'Katavi', 'Kigoma', 'Kilimanjaro', 'Lindi', 'Manyara', 'Mara',
  'Mbeya', 'Morogoro', 'Mtwara', 'Mwanza', 'Njombe', 'Pwani', 'Coast', 'Rukwa', 'Ruvuma', 'Shinyanga', 'Simiyu', 'Singida', 'Songwe',
  'Tabora', 'Tanga', 'Kaskazini Pemba', 'Kusini Pemba', 'Kaskazini Unguja', 'Kusini Unguja', 'Mjini Magharibi', 'Pemba North',
  'Pemba South', 'Zanzibar North', 'Zanzibar South', 'Zanzibar Urban West', 'Zanzibar West', 'Zanzibar', 'Pemba',
].map((region) => region.toLowerCase()));

/**
 * Tanzania Posts Corporation's tracker looks items up by their UPU S10 code,
 * which needs a valid check digit.
 */
export function normalizeTanzaniaPostsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Tanzania Posts Corporation tracks S10 item codes');
}

/** Whether a page is one of CodeIgniter's error pages or the site's page for a missing route. */
export function isTanzaniaPostsErrorPage(text: string): boolean {
  return ERROR_PAGE.test(text.slice(0, 64_000));
}

/** A reply without what the tracker's has: a block page, an error page, else a changed reply. */
function unexpected(text: string, message: string): never {
  if (BLOCKED.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Tanzania Posts Corporation answered with a block page');
  if (isTanzaniaPostsErrorPage(text)) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation’s tracker failed with its error page');
  throw new SchemaError(PROVIDER, message);
}

/** The region of an origin or destination, before its post office. */
function regionOf(place: string): string {
  return clean(PLACE.exec(place)?.[1] ?? place, 80);
}

function isRegion(place: string | undefined): boolean {
  return place !== undefined && REGIONS.has(regionOf(place).toLowerCase());
}

/** The tables whose header names every one of these columns. */
function tablesWith($: CheerioAPI, columns: readonly string[]): Cheerio<Element> {
  return $('table').filter((_, table) => {
    const header = $(table).find('th').map((_, cell) => clean($(cell).text(), 60)).get();
    return columns.every((column) => header.includes(column));
  });
}

/** A table's rows of cells, without its header row. */
function rowsOf($: CheerioAPI, table: Cheerio<Element>): Cheerio<Element>[] {
  return table.find('tr').toArray().map((row) => $(row).children('td')).filter((cells) => cells.length > 0);
}

/**
 * The hour a clock gives. The page prints a 24-hour clock and adds AM or PM;
 * an hour up to 12 reads as a 12-hour clock with its suffix, which gives the
 * same hour for every clock the 24-hour form prints.
 */
function hourOf(hour: number, suffix: string): number | null {
  if (hour > 23) return null;
  if (hour >= 13) return suffix === 'PM' ? hour : null;
  if (hour === 0) return suffix === 'AM' ? 0 : null;
  return (hour % 12) + (suffix === 'PM' ? 12 : 0);
}

/**
 * When the tracker recorded a scan, to the second. An item whose origin and
 * destination are both Tanzanian regions never left Tanzania, so its scans are
 * on Dar es Salaam's clock, which has no summer time. Any other item's scans
 * keep their wall clock.
 */
function clockOf(text: string, inTanzania: boolean): { time: string } | { local_time: string } {
  const match = CREATED.exec(text);
  if (!match) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned an invalid scan time');
  const [, weekday, day, month, year, hours, minutes, seconds, suffix] = match;
  // The weekday must fit the date; parsing in UTC checks the calendar only.
  const date = DateTime.fromFormat(`${weekday} ${day} ${month} ${year}`, 'cccc d LLLL yyyy', { locale: 'en-US', zone: 'UTC' });
  const hour = hourOf(Number(hours), suffix!);
  if (!date.isValid || date.year < 2000 || hour === null) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned an invalid scan time');
  const wall = `${date.toFormat('yyyy-MM-dd')}T${String(hour).padStart(2, '0')}:${minutes}:${seconds}`;
  const zoned = inTanzania ? zonedTime(wall, "yyyy-MM-dd'T'HH:mm:ss", ZONE) : null;
  return zoned ? { time: zoned.iso } : { local_time: wall };
}

/**
 * One scan row: its number, its wording and when it was recorded. A counter
 * scan's wording names the office, which becomes the scan's place.
 */
function scanOf(cells: Cheerio<Element>, inTanzania: boolean): CarrierEvent {
  if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned an invalid scan');
  const wording = clean(cells.eq(1).text(), 200);
  if (!wording) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned a scan without wording');
  const acceptance = ACCEPTANCE.exec(wording);
  const description = acceptance ? acceptance[1]! : wording;
  const location = acceptance ? clean(acceptance[2], 120) : '';
  const staged = tanzaniaPostsStage(description);
  return {
    ...clockOf(clean(cells.eq(2).text(), 60), inTanzania),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The result panel for one item: who sent it and who it is for, its barcode,
 * origin and destination, its kind, weight and status, who took delivery, and
 * its scans, oldest first. The barcode must be the whole requested code. The
 * sender, the addressee, their phone numbers and addresses, who took delivery,
 * their phone number and identity document, and the delivery day are never read.
 */
export function parseTanzaniaPostsPanel(html: string, rawNumber: string): CarrierResult {
  const number = normalizeTanzaniaPostsNumber(rawNumber);
  const $ = load(html);
  const cells = $('td').toArray().map((cell) => $(cell));
  const barcodes = cells.map((cell) => BARCODE.exec(clean(cell.text(), 200))?.[1]).filter((value) => value !== undefined);
  if (!barcodes.length) unexpected(html, 'Tanzania Posts Corporation returned a reply without the result panel');
  if (barcodes.length !== 1) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned several items for one code');
  if (normalizeTrackingNumber(barcodes[0]!) !== number) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation answered for a different item');

  const ends = new Map<string, string>();
  for (const cell of cells) {
    const end = END.exec(clean(cell.text(), 40))?.[1];
    if (!end) continue;
    if (ends.has(end)) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned several origins or destinations');
    ends.set(end, clean(cell.next('td').text(), 200));
  }
  const inTanzania = isRegion(ends.get('Origin')) && isRegion(ends.get('Destination'));

  const cargo = tablesWith($, ['Packages', 'Weight Kgs', 'Status']);
  const items = cargo.length === 1 ? rowsOf($, cargo) : [];
  if (items.length !== 1 || items[0]!.length !== 3) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned a reply without the item’s description');
  const status = clean(items[0]!.eq(2).text(), 80);
  const weightText = clean(items[0]!.eq(1).text(), 20);
  const weight = WEIGHT.test(weightText) ? Number(weightText) : 0;

  const history = tablesWith($, ['S/N', 'Description', 'Created at']);
  if (history.length > 1) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned several histories');
  const rows = history.length ? rowsOf($, history) : [];
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned an oversized history');
  const seen = new Set<string>();
  const events = rows.map((row) => scanOf(row, inTanzania)).filter((event) => {
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).reverse();
  if (!events.length && !status) throw new NoHistoryError(PROVIDER);

  // The item's status settles a delivered or returned item, whose history has
  // no scan for it; otherwise the newest scan with a stage sets the stage.
  const summary = status ? tanzaniaPostsStage(status) : null;
  const settled = summary && FINAL.has(summary.stage) ? summary : null;
  const scanned = events.find((event) => event.stage);
  const current: ClassifiedWording | null = settled ?? (scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : summary);
  const newest = events[0];
  const destination = ends.get('Destination');
  const country = isRegion(destination) ? 'TZ' : destination ? countryCode(regionOf(destination)) : null;
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: (settled || !newest ? status : newest.description) || null,
    last_update: newest?.time ?? null,
    ...(newest && !newest.time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(weight > 0 ? { weight_kg: weight } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}

/**
 * The lookup's reply: JSON after a few blank characters. `Success` carries the
 * result panel as HTML in `temp`; `Error` carries the notice the page shows in
 * `msg`, of which only "Barcode Not Found" is a missing item.
 */
export function parseTanzaniaPostsReply(body: string, rawNumber: string): CarrierResult {
  const number = normalizeTanzaniaPostsNumber(rawNumber);
  // Trimming also drops a byte order mark.
  const text = body.trim();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    unexpected(text, 'Tanzania Posts Corporation returned a reply that is not JSON');
  }
  if (!isRecord(payload) || typeof payload.status !== 'string') throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned an invalid reply');
  if (payload.status === 'Error') {
    const notice = clean(payload.msg, 300);
    if (NOT_FOUND.test(notice)) throw new NotFoundError(PROVIDER);
    // The notice's amount and control number are not kept.
    if (UNPAID.test(notice)) {
      throw new IndeterminateError(PROVIDER, 'Tanzania Posts Corporation does not track an item with an unpaid charge', { reason: 'tracking_withheld' });
    }
    throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation’s tracker answered with an unexpected notice');
  }
  if (payload.status !== 'Success' || typeof payload.temp !== 'string') throw new SchemaError(PROVIDER, 'Tanzania Posts Corporation returned an invalid reply');
  return parseTanzaniaPostsPanel(payload.temp, number);
}
