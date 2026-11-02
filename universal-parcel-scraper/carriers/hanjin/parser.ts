import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { hanjinKey, hanjinStage } from './status.js';

export const PROVIDER = 'Hanjin';
// The page is about 120 kB of site around a few kilobytes of tracking.
export const HANJIN_MAX_BYTES = 1_000_000;
export const HANJIN_ORIGIN = 'https://www.hanjin.com';

// The tracker's own form takes twelve or fourteen digits.
const NUMBER = /^(?:\d{12}|\d{14})$/;
const DATE = /^(\d{4}-\d{2}-\d{2})(\*?)$/;
const CLOCK = /^(\d{2}:\d{2})(\*?)$/;
const ZONE = 'Asia/Seoul';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)|_cf_chl_opt|cf-turnstile|The requested URL was rejected/i;
// "The waybill is not registered, or the sender is still preparing the parcel."
const NOT_FOUND = hanjinKey('운송장이 등록되지 않았거나 보내는 분(업체)이 상품을 준비 중 입니다.');
// The notice page's only script: an alert, then a post back to the search form.
const NOTICE = /function\s+submitEvent\s*\(\s*\)\s*\{\s*alert\(\s*"([^"]{1,200})"\s*\)/;
const SCAN_HEADER = ['날짜', '시간', '상품위치', '배송 진행상황'];
// The basic table of a domestic waybill. An international one has its own columns.
const DOMESTIC_HEADER = ['상품명', '보내는 분', '받는 분', '운임'];
// The scans that put a parcel in Korea: the customs warehouse, unloading,
// the customs list and clearance.
const KOREA_ENTRY = /^(?:수입통관장에반입|하선신고가수리|통관목록이접수|목록통관심사가완료|수입통관이완료)/;
// A parcel waiting abroad for its flight or ship.
const DEPARTURE = /(?:항공편|선편)으로출발대기중입니다$/;
// The courier's or collector's name and phone, should they ever move into the wording.
const STAFF = /\(\s*(?:배송|집하)사원\s*:[^)]*\)/g;
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){7,}(?!\d)/g;
const MAX_ROWS = 300;

/**
 * A Hanjin waybill as its tracker takes it: twelve digits whose last is the
 * rest of the first eleven divided by seven, or fourteen digits.
 */
export function normalizeHanjinNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hanjin waybills are twelve or fourteen digits');
  if (number.length === 12 && !hasMod7CheckDigit(number)) throw new InvalidInputError(PROVIDER, 'The Hanjin waybill check digit does not match');
  return number;
}

const texts = ($: CheerioAPI, cells: ReturnType<CheerioAPI>) => cells.map((_, cell) => clean($(cell).text(), 40)).get();

