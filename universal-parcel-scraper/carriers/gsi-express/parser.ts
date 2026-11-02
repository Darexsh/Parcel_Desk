import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { gsiExpressStage } from './status.js';

export const PROVIDER = 'GSI Express';
// A page is about sixteen kilobytes, most of it script.
export const GSI_EXPRESS_MAX_BYTES = 512 * 1024;

// The receipt number GSI Express issues for each parcel, which its tracker calls the invoice number.
const NUMBER = /^\d{7}$/;
// The tracker's whole answer to a receipt number it has no record of.
const NOT_FOUND = '해당 데이타가 존재하지 않습니다';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
// The page's field labels, each heading one row.
const RECEIPT = 'GSI 접수번호';
const WAYBILL = '운송장번호';
const DEPARTED = '출고시간';
const FLIGHTS = 'Flight Plan Information';
const CLEARED = '통관완료일';
const DOMESTIC = '현지 국내배송상황';
// The departure is shown twice, in Korean time and thirteen hours earlier as US Eastern time.
const KOREAN_CLOCK = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\(한국시간\)/;
const CLEARED_DAY = /^(\d{4})년\s*(\d{2})월\s*(\d{2})일\s*\(한국시간\)$/;
// The domestic section's own lines: the numbered delivery waybill and its table's headings.
const DOMESTIC_LINE = /^\d+\.\s*주송장번호\s*:\s*[A-Z\d-]*$|^(?:처리일시|배송상태|처리지점)$/;
// Korea Post's domestic parcel numbers, the ones its own rule suggests.
const KOREA_POST_PARCEL = /^6\d{12}$/;

/** A GSI Express receipt number: seven digits; anything else is not one its tracker reads. */
export function normalizeGsiExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GSI Express receipt numbers are seven digits');
  return number;
}

function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GSI Express answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** The row a field label heads: the label sits in a small table of its own in the row's first cell. */
function fieldRow($: CheerioAPI, label: string): Cheerio<AnyNode> | null {
  const labels = $('td[bgcolor] > b').filter((_, element) => clean($(element).text(), 80) === label);
  if (labels.length > 1) throw new SchemaError(PROVIDER, `GSI Express returned a page with two ${label} fields`);
  const row = labels.closest('table').parent().closest('tr');
  return row.length === 1 ? row : null;
}

/** The text of the cells after a field's label. */
function fieldValue($: CheerioAPI, label: string): string | null {
  const row = fieldRow($, label);
  return row ? clean(row.children('td').slice(1).text(), 300) : null;
}

/** A wall clock checked digit for digit: parsing in UTC reads the calendar alone, and Luxon rolls 24:00 over. */
function wallClock(text: string, format: string): string {
  const parsed = DateTime.fromFormat(text, format, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat(format) !== text) throw new SchemaError(PROVIDER, 'GSI Express returned an invalid date');
  return parsed.toFormat(format.includes('H') ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
}

/**
 * The time the parcel left the warehouse in the United States, in Korean
 * time. The page derives the US Eastern clock beside it by taking thirteen
 * hours off all year, so one of the two is an hour out in winter: the clock
 * stays a wall clock.
 */
function departure(text: string): string | null {
  if (!/\d/.test(text)) return null;
  const clock = KOREAN_CLOCK.exec(text)?.[1];
  if (!clock) throw new SchemaError(PROVIDER, 'GSI Express returned a departure without its Korean time');
  return wallClock(clock, 'yyyy-MM-dd HH:mm:ss');
}

/** The day Korean customs cleared the parcel. */
function clearance(text: string): string | null {
  // The cell goes on with a button to the Korea Customs Service's lookup, which has no text.
  if (!/\d/.test(text)) return null;
  const day = CLEARED_DAY.exec(text);
  if (!day) throw new SchemaError(PROVIDER, 'GSI Express returned an invalid customs clearance date');
  return wallClock(`${day[1]}-${day[2]}-${day[3]}`, 'yyyy-MM-dd');
}

function scan(local: string, description: string): CarrierEvent {
  const staged = gsiExpressStage(description);
  return { local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/**
 * Whether the page lists flights or domestic scans the adapter does not read:
 * rows under the flight table's headings, or lines in the domestic section
 * besides its waybill and headings.
 */
function unreadRows($: CheerioAPI): boolean {
  const flights = fieldRow($, FLIGHTS)?.next('tr').find('tr').slice(1).toArray() ?? [];
  const domestic = fieldRow($, DOMESTIC)?.closest('table').closest('tr').next('tr').find('td')
    .filter((_, cell) => $(cell).find('td').length === 0).toArray() ?? [];
  return flights.some((row) => clean($(row).text(), 40) !== '')
    || domestic.some((cell) => {
      const text = clean($(cell).text(), 200);
      return text !== '' && !DOMESTIC_LINE.test(text);
    });
}

/**
 * The waybill of the domestic leg. Korea Post's domestic parcel numbers are
 * thirteen digits from 6; GSI Express's other partner in Korea, CJ Logistics,
 * and Sagawa in Japan use shorter ones. A parcel the page clears through
 * Korean customs under such a number is handed to Korea Post. Any other single
 * waybill is kept without a carrier.
 */
function handoff($: CheerioAPI, korean: boolean): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const shown = fieldValue($, WAYBILL) ?? '';
  if (!/^[A-Z\d-]+$/i.test(shown)) return {};
  const number = normalizeTrackingNumber(shown);
  if (!/^[A-Z0-9]{4,40}$/.test(number)) return {};
  return { ...(korean && KOREA_POST_PARCEL.test(number) ? { delivery_carrier: 'korea-post' } : {}), delivery_tracking_number: number };
}

/**
 * The tracker's page for one receipt number, `track_pop.php`. Each field has a
 * row of its own: the receipt number, the master air waybill, the waybill of
 * the domestic leg, the merchant's order number, the recipient, the time the
 * parcel left the US warehouse, the flight table, the customs clearance date
 * and the domestic delivery section. A receipt number the tracker has no
 * record of gets its notice that there is no data.
 */
export function parseGsiExpress(html: string, rawNumber: string): CarrierResult {
  const number = normalizeGsiExpressNumber(rawNumber);
  const $ = load(html);
  const notices = $('font').filter((_, element) => clean($(element).text(), 80) === NOT_FOUND);
  if (notices.length && !fieldRow($, RECEIPT)) throw new NotFoundError(PROVIDER);
  const receipt = fieldValue($, RECEIPT);
  if (receipt === null || !/^\d+$/.test(receipt)) unexpected(html, 'GSI Express returned a page without the receipt number');
  if (receipt !== number) throw new IndeterminateError(PROVIDER, 'GSI Express answered for another shipment');

  const departed = fieldValue($, DEPARTED);
  const cleared = fieldValue($, CLEARED);
  if (departed === null && cleared === null) throw new SchemaError(PROVIDER, 'GSI Express returned a page without its milestones');
  const left = departed === null ? null : departure(departed);
  const day = cleared === null ? null : clearance(cleared);
  // Newest first, in the order the parcel passes them; a clearance date has no hour to compare.
  const events = [...(day ? [scan(day, '통관완료')] : []), ...(left ? [scan(left, '출고')] : [])];
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    // The clearance row is Korean customs'.
    ...handoff($, cleared !== null),
    events,
    ...(unreadRows($) ? { history_truncated: true } : {}),
  };
}
