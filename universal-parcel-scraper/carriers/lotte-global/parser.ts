import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { lotteMappedStage, lotteStage } from './status.js';

export const PROVIDER = 'Lotte Global Logistics';
// The page is about sixty kilobytes, most of it menus.
export const LOTTE_MAX_BYTES = 512 * 1024;
// Every scan is at a branch, terminal or delivery centre in Korea, which keeps one offset all year.
const ZONE = 'Asia/Seoul';
const SUMMARY = '운송장 번호|발송지|도착지|배달결과';
const HISTORY = '단계|시간|현재위치|처리현황';
// The line both tables show for a waybill without scans.
const NO_SCANS = '보내시는 고객님께서 상품 발송 준비중입니다.';
// The summary's branches for a waybill the tracker does not know.
const UNKNOWN_BRANCH = '***';
// The place the row recording the recipient taking the parcel names: the customer, not a place.
const CUSTOMER = '고객';
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}|--:--)$/;
// The courier's delivery window on the out-for-delivery scan, as "12~14시".
const WINDOW = /(\d{1,2})\s*~\s*(\d{1,2})\s*시에 배달 예정/;
// The page the site shows while it is down for maintenance.
const MAINTENANCE = /점검\s*중|Under Construction/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * A Lotte waybill: twelve digits whose last is the rest of the first eleven
 * divided by seven, the check the tracker's own form makes before it looks one
 * up. Anything else is not a number Lotte issues.
 */
export function normalizeLotteNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{12}$/.test(number) || !hasMod7CheckDigit(number)) {
    throw new InvalidInputError(PROVIDER, 'Lotte waybills are twelve digits ending in the rest of the first eleven divided by seven');
  }
  return number;
}

// A parenthesis naming who is in charge, as "(배송담당: 이름 010-0000-0000)".
const IN_CHARGE = /\s*\([^()]*담당[^()]*\)/g;
// Korean phone numbers, mobile and landline.
const PHONE = /(?<!\d)0\d{1,2}[\s.)-]{0,2}\d{3,4}[\s.-]?\d{4}(?!\d)/g;

/** A scan's own line without the courier's name and phone. */
export function lotteWording(text: string): string {
  return clean(text.replace(IN_CHARGE, '').replace(PHONE, '')).replace(/\s+([.,])/g, '$1');
}

function table($: CheerioAPI, header: string): Cheerio<Element> {
  return $('table').filter((_, element) => $(element).children('thead').find('th')
    .map((__, cell) => clean($(cell).text())).get().join('|') === header);
}

