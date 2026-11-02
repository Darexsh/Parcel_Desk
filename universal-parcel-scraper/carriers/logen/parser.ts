import { load, type Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { logenStage } from './status.js';

export const PROVIDER = 'Logen';
// A long history is a page of about 40 kilobytes.
export const LOGEN_MAX_BYTES = 1024 * 1024;
const ZONE = 'Asia/Seoul';
const CLOCK = 'yyyy.MM.dd HH:mm';
const NUMBER = /^\d{11}$/;
// Date, site, status, details, staff, receiver, office and phone.
const COLUMNS = '날짜|사업장|배송상태|배송내용|담당직원|인수자|영업소|연락처';
// The page's own answer for a number it has no parcel for: "the delivery data cannot be found".
const MISSING = '배송자료를 조회할 수 없습니다';
// The alert the page shows instead of a lookup for a number that is not ten or eleven digits.
const REFUSED = /alert\(\s*'잘못된 접근입니다/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;
// The delivery window an out-for-delivery scan gives, as "16시~18시".
const WINDOW = /^(\d{1,2})시\s*~\s*(\d{1,2})시$/;
// A run of nine or more digits, with hyphens, dots, spaces or brackets between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * A Logen waybill: eleven digits, the last the first ten modulo 7, with the
 * hyphens it is printed with removed. Anything else is not a number Logen issues.
 */
export function normalizeLogenNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || !hasMod7CheckDigit(number)) {
    throw new InvalidInputError(PROVIDER, 'Logen waybills are eleven digits, the last the first ten modulo 7');
  }
  return number;
}

/** A scan's line without phone numbers, or its status label when the line is empty. */
export function logenWording(label: string, line: string): string {
  return clean(line.replace(PHONE, ' '), 300) || label;
}

/** A cell's own text, without what its child elements add. */
function ownText(cell: Cheerio<Element>, maxLength: number): string {
  return clean(cell.clone().children().remove().end().text(), maxLength);
}

/** A scan's clock: every scan is at a Logen branch or hub in Korea, which keeps UTC+9 all year. */
function scanClock(text: string): DateTime {
  const wall = firstOccurrence(DateTime.fromFormat(text, CLOCK, { zone: ZONE }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!wall.isValid || wall.toFormat(CLOCK) !== text) throw new SchemaError(PROVIDER, 'Logen returned an invalid scan time');
  return wall;
}

function instant(time: DateTime): string {
  return time.toUTC().toISO({ suppressMilliseconds: true })!;
}

/** The window an out-for-delivery scan gives, on the scan's day. */
function deliveryWindow(scanned: DateTime, text: string): { from: string; to: string } | null {
  const match = WINDOW.exec(text);
  const from = Number(match?.[1]);
  const to = Number(match?.[2]);
  if (!match || from >= to || to > 24) return null;
  const day = scanned.startOf('day');
  return { from: instant(day.plus({ hours: from })), to: instant(day.plus({ hours: to })) };
}

interface Scan { event: CarrierEvent; window: { from: string; to: string } | null }

/**
 * The page `www.ilogen.com/web/personal/trace/{number}` answers. A parcel's
 * details must name the number asked; its history table lists the scans
 * oldest first. The staff, receiver, office and phone columns are not read,
 * except the out-for-delivery scan's window, which the receiver column holds.
 */
export function parseLogen(html: string, raw: string): CarrierResult {
  const number = normalizeLogenNumber(raw);
  const $ = load(html);
  const details = $('table.pdInfo');
  if (details.length !== 1) {
    if (REFUSED.test(html)) throw new InvalidInputError(PROVIDER, 'Logen refused the number');
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Logen answered with a browser check');
    throw new SchemaError(PROVIDER, 'Logen returned a page without parcel details');
  }
  const history = $('table.tkInfo');
  const empty = details.find('tr.empty');
  if (empty.length) {
    if (history.length || !clean(empty.text()).includes(MISSING)) throw new SchemaError(PROVIDER, 'Logen returned an unexpected empty answer');
    throw new NotFoundError(PROVIDER);
  }
  const labels = details.find('td.tit').filter((_, cell) => clean($(cell).text()) === '송장번호');
  const echoed = labels.length === 1 ? normalizeTrackingNumber(clean(labels.next('td').text(), 32)) : '';
  if (!echoed) throw new SchemaError(PROVIDER, 'Logen returned parcel details without the waybill');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'Logen answered for another parcel');

  const columns = history.children('thead').find('th').map((_, cell) => clean($(cell).text())).get().join('|');
  if (history.length !== 1 || columns !== COLUMNS) throw new SchemaError(PROVIDER, 'Logen returned an unexpected history table');
  // The page marks a table's placeholder row with `empty`.
  const rows = history.children('tbody').children('tr').not('.empty');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Logen returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 8) throw new SchemaError(PROVIDER, 'Logen returned an incomplete scan');
    const wall = scanClock(clean(cells.eq(0).text(), 32));
    // A delivery with a photo can add a link to its label.
    const label = ownText(cells.eq(2), 40).replace(/\s*사진확인$/, '');
    const description = logenWording(label, cells.eq(3).text());
    if (!description) throw new SchemaError(PROVIDER, 'Logen returned a scan without wording');
    const location = clean(cells.eq(1).text(), 120);
    const time = instant(wall);
    const key = JSON.stringify([time, label, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = logenStage(label, description);
    scans.push({
      event: {
        time,
        ...(location ? { location } : {}),
        description,
        ...(label ? { provider_code: label } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      },
      window: staged?.stage === 'out_for_delivery' ? deliveryWindow(wall, clean(cells.eq(5).text(), 40)) : null,
    });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the page lists the scans oldest first.
  const newestFirst = scans[0]!.event.time! <= scans.at(-1)!.event.time! ? scans.reverse() : scans;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((scan) => scan.event.stage)?.event;
  const stage = scanned?.stage as Stage | undefined;
  // The window holds while the out-for-delivery scan is the newest.
  const window = stage === 'out_for_delivery' && scanned === newest.event ? newest.window : null;
  const events = newestFirst.map((scan) => scan.event);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.event.description!,
    last_update: newest.event.time!,
    expected_delivery: window?.to ?? null,
    ...(window ? { expected_delivery_from: window.from } : {}),
    ...(stage === 'delivered' ? { delivered_at: scanned!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
