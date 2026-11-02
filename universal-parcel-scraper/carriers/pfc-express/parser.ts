import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { pfcExpressScan, pfcExpressSummaryStage } from './status.js';

export const PROVIDER = 'PFC Express';
// One parcel's item is a few kilobytes; the tracker answers up to fifty numbers a request.
export const PFC_EXPRESS_MAX_BYTES = 512 * 1024;
// R, the customer's five- or six-digit account, the order's date as yyMMdd and a serial of one
// to four digits, padded to four before 2025.
const NUMBER = /^R\d{5,6}2\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{1,4}$/;
// A partner's number in the item's tracking-number column.
const PARTNER_NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
// "12/11/2026 16:51:46" month first, as the tracker shows scans, or "2026/9/3 14:46:00" year first,
// as its page's own sample item and the older inquiry page do.
const MONTH_FIRST = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const YEAR_FIRST = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
// The item's origin and destination, "CN/NO"; the origin can be missing.
const ROUTE = /^(?:[A-Z]{2})?\s*\/\s*([A-Z]{2})$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone
// numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Who took a delivered parcel, after the delivery's own words.
const RECEIVER = /\s*[,;:.\-–，；：]?\s*(?:(?:signed(?: for)? by|signatory|received by)\b|签收人)[\s\S]*$/i;
// A clause of a relayed Chinese post scan that gives a courier, a phone, a hotline or a complaint line.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|呼叫|快递员|投递员|揽投员|揽收员|派送员|派件员|收派员|配送员|司机|姓名|\d{5,}/;
// A bracketed office, exchange, centre or airport; any other bracket can name a person or a signer.
const OFFICE = /(?:局|部|中心|站|所|处|公司|仓|港|场|口岸|海关|网点|营业厅|厅|机场|航空|车间|市|县|自治州|国际)$/;
const HAN = /\p{Script=Han}/u;
const MAX_ITEMS = 50;
const MAX_EVENTS = 300;

/** A PFC order number, in capitals as the tracker takes it; anything else is not one PFC issues. */
export function normalizePfcExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PFC Express numbers are R, an account, the order date and a serial');
  return number;
}

/**
 * A scan's text without who signed for it, phone numbers or e-mail addresses.
 * A relayed Chinese post scan also loses the brackets that name no office and
 * every clause from the first that gives a contact.
 */
export function pfcExpressText(value: string): string {
  let text = value.replace(RECEIVER, '').replace(EMAIL, '').replace(PHONE, '');
  if (HAN.test(text)) {
    text = text.replace(/【([^【】]*)】/g, (whole, inner: string) => (OFFICE.test(inner.trim()) && !CONTACT.test(inner) ? whole : ''));
    const kept: string[] = [];
    for (const clause of text.split(/(?<=[，,。；;！!？?])/)) {
      if (CONTACT.test(clause)) break;
      kept.push(clause);
    }
    text = kept.join('');
  }
  return clean(text.replace(/\s+([,，;；.。])/g, '$1')).replace(/^[\s,，;；:：]+|[\s,，;；:：\-–]+$/g, '');
}

