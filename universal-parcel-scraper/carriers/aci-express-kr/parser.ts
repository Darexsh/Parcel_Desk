import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { cjBranch } from '../cj-logistics/parser.js';
import { aciExpressKrStage } from './status.js';

export const PROVIDER = 'ACI Express';
// A delivered history is about ten kilobytes.
export const ACI_EXPRESS_KR_MAX_BYTES = 512 * 1024;
// The Korea Post registered number an e-commerce parcel travels under, thirteen
// digits, or ACI's own twelve-digit number.
const NUMBER = /^\d{12,13}$/;
const ACI_COLUMNS = 'Date|Time|Area|Detail';
// The delivering carrier's table; Korea Post's last column is the delivery's
// outcome, CJ Logistics' a remark.
const DOMESTIC_COLUMNS = /^날짜\|시간\|현재위치\|처리현황\|(?:상세설명\(배달결과\)|비고)$/;
// The heading over the delivering carrier's table, ">> 우체국 배송조회".
const DOMESTIC_HEADING = />>\s*(\S+)\s*배송조회/;
// The delivering carriers the tracker names, by their name in that heading.
const PARTNERS: Readonly<Record<string, string>> = { 우체국: 'korea-post', CJ대한통운: 'cj-logistics' };
const ACI_DATE = /^(\d{4})년\s*(\d{2})월\s*(\d{2})일$/;
const DOMESTIC_DATE = /^(\d{4})[.-](\d{2})[.-](\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
// Bot checks a CDN or firewall could put in place of the page, and the
// refusal ACI's newer tracking popup gives a visit it does not accept.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|차단되었습니다/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for ACI's tracker; anything else is not one ACI issues. */
export function normalizeAciExpressKrNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ACI Express numbers are twelve or thirteen digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A scan's wall clock, checked digit for digit: a calendar day alone when the row has no time. */
function wallClock(date: RegExpExecArray | null, time: string): string {
  if (!date) invalid('ACI Express returned an invalid scan date');
  const day = `${date[1]}-${date[2]}-${date[3]}`;
  const clock = time ? CLOCK.exec(time) : null;
  if (time && !clock) invalid('ACI Express returned an invalid scan time');
  const wall = clock ? `${day}T${clock[1]}:${clock[2]}:${clock[3] ?? '00'}` : day;
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat(clock ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd') !== wall) invalid('ACI Express returned an invalid scan time');
  return wall;
}

/** A status cell's wording: its English line where it has one, else its Korean. */
function wording(cell: Cheerio<Element>): string {
  const english = clean(cell.find('font').text(), 200);
  if (english) return english;
  return clean(cell.clone().find('font').remove().end().text(), 200);
}

function cellsOf($: CheerioAPI, row: Element): Cheerio<Element> {
  return $(row).children('td');
}

function rowsOf(table: Cheerio<Element>): Element[] {
  return table.children('tbody').children('tr').add(table.children('tr')).toArray();
}

function columnsOf($: CheerioAPI, row: Element | undefined): string {
  return row ? cellsOf($, row).map((_, cell) => clean($(cell).text(), 40)).get().join('|') : '';
}

interface Scan { key: string; event: CarrierEvent }

function scan(wall: string, description: string, location: string): Scan {
  const staged = aciExpressKrStage(description);
  return { key: JSON.stringify([wall, description, location]), event: {
    local_time: wall,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** One of ACI's own rows: its date, its time when it has one, the area and the wording. */
function aciRow($: CheerioAPI, row: Element): Scan {
  const cells = cellsOf($, row);
  if (cells.length !== 4) invalid('ACI Express returned an incomplete scan');
  const wall = wallClock(ACI_DATE.exec(clean(cells.eq(0).text(), 40)), clean(cells.eq(1).text(), 20));
  const description = wording(cells.eq(3));
  if (!description) invalid('ACI Express returned a scan without its wording');
  return scan(wall, description, clean(cells.eq(2).text(), 120));
}

/**
 * One of the delivering carrier's rows, or null for a row that names only a
 * place. Its last column, which can name the postman, is not kept, nor the
 * driver CJ's direct routes name in their branch.
 */
function domesticRow($: CheerioAPI, row: Element, partner: string | undefined): Scan | null {
  const cells = cellsOf($, row);
  if (cells.length !== 5) invalid('ACI Express returned an incomplete delivery scan');
  const wall = wallClock(DOMESTIC_DATE.exec(clean(cells.eq(0).text(), 40)), clean(cells.eq(1).text(), 20));
  const description = wording(cells.eq(3));
  if (!description) return null;
  const place = clean(cells.eq(2).text(), 120);
  return scan(wall, description, partner === 'cj-logistics' ? cjBranch(place) : place);
}

/**
 * The page `www.acieshop.com/pod.php?OrderNo={number}` answers. A shipment has
 * the number over a table of ACI's own milestones, oldest first, then the
 * delivering carrier's table under a heading that names it, oldest first. A
 * number the tracker does not know gets the same page with no number and no
 * scans. The recipient's masked name and the line under a delivery naming who
 * took the parcel are not kept.
 */
export function parseAciExpressKr(html: string, raw: string): CarrierResult {
  const number = normalizeAciExpressKrNumber(raw);
  const $ = load(html);
  const tables = $('table.htmltable');
  const header = tables.filter((_, table) => rowsOf($(table)).some((row) => clean(cellsOf($, row).first().text(), 40) === 'Tracking Number'));
  if (header.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ACI Express refused the lookup');
    invalid('ACI Express returned a page without its results');
  }
  const numberRow = rowsOf(header).find((row) => clean(cellsOf($, row).first().text(), 40) === 'Tracking Number')!;
  const shown = normalizeTrackingNumber(clean(cellsOf($, numberRow).eq(1).text(), 64));
  const aci = tables.filter((_, table) => columnsOf($, rowsOf($(table))[0]) === ACI_COLUMNS);
  const domestic = tables.filter((_, table) => DOMESTIC_COLUMNS.test(columnsOf($, rowsOf($(table))[0])));
  // A table whose columns changed would otherwise drop its scans without a word.
  if (tables.length !== 1 + aci.length + domestic.length) invalid('ACI Express returned a table the adapter does not know');
  if (!shown) {
    if (aci.length || domestic.length) invalid('ACI Express returned scans without their number');
    throw new NotFoundError(PROVIDER);
  }
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'ACI Express answered for another number');
  if (aci.length > 1 || domestic.length > 1) invalid('ACI Express returned more than one history');

  const heading = DOMESTIC_HEADING.exec(domestic.parent().contents().filter((_, node) => node.nodeType === 3).text());
  const partner = heading ? PARTNERS[heading[1]!] : undefined;
  const aciRows = aci.length ? rowsOf(aci).slice(1) : [];
  // Korea Post's table ends with a line naming who took the parcel, even before a delivery.
  const domesticRows = domestic.length ? rowsOf(domestic).slice(1).filter((row) => cellsOf($, row).length !== 1) : [];
  if (aciRows.length + domesticRows.length > MAX_ROWS) invalid('ACI Express returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of [...aciRows.map((row) => aciRow($, row)), ...domesticRows.map((row) => domesticRow($, row, partner))]) {
    if (!row || seen.has(row.key)) continue;
    seen.add(row.key);
    scans.push(row);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The page lists the journey in order, and its clocks are each site's own,
  // so the newest scan is the last row rather than the latest clock.
  const events = scans.map((row) => row.event).reverse();

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The delivering carrier carries the parcel on under this number when its
  // rules offer it: Korea Post's do for the thirteen-digit registered numbers.
  const handoff = partner && (detectCarrierMatch(number).candidates as string[]).includes(partner)
    ? { delivery_carrier: partner, delivery_tracking_number: number } : {};
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...handoff,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
