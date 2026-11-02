import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { apcOvernightStage, isApcOvernightNotice } from './status.js';

export const PROVIDER = 'APC Overnight';
// A consignment's page is about 12 kB and the search page about 17 kB.
export const APC_OVERNIGHT_MAX_BYTES = 512 * 1024;

const MAX_ITEMS = 200;
const MAX_ROWS = 2000;
// The search page's notice for a whole number the tracker does not have.
const NOT_FOUND = 'Your consignment could not be found';
// Its notice for an identifier of the wrong shape.
const INVALID = 'Consignment identifier is invalid';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;
// "At Hub (10-Oct-2026 00:31)": the wording, then the day and minute in brackets.
const ROW = /^(.+?) \((\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2})\)$/;
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?) kg$/;
// "NC16 (Next Business Day Non-Conveyable Parcel)": the service's code, then its name.
const SERVICE = /^[A-Z0-9]{1,8} \((.{1,80})\)$/;

/**
 * An APC waybill: twenty-two digits that start with the consignment's booking
 * date, as 20YYMMDD, and end with its seven-digit consignment number. The
 * tracker looks a consignment up only by the whole waybill.
 */
export function normalizeApcOvernightNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^20\d{20}$/.test(number) && DateTime.fromFormat(number.slice(0, 8), 'yyyyMMdd', { zone: 'UTC' }).isValid) return number;
  throw new InvalidInputError(PROVIDER, 'APC Overnight tracks its twenty-two-digit waybills, which start with their booking date');
}

/** "09-Oct-2026 17:58" as a wall clock. The page gives no offset. */
function wallClock(stamp: string): string | null {
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(stamp, 'dd-LLL-yyyy HH:mm', { zone: 'UTC', locale: 'en-GB' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/** The consignment summary's value next to one label, or '' without one. */
function summaryValue($: CheerioAPI, label: string): string {
  const cells = $('div.con-summary tr').filter((_, row) => clean($(row).children('th').text(), 80) === label).children('td');
  return cells.length === 1 ? clean(cells.text(), 200) : '';
}

/** The search page APC sends back for a number it has no consignment page for. */
function searchPage($: CheerioAPI, html: string, number: string): never {
  const notices = $('p.login-error');
  if (!notices.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'APC Overnight answered with a block page');
    throw new SchemaError(PROVIDER, 'APC Overnight did not return a consignment page');
  }
  const notice = notices.length === 1 ? clean(notices.text(), 200) : '';
  // The page puts the identifier it was asked for back into its search field.
  const fields = $('input#ConsignmentNumber');
  const echoed = fields.length === 1 ? returnedTrackingNumber(fields.attr('value')) : '';
  if (notice === NOT_FOUND || notice === INVALID) {
    if (echoed !== number) throw new SchemaError(PROVIDER, 'APC Overnight answered for a different number');
    if (notice === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new InvalidInputError(PROVIDER, 'APC Overnight does not accept the number', { reason: 'wrong_number' });
  }
  throw new IndeterminateError(PROVIDER, 'APC Overnight answered with another notice');
}

interface Row { local_time: string; description: string; index: number }

function row(text: string, index: number): Row {
  const match = ROW.exec(text);
  const time = match ? wallClock(match[2]!) : null;
  if (!match || !time) throw new SchemaError(PROVIDER, 'APC Overnight returned a row without its wording and clock');
  return { local_time: time, description: match[1]!, index };
}

/**
 * The tracking page for one waybill: a consignment summary, then each item's
 * journey through the network and its delivery summary, each row a wording
 * with its day and minute. The page names the consignment by its seven-digit
 * number, the end of the waybill it was asked for. A waybill the tracker does
 * not have, or of another shape, comes back on the search page with a notice.
 */
export function parseApcOvernight(html: string, rawNumber: string): CarrierResult {
  const number = normalizeApcOvernightNumber(rawNumber);
  const $ = load(html);
  const summaries = $('div.tracking-container div.con-summary');
  if (!summaries.length) searchPage($, html, number);
  if (summaries.length !== 1) throw new SchemaError(PROVIDER, 'APC Overnight returned an unexpected consignment page');
  if (summaryValue($, 'Consignment number:') !== number.slice(-7)) {
    throw new SchemaError(PROVIDER, 'APC Overnight answered for a different consignment');
  }

  const items = $('div.details-container > div.item-details');
  if (!items.length || items.length > MAX_ITEMS) throw new SchemaError(PROVIDER, 'APC Overnight returned an invalid item list');
  const rows: Row[] = [];
  const seen = new Set<string>();
  items.each((_, item) => {
    const journey = $(item).children('div.detailed-journey-container').children('ul');
    const delivery = $(item).children('div.detailed-delivery-container');
    if (journey.length !== 1 || delivery.length !== 1) throw new SchemaError(PROVIDER, 'APC Overnight item layout changed');
    // Only the first line of a delivery record is read: it is the record's
    // wording and clock, and nothing after it.
    const texts = [
      ...journey.children('li').toArray().map(node => clean($(node).text(), 300)),
      ...delivery.children('div.pod-details').toArray().map(node => clean($(node).children('p').first().text(), 300)),
    ];
    for (const text of texts) {
      if (rows.length >= MAX_ROWS) throw new SchemaError(PROVIDER, 'APC Overnight returned too many rows');
      const parsed = row(text, rows.length);
      // Every item repeats the consignment's delivery records, and items
      // travelling together share their scans.
      const identity = JSON.stringify([parsed.local_time, parsed.description]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      rows.push(parsed);
    }
  });
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Oldest first, equal clocks in the page's order: a notice keeps the stage
  // before it, and a delivery once the consignment was sent back reaches its
  // sender.
  rows.sort((left, right) => left.local_time < right.local_time ? -1 : left.local_time > right.local_time ? 1 : left.index - right.index);
  const events: CarrierEvent[] = [];
  let previous: Stage | undefined;
  let returning = false;
  for (const { local_time, description } of rows) {
    const event: CarrierEvent = { local_time, description };
    events.push(event);
    if (isApcOvernightNotice(description)) {
      Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
      continue;
    }
    const classified = apcOvernightStage(description);
    if (!classified) continue;
    let stage = classified.stage;
    if (stage === 'delivered' && returning) stage = 'returned';
    if (stage === 'returned') returning = true;
    Object.assign(event, { stage, stage_source: classified.source });
    previous = stage;
  }
  events.reverse();

  const latest = events[0]!;
  const decider = events.find(event => event.stage && event.stage_source !== 'none');
  const stage = decider?.stage as Stage | undefined;
  const weight = WEIGHT.exec(summaryValue($, 'Total weight:'))?.[1];
  const service = summaryValue($, 'Consignment service:');
  const serviceName = SERVICE.exec(service)?.[1]?.trim() ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(weight && Number(weight) > 0 ? { weight_kg: Number(weight) } : {}),
    ...(serviceName ? { service_name: serviceName } : {}),
    events,
  };
}