/** What a page without a waybill says: the notice for an unknown number, a block or the search form. */
function noShipment($: CheerioAPI, html: string): never {
  const notice = NOTICE.exec(html)?.[1];
  if (notice !== undefined && clean($('title').text(), 40) === 'Information') {
    if (hanjinKey(notice) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Hanjin answered with a notice about the number');
  }
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hanjin answered with a block page');
  if ($('input#wblnumText').length) throw new IndeterminateError(PROVIDER, 'Hanjin returned its search page');
  throw new SchemaError(PROVIDER, 'Hanjin did not return a tracking page');
}

interface Row {
  date: string;
  clock: string;
  // The page marks a foreign carrier's local clock with an asterisk.
  starred: boolean;
  location: string;
  description: string;
}

/** One scan row's four cells; a row the page leaves empty is skipped, as its own script does. */
function readRow($: CheerioAPI, row: ReturnType<CheerioAPI>): Row | null {
  const cells = row.children('td');
  if (!cells.length || cells.toArray().every(cell => !clean($(cell).text()))) return null;
  if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Hanjin scan layout changed');
  const date = DATE.exec(clean(cells.eq(0).text(), 40).replace(/\s+/g, ''));
  const clock = CLOCK.exec(clean(cells.eq(1).text(), 40).replace(/\s+/g, ''));
  // The status cell goes on with the courier's or collector's name and
  // phone, or a call centre's number. Read only the wording.
  const wordings = cells.eq(3).children('span.stateDesc');
  const description = wordings.length === 1
    ? clean(clean(wordings.text(), 300).replace(STAFF, '').replace(PHONE, ''), 200).replace(/\s+([.,])/g, '$1') : '';
  if (!date || !clock || !description) throw new SchemaError(PROVIDER, 'Hanjin returned a scan without a clock or wording');
  const location = clean(cells.eq(2).text(), 120);
  return { date: date[1]!, clock: clock[1]!, starred: Boolean(date[2] || clock[2]), location: location === '-' ? '' : location, description };
}

/**
 * The page the tracker renders for a waybill: the number, a summary of the
 * newest scan, the basic table (goods, sender, recipient and charge, or for an
 * international waybill its master bill, goods and duties), the progress rail
 * and the scans, oldest first. The number and the scans are read; the basic
 * table's headings and the summary only tell what kind of page it is. An
 * unknown number gets a notice page instead, or on older pages the result
 * page with the notice and no scans.
 */
export function parseHanjin(html: string, raw: string): CarrierResult {
  const number = normalizeHanjinNumber(raw);
  const $ = load(html);
  const shown = $('.songjang-num .num');
  if (!shown.length) noShipment($, html);
  const waybill = clean(shown.text(), 40);
  if (shown.length !== 1 || !/^\d{10,14}$/.test(waybill)) throw new SchemaError(PROVIDER, 'Hanjin did not name the waybill');
  if (waybill !== number) throw new IndeterminateError(PROVIDER, 'Hanjin answered for another waybill');
  const notice = hanjinKey(clean($('.delivery-time .comm-sec').text(), 200));

  const tables = $('.waybill-tbl table');
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'Hanjin tracking page changed');
  if (!tables.length) {
    if (notice === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Hanjin returned no scan table');
  }
  if (texts($, tables.children('thead').children('tr').last().children('th, td')).join('|') !== SCAN_HEADER.join('|')) {
    throw new SchemaError(PROVIDER, 'Hanjin scan layout changed');
  }
  const nodes = tables.children('tbody').children('tr');
  if (nodes.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Hanjin returned too many scans');
  const rows = nodes.toArray().map(node => readRow($, $(node))).filter((row): row is Row => row !== null);
  if (!rows.length) {
    if (notice === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new NoHistoryError(PROVIDER);
  }

  // Scans in Korea are on Korean time. Before a parcel from abroad reaches
  // Korean customs its scans are the foreign carrier's local clock, which the
  // page sometimes marks with an asterisk. A history with a foreign leg (an
  // international waybill, a marked clock or a flight) keeps every scan before
  // its first Korean customs scan as a wall clock.
  const domestic = texts($, $('table.delivery-tbl').first().children('thead').children('tr').last().children('th, td')).join('|')
    === DOMESTIC_HEADER.join('|');
  const abroad = !domestic || rows.some(row => row.starred || DEPARTURE.test(hanjinKey(row.description)));
  const entry = abroad ? rows.findIndex(row => KOREA_ENTRY.test(hanjinKey(row.description))) : 0;

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const wall = `${row.date}T${row.clock}:00`;
    // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
    const checked = DateTime.fromISO(wall, { zone: 'UTC' });
    if (!checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) throw new SchemaError(PROVIDER, 'Hanjin returned an invalid scan time');
    const korean = !row.starred && entry >= 0 && index >= entry;
    const clock = korean ? { time: firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })! } : { local_time: wall };
    const event: CarrierEvent = { ...clock, description: row.description, ...(row.location ? { location: row.location } : {}) };
    const identity = JSON.stringify([wall, korean, row.description, row.location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const stage = hanjinStage(row.description);
    if (stage) Object.assign(event, { stage: stage.stage, stage_source: stage.source });
    events.push(event);
  });
  events.reverse();

  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    ...(stage === 'delivered' && newest.time ? { delivered_at: newest.time } : {}),
    events,
  };
}