/** A scan's clock as an ISO wall time, in either order the tracker writes it; the day must exist. */
function wallClock(text: string): string {
  const monthFirst = MONTH_FIRST.exec(text);
  const match = monthFirst ?? YEAR_FIRST.exec(text);
  const [year, month, day] = monthFirst ? [match?.[3], match?.[1], match?.[2]] : [match?.[1], match?.[2], match?.[3]];
  const date = match ? calendarDay(Number(year), Number(month), Number(day)) : null;
  const [hour, minute, second] = [Number(match?.[4]), Number(match?.[5]), Number(match?.[6] ?? 0)];
  if (!date || hour > 23 || minute > 59 || second > 59) throw new SchemaError(PROVIDER, 'PFC Express returned an invalid scan time');
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * The scans an item lists, newest first, each a message and a clock. The
 * message is a wording, then `----` and the scan's place when it has one. A
 * scan whose text gave only contacts is left out.
 */
function scans($: CheerioAPI, $item: Cheerio<AnyNode>): CarrierEvent[] {
  const nodes = $item.find('ul > li').toArray();
  if (nodes.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'PFC Express returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const node of nodes) {
    const message = $(node).find('.wd_message');
    const clock = $(node).find('.wd_time');
    if (message.length !== 1 || clock.length !== 1) throw new SchemaError(PROVIDER, 'PFC Express returned an invalid scan');
    const time = wallClock(clean(clock.text(), 40));
    const [said = '', ...rest] = clean(message.text(), 2000).split('----');
    if (!said.trim()) throw new SchemaError(PROVIDER, 'PFC Express returned a scan without its wording');
    const text = pfcExpressText(said);
    if (!text) continue;
    const scan = pfcExpressScan(text);
    const location = clean(pfcExpressText(rest.join(' ')) || scan.facility, 120);
    const key = JSON.stringify([time, scan.wording, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      local_time: time,
      description: scan.wording,
      ...(location ? { location } : {}),
      ...(scan.stage ? { stage: scan.stage.stage, stage_source: scan.stage.source } : {}),
    });
  }
  return events;
}

/**
 * The reply to the tracker's `Index?handler=AccessRedirect&nos={numbers}`
 * lookup: a JSON string holding an HTML fragment with one `T_item` per number
 * asked. A parcel's item is classed by the tracker's tab it falls under; its
 * first row names its reference, its tracking number (the delivering
 * carrier's, after a slash when there is more than one), PFC's order number,
 * its channel, its origin and destination and its newest scan, and its list
 * holds every scan. A number the tracker does not know gets an item classed
 * `NOT` that only echoes the number and says "Not Found". Only an item naming
 * the whole number is read.
 */
export function parsePfcExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizePfcExpressNumber(raw);
  if (typeof payload !== 'string') throw new SchemaError(PROVIDER, 'PFC Express returned a reply that is not its tracking fragment');
  if (!payload.trim()) throw new IndeterminateError(PROVIDER, 'PFC Express returned an empty result');
  const $ = load(payload, null, false);
  const items = $('div.T_item').toArray();
  if (!items.length) throw new SchemaError(PROVIDER, 'PFC Express returned a fragment without its result');
  if (items.length > MAX_ITEMS) throw new SchemaError(PROVIDER, 'PFC Express returned too many results');

  const row = (item: AnyNode) => $(item).find('table.wd_Tb').first().find('tr').first().children('td');
  const numbers = (cell: AnyNode) => clean($(cell).find('div.cell_bk').text(), 200).split('/')
    .map((part) => normalizeTrackingNumber(part)).filter(Boolean);
  const mine = items.filter((item) => row(item).toArray().some((cell) => numbers(cell).includes(number)));
  if (!mine.length) throw new IndeterminateError(PROVIDER, 'PFC Express answered for another number');
  if (mine.length > 1) throw new IndeterminateError(PROVIDER, 'PFC Express returned several parcels for the number');
  const $item = $(mine[0]);
  const summary = clean($item.attr('date'), 40);
  const cells = row(mine[0]!);

  if (summary === 'NOT') {
    if (cells.length !== 2 || cells.find('div.cell_bk').length !== 1 || !/^Not Found$/i.test(clean(cells.find('.track_detail_NotFound').text(), 40))) {
      throw new SchemaError(PROVIDER, 'PFC Express returned an invalid not-found result');
    }
    throw new NotFoundError(PROVIDER);
  }

  const tab = pfcExpressSummaryStage(summary);
  if (tab === undefined) throw new SchemaError(PROVIDER, 'PFC Express returned a result of an unknown kind');
  if (cells.length !== 7 || cells.slice(0, 3).toArray().some((cell) => $(cell).find('div.cell_bk').length !== 1)) {
    throw new SchemaError(PROVIDER, 'PFC Express returned an invalid result row');
  }
  const [references, tracking, orders] = cells.slice(0, 3).toArray().map(numbers) as [string[], string[], string[]];
  const channel = clean(cells.eq(3).text(), 80);
  const route = ROUTE.exec(clean(cells.eq(4).text(), 40));
  const destination = route ? countryCode(route[1]) : null;

  const events = scans($, $item);
  // An item without scans is a parcel PFC knows but has not moved.
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // The scans are listed newest first, by clocks that can be several places', so the order stands.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // A delivery or a held parcel is the tab's call; otherwise the newest staged scan decides.
  const settled = tab === 'delivered' || tab === 'exception';
  const stage = (settled ? tab : scanned?.stage as Stage | undefined) ?? tab ?? undefined;
  const source = settled || !scanned ? 'carrier_map' : scanned.stage_source!;
  // The tracking number is the delivering carrier's, which follows the parcel at the destination.
  const partners = new Set(tracking.filter((value) => value !== number && !references.includes(value)
    && !orders.includes(value) && PARTNER_NUMBER.test(value)));
  const [partner] = partners;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(channel ? { service_name: channel } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(partners.size === 1 ? { delivery_tracking_number: partner! } : {}),
    events,
  };
}
