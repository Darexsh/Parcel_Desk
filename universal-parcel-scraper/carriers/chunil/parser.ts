import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { chunilStage } from './status.js';

export const PROVIDER = 'Chunil Express';
// A parcel's page is about 20 kilobytes.
export const CHUNIL_MAX_BYTES = 512 * 1024;
const NUMBER = /^\d{11}$/;
// Date, branch, phone and status.
const COLUMNS = '날짜|영업소|전화번호|상태';
// The heading above a parcel: "below is the result of looking up waybill number {number}".
const RESULT_FOR = '조회한 결과입니다';
// The page's own answer for a number it has no parcel for: "there is no result".
const MISSING = '결과가 없습니다.';
// The delivery result's label in the parcel's details.
const OUTCOME = '배송/출고결과:';
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;
// A run of nine or more digits, with hyphens, dots, spaces or brackets between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Chunil Express waybill: eleven digits, as its tracking form asks for them. */
export function normalizeChunilNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Chunil Express waybills are eleven digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A scan's day, as the page writes it; the history gives no time of day. */
function scanDay(text: string): string {
  const match = DAY.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  return day ?? invalid('Chunil Express returned an invalid scan date');
}

/** The value beside a label in one of the parcel's detail tables, by the label without its spaces. */
function detail($: CheerioAPI, label: string): string {
  const values = $('table.table02 tr').filter((_, row) => clean($(row).children('td').first().text()).replace(/\s/g, '') === label)
    .map((_, row) => clean($(row).children('td').eq(1).text(), 80)).get();
  if (values.length > 1) invalid('Chunil Express returned repeated parcel details');
  return values[0] ?? '';
}

/**
 * The page `www.chunil.co.kr/HTrace/HTrace.jsp?transNo={number}` answers. The
 * search field keeps the number asked; a parcel's details are headed by it,
 * and its route table lists the scans oldest first, each with its day,
 * branch, the branch's phone number and status. The sender, the recipient and
 * the signer (masked names), the goods, the parcel count and the branches'
 * phone numbers are not read.
 */
export function parseChunil(html: string, raw: string): CarrierResult {
  const number = normalizeChunilNumber(raw);
  const $ = load(html);
  const field = $('input#transNo');
  if (field.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Chunil Express answered with a browser check');
    invalid('Chunil Express returned a page without its search field');
  }
  // The page trims the number it was sent and keeps it in its search field.
  const asked = clean(field.attr('value'), 32);
  const history = $('table#tracking');
  const missing = $('td').filter((_, cell) => clean($(cell).text()) === MISSING);
  if (missing.length) {
    if (history.length || missing.length > 1) invalid('Chunil Express returned an unexpected empty answer');
    if (asked !== number) throw new IndeterminateError(PROVIDER, 'Chunil Express answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  const heading = $('b').filter((_, bold) => clean($(bold).closest('td').text()).includes(RESULT_FOR))
    .map((_, bold) => clean($(bold).text(), 32)).get();
  if (heading.length !== 1 || history.length !== 1) invalid('Chunil Express returned a page without a parcel');
  if (heading[0] !== number || asked !== number) throw new IndeterminateError(PROVIDER, 'Chunil Express answered for another parcel');

  const rows = history.find('tr').toArray();
  const columns = $(rows[0]).children('td').map((_, cell) => clean($(cell).text())).get().join('|');
  if (columns !== COLUMNS) invalid('Chunil Express returned an unexpected route table');
  if (rows.length > MAX_ROWS) invalid('Chunil Express returned an oversized history');

  const seen = new Set<string>();
  const listed: CarrierEvent[] = [];
  for (const row of rows.slice(1)) {
    const cells = $(row).children('td');
    if (cells.length !== 4) invalid('Chunil Express returned an incomplete scan');
    const local_time = scanDay(clean(cells.eq(0).text(), 16));
    // The branch; its phone number, in the next column, is not read.
    const location = clean(cells.eq(1).text().replace(PHONE, ' ').replace(/\(\s*\)/g, ' '), 80);
    const description = clean(cells.eq(3).text(), 80);
    if (!description) invalid('Chunil Express returned a scan without its status');
    const key = JSON.stringify([local_time, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = chunilStage(description);
    listed.push({
      local_time,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  // Newest first, in the page's order: scans of one day cannot be told apart by their clocks.
  const events = listed.reverse();
  const outcome = detail($, OUTCOME);
  if (!events.length && !outcome) throw new NoHistoryError(PROVIDER);

  // A delivery, in the route or as the delivery result, settles the parcel. Otherwise the newest
  // staged scan says where it is, and the delivery result stands in for a route without one.
  const result = outcome ? chunilStage(outcome) : null;
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = events.find((event) => event.stage);
  const decided: ClassifiedWording | null = delivery ? { stage: 'delivered', source: delivery.stage_source! }
    : result?.stage === 'delivered' ? result
      : staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : result;
  const newest = events[0];
  const fromOutcome = decided === result && result !== null && !delivery;
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: fromOutcome ? outcome : newest?.description ?? outcome,
    last_update: null,
    ...(newest && !fromOutcome ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
