import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { tcatStage } from './status.js';

export const PROVIDER = 'T-CAT';
// The page with a long history is under fifty kilobytes.
export const TCAT_MAX_BYTES = 512 * 1024;
// The number at the top right of the waybill: ten digits, twelve on newer waybills.
const NUMBER = /^(?:\d{10}|\d{12})$/;
const CLOCK = /^(\d{4})\/(\d{2})\/(\d{2})\s*(\d{2}):(\d{2})$/;
const ZONE = 'Asia/Taipei';
// Bot checks and firewall refusals a CDN or the site's NetScaler could put in place of the page.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A T-CAT waybill number; anything else is not one it issues. */
export function normalizeTcatNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'T-CAT numbers are ten or twelve digits');
  return number;
}

/**
 * A scan's clock: the day and minute the driver entered it. T-CAT delivers
 * only within Taiwan, whose one zone keeps no daylight saving, so the clock
 * is read in Taipei time.
 */
function scanTime(text: string): { time: string; at: number } {
  const parts = CLOCK.exec(text);
  const wall = parts ? `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}` : '';
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parts || !zoned.isValid || zoned.toFormat("yyyy-MM-dd'T'HH:mm") !== wall) throw new SchemaError(PROVIDER, 'T-CAT returned an invalid scan time');
  return { time: zoned.toISO({ suppressMilliseconds: true }), at: zoned.toMillis() };
}

interface Row { event: CarrierEvent; at: number }

/** One row's cells: the label, the clock and the branch or centre in charge. */
function readRow(cells: Cheerio<Element>): Row {
  const cell = (index: number) => {
    const node = cells.eq(index).clone();
    node.find('br').replaceWith(' ');
    return clean(node.text(), 200);
  };
  const description = cell(0);
  if (!description) throw new SchemaError(PROVIDER, 'T-CAT returned a scan without its label');
  const { time, at } = scanTime(cell(1));
  const location = cell(2);
  const staged = tcatStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at };
}

/**
 * The parcels the page's hidden status table lists: a parcel's first row
 * starts with its number over all its rows, and each row has the label, the
 * clock and the branch, newest first, as the page's script lays them out.
 */
function readTable($: CheerioAPI): Map<string, Row[]> {
  const rows = $('#resultTable tr').not('.top');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'T-CAT returned an oversized history');
  const parcels = new Map<string, Row[]>();
  let current: Row[] | undefined;
  rows.each((_, element) => {
    const cells = $(element).children('td');
    if (cells.length === 4) {
      const number = clean(cells.first().text(), 64);
      if (!number || parcels.has(number)) throw new SchemaError(PROVIDER, 'T-CAT returned a parcel without its number');
      current = [];
      parcels.set(number, current);
      current.push(readRow(cells.slice(1)));
    } else if (cells.length === 3 && current) {
      current.push(readRow(cells));
    } else {
      throw new SchemaError(PROVIDER, 'T-CAT returned an invalid scan row');
    }
  });
  return parcels;
}

/**
 * The TraceDetail page for one number. The server writes the parcel's scans
 * into a hidden table, which the page's script lays out. A number without
 * scans gets the page's own notice that the database has no status for it,
 * with the number echoed. A history must name the number asked.
 */
export function parseTcat(html: string, raw: string): CarrierResult {
  const number = normalizeTcatNumber(raw);
  const $ = load(html);
  const notFound = $('#ContentPlaceHolder1_divNotFound');
  const table = $('#resultTable');
  if (!notFound.length && table.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'T-CAT answered with a browser check');
    throw new SchemaError(PROVIDER, 'T-CAT returned a page without its status table');
  }
  const parcels = readTable($);
  if (notFound.length) {
    if (parcels.size) throw new SchemaError(PROVIDER, 'T-CAT returned scans beside its notice of a missing parcel');
    const echoed = normalizeTrackingNumber(clean(notFound.find('.inquire-number').text(), 64));
    if (echoed !== number) throw new IndeterminateError(PROVIDER, 'T-CAT answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (!parcels.size) throw new SchemaError(PROVIDER, 'T-CAT returned an empty status table');
  const rows = parcels.get(number);
  if (!rows || parcels.size > 1) throw new IndeterminateError(PROVIDER, 'T-CAT answered for another shipment');

  // Newest first, as the page lists them; rows the page lists twice are kept once.
  const seen = new Set<string>();
  if (listsNewestFirst(rows.map(({ event }) => event)) === false) rows.reverse();
  const events = rows.sort((a, b) => b.at - a.at)
    .filter(({ event }) => {
      const identity = JSON.stringify([event.time, event.description, event.location]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  // Once a cash-on-delivery parcel heads back, the scans after it, a delivery
  // included, carry it to the sender.
  const returning = events.some((event) => event.stage === 'returned') && staged?.stage !== 'exception';
  const stage = (returning ? 'returned' : staged?.stage) as Stage | undefined;
  const source = returning && staged?.stage !== 'returned' ? 'carrier_map' : staged?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
