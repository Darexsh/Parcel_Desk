import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { skynetSaStage } from './status.js';

export const PROVIDER = 'SkyNet South Africa';
// Waybills are letters and digits, such as twelve digits or a letter and twelve digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,20}$/;
const ANSWER = /^(\S+) (NOT FOUND|DETAILS:)$/;
const WAYBILL = /^WAYBILL NUMBER:\s*(\S+)$/i;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
const HEADINGS = 'DATE|TIME|DESCRIPTION|BRANCH';
// The branch the tracker files its own system's records under, such as a proof of delivery scanned in.
const SYSTEM = /^hostserver$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill number for SkyTrack, in upper case; anything else is not one SkyNet issues. */
export function normalizeSkynetSaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SkyNet South Africa waybills are six to twenty letters and digits');
  return number;
}

/**
 * The paragraph that answers the lookup: the number asked, then `NOT FOUND`,
 * or `DETAILS:` over the waybills found. An answer for another lookup is not
 * this number's.
 */
function answer($: CheerioAPI, number: string): { kind: 'not_found' | 'shipment'; heading: Cheerio<Element> } | null {
  for (const element of $('p').get()) {
    const match = ANSWER.exec(clean($(element).text(), 200));
    if (!match) continue;
    if (match[1] !== number) throw new IndeterminateError(PROVIDER, 'SkyNet South Africa answered for another lookup');
    return { kind: match[2] === 'NOT FOUND' ? 'not_found' : 'shipment', heading: $(element) };
  }
  return null;
}

/** Whether the page rendered so far answers the lookup, and how. */
export function skynetSaPageState(html: string, number: string): 'not_found' | 'shipment' | 'pending' {
  return answer(load(html), number)?.kind ?? 'pending';
}

/**
 * The waybills under the answer's heading, in order: each paragraph naming a
 * waybill, then its references and the table of its scans.
 */
function waybills($: CheerioAPI, heading: Cheerio<Element>): { number: string; tables: Element[] }[] {
  const found: { number: string; tables: Element[] }[] = [];
  for (const child of heading.parent().children().get()) {
    const named = child.tagName === 'p' ? WAYBILL.exec(clean($(child).text(), 200)) : null;
    if (named) {
      found.push({ number: named[1]!.toUpperCase(), tables: [] });
      continue;
    }
    const tables = child.tagName === 'table' ? [child] : $(child).find('table').get();
    if (!tables.length) continue;
    if (!found.length) throw new SchemaError(PROVIDER, 'SkyNet South Africa returned scans without their waybill');
    found.at(-1)!.tables.push(...tables);
  }
  return found;
}

/** A scan's wall clock, from the table's `dd/MM/yyyy` day and `HH:mm:ss` time. The page names no zone. */
function wallClock(date: string, time: string): string {
  const day = DATE.exec(date);
  const local = day && CLOCK.test(time) ? `${day[3]}-${day[2]}-${day[1]}T${time}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!local || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'SkyNet South Africa returned an invalid scan time');
  }
  return local;
}

type Scan = CarrierEvent & { local_time: string; description: string };

/** One waybill's scans, newest first, each kept once. */
function scans($: CheerioAPI, tables: readonly Element[]): Scan[] {
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'SkyNet South Africa returned more than one history for a waybill');
  const [only] = tables;
  if (!only) return [];
  const table = $(only);
  if (table.find('thead th').map((_, th) => clean($(th).text(), 40).toUpperCase()).get().join('|') !== HEADINGS) {
    throw new SchemaError(PROVIDER, 'SkyNet South Africa returned a changed history');
  }
  const rows = table.find('tbody > tr').get();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SkyNet South Africa returned an oversized history');
  const seen = new Set<string>();
  const events: Scan[] = [];
  for (const row of rows) {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'SkyNet South Africa returned a changed history row');
    const [date, time, description, branch] = [0, 1, 2, 3].map((index) => clean(cells.eq(index).text(), 200)) as [string, string, string, string];
    if (!description) throw new SchemaError(PROVIDER, 'SkyNet South Africa returned a scan without wording');
    const local = wallClock(date, time);
    const location = SYSTEM.test(branch) ? '' : branch;
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = skynetSaStage(description);
    events.push({ local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // Newest first, as the page lists them; scans of one second keep its order.
  if (listsNewestFirst(events) === false) events.reverse();
  return events.sort((left, right) => right.local_time.localeCompare(left.local_time));
}

/**
 * The page SkyTrack renders for one number, as HTML. The tracker looks the
 * number up as a waybill and as a sender's reference, and lists every waybill
 * it finds under the number, each with its references and its scans, newest
 * first. Only the waybill named by the number is read; the references are not.
 */
export function parseSkynetSa(html: string, raw: string): CarrierResult {
  const number = normalizeSkynetSaNumber(raw);
  const $ = load(html);
  const found = answer($, number);
  if (found?.kind === 'not_found') throw new NotFoundError(PROVIDER);
  if (!found) throw new SchemaError(PROVIDER, 'SkyNet South Africa returned a page without an answer');
  const listed = waybills($, found.heading);
  if (!listed.length) throw new SchemaError(PROVIDER, 'SkyNet South Africa returned details without a waybill');
  // Another shipment whose reference is the number is not this waybill.
  const histories = listed.filter((waybill) => waybill.number === number).map((waybill) => scans($, waybill.tables));
  if (!histories.length) throw new IndeterminateError(PROVIDER, 'SkyNet South Africa found the number only as another shipment\'s reference');
  if (histories.some((history) => JSON.stringify(history) !== JSON.stringify(histories[0]))) {
    throw new IndeterminateError(PROVIDER, 'SkyNet South Africa listed the waybill twice with different scans');
  }
  const events = histories[0]!;
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  // Records filed after a scan, such as a proof of delivery scanned in, do not replace its status.
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: (current ?? newest).description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