/** A row's clock: a Seoul wall clock to the minute, or its day alone where the tracker hides the time. */
function scanClock(raw: string): Pick<CarrierEvent, 'time'> & { local_time: string } {
  const match = CLOCK.exec(raw);
  if (match?.[2] === '--:--') {
    const day = DateTime.fromISO(match[1]!, { zone: 'UTC' });
    if (day.isValid && day.toISODate() === match[1]) return { local_time: match[1] };
  } else if (match) {
    const wall = firstOccurrence(DateTime.fromFormat(raw, 'yyyy-MM-dd HH:mm', { zone: ZONE }));
    if (wall.isValid && wall.toFormat('yyyy-MM-dd HH:mm') === raw) {
      return { time: wall.toUTC().toISO({ suppressMilliseconds: true }), local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
    }
  }
  throw new SchemaError(PROVIDER, 'Lotte returned an invalid scan time');
}

function projectRow($: CheerioAPI, row: Element): CarrierEvent {
  const cells = $(row).children('td');
  if (cells.length !== 4 || cells.filter('[colspan], [rowspan]').length) throw new SchemaError(PROVIDER, 'Lotte returned an invalid scan row');
  const step = clean(cells.eq(0).text(), 40);
  const clock = scanClock(clean(cells.eq(1).text(), 40));
  const place = clean(cells.eq(2).text(), 120);
  cells.eq(3).find('br').replaceWith(' ');
  const description = lotteWording(cells.eq(3).text()) || step;
  if (!description) throw new SchemaError(PROVIDER, 'Lotte returned a scan without wording');
  const staged = lotteStage(step, description);
  return {
    ...clock,
    ...(place && place !== CUSTOMER ? { location: place } : {}),
    description,
    ...(step ? { provider_code: step } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The tracker hides a scan's time on some rows and lists the same scan again
 * with it. A row without a time goes when a timed row of the same day has the
 * same step, place and wording.
 */
function withoutHiddenTwins(events: CarrierEvent[]): CarrierEvent[] {
  const timed = new Set(events.filter((event) => event.time)
    .map((event) => JSON.stringify([String(event.local_time).slice(0, 10), event.provider_code, event.description, event.location])));
  return events.filter((event) => event.time
    || !timed.has(JSON.stringify([event.local_time, event.provider_code, event.description, event.location])));
}

/** The window the out-for-delivery scan gives, on its own day, while that scan is the latest word. */
function deliveryWindow(event: CarrierEvent): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> | null {
  const match = WINDOW.exec(event.description ?? '');
  if (!match || !event.time) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from >= to || to > 24) return null;
  const day = firstOccurrence(DateTime.fromISO(String(event.local_time).slice(0, 10), { zone: ZONE }));
  const start = day.plus({ hours: from });
  const end = day.plus({ hours: to });
  if (!day.isValid || end.toMillis() <= Date.parse(event.time)) return null;
  return { expected_delivery_from: start.toUTC().toISO({ suppressMilliseconds: true }), expected_delivery: end.toUTC().toISO({ suppressMilliseconds: true }) };
}

/**
 * The tracker's result page (`linkView`) for one waybill: a summary that
 * echoes the waybill with its pickup and delivery branches, and its scans,
 * newest first. A waybill the tracker does not know comes back with `***` for
 * both branches and no scans; one it knows without scans has its summary word
 * instead, such as 미출고 for a label not handed over yet.
 */
export function parseLotte(html: string, raw: string): CarrierResult {
  const number = normalizeLotteNumber(raw);
  const $ = load(html);
  $('script, style, noscript').remove();
  const summary = table($, SUMMARY);
  const history = table($, HISTORY);
  if (summary.length !== 1 || history.length !== 1) {
    if (MAINTENANCE.test(clean($('title').text())) || MAINTENANCE.test(clean($('body').text()).slice(0, 2000))) throw new MaintenanceError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Lotte returned a page without its tracking tables');
  }
  const summaryRows = summary.children('tbody').children('tr');
  const cells = summaryRows.children('td');
  // The tracker answers a number failing its check digit with the no-scan line
  // in place of the summary; a number that passes always gets its summary.
  if (summaryRows.length !== 1 || cells.length !== 4) throw new SchemaError(PROVIDER, 'Lotte returned a summary without the waybill');
  if (clean(cells.eq(0).text(), 40) !== number) throw new IndeterminateError(PROVIDER, 'Lotte answered for another waybill');
  const pickup = clean(cells.eq(1).text(), 80);
  const delivery = clean(cells.eq(2).text(), 80);
  const result = clean(cells.eq(3).text(), 40);

  const rows = history.children('tbody').children('tr');
  if (rows.length === 1 && rows.children('td').length === 1 && clean(rows.text()) === NO_SCANS) {
    if (pickup === UNKNOWN_BRANCH && delivery === UNKNOWN_BRANCH && !result) throw new NotFoundError(PROVIDER);
    if (!result) throw new NoHistoryError(PROVIDER);
    // A waybill known without scans: the summary word is all there is.
    const stage = lotteMappedStage(result);
    return {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
      last_status_text: result, provider_code: result, summary_only: true, last_update: null, expected_delivery: null, events: [],
    };
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Lotte returned an oversized history');

  const seen = new Set<string>();
  const projected: CarrierEvent[] = [];
  for (const row of rows.toArray()) {
    const event = projectRow($, row);
    const key = JSON.stringify([event.local_time, event.provider_code, event.description, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push(event);
  }
  const events = withoutHiddenTwins(projected);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  if (String(events[0]!.local_time) < String(events.at(-1)!.local_time)) events.reverse();

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered' && event.time) : undefined;
  const window = stage === 'out_for_delivery' && decider === newest ? deliveryWindow(newest) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time,
    expected_delivery: window?.expected_delivery ?? null,
    ...(window ? { expected_delivery_from: window.expected_delivery_from } : {}),
    ...(delivered ? { delivered_at: delivered.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
