import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, canadaProvinceTimeZone, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tstCfStage } from './status.js';

export const PROVIDER = 'TST-CF Express';
export const TST_CF_ORIGIN = 'https://www.tst-cfexpress.com';
/** The URL tracing guide's address: it stores the lookup in a session and sends the browser to the results. */
export const TST_CF_LOOKUP = `${TST_CF_ORIGIN}/tracing/by-url`;
/** The session's tracing results page. */
export const TST_CF_RESULTS = `${TST_CF_ORIGIN}/tracing/results`;
// The results page is about 45 kilobytes, most of it the site's menus.
export const TST_CF_MAX_BYTES = 512 * 1024;

// A TST-CF PRO: ten digits, which the tracing service keeps as a number, so it
// cannot start with 0.
const NUMBER = /^[1-9]\d{9}$/;
// The answer for a PRO the tracker does not have.
const NOT_FOUND = 'Invalid Tracking Number';
// A pickup whose freight bill is not entered yet names the PRO it was given in its status.
const ASSIGNED = /\bpro (\d{3})-?(\d{7}) assigned$/i;
// "Delivered on 01/15/2025 at 14:05": the status of a delivered shipment.
const DELIVERED = /^delivered on (\d{1,2})\/(\d{1,2})\/(\d{4})(?: at (\d{1,2}):(\d{2}))?$/i;
// "01/15/2025", or "01/15/2025 @ 14:05" for the appointment and the customs release.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*@\s*(\d{1,2}):(\d{2}))?$/;
const UNSET = 'Not Available';
const WEIGHT = /^(\d{1,7}(?:\.\d{1,3})?)\s*LBS?$/i;
const POUNDS_TO_KG = 0.453_592_37;
// Saia, TST-CF's partner in the United States, delivers the freight TST-CF takes there;
// the page names the shipment's ID at Saia, which is the PRO TST-CF's partner search finds it by.
const PARTNERS: Readonly<Record<string, { carrier: string; pro: RegExp }>> = {
  'Saia Shipment ID': { carrier: 'saia', pro: /^\d{11}$/ },
};
const HEADINGS = ['Reference', 'Pro#'];
const PARTIES = ['Shipper', 'Consignee', 'Third Party'];
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|sucuri_cloudproxy|requested URL was rejected/i;
const MAX_ROWS = 100;

/** A TST-CF Express PRO number: ten digits. Anything else is not one the tracker is asked for. */
export function normalizeTstCfNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TST-CF Express PRO numbers are ten digits');
  return number;
}

/** The URL tracing guide's address for one PRO, with English results. */
export function tstCfLookupUrl(number: string): string {
  return `${TST_CF_LOOKUP}?lang=e&PRO=${normalizeTstCfNumber(number)}`;
}

/** Whether a page is a firewall's or a bot check's instead of the tracker's. */
export function isTstCfBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/**
 * The lookup's own answer, which comes before the page that sends the browser
 * to the results: `[{"errType":"fstatus","finalMsg":"","valStatus":true}]`,
 * with a message before it when the tracker refuses the input.
 */
export function checkTstCfLookup(body: string): void {
  const page = body.search(/<(?:!DOCTYPE|html)\b/i);
  let answer: unknown;
  try {
    answer = JSON.parse(page < 0 ? body : body.slice(0, page));
  } catch (cause) {
    if (isTstCfBlockPage(body)) throw new ChallengeError(PROVIDER, 'TST-CF Express answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'TST-CF Express returned an unexpected lookup answer', { cause });
  }
  if (!Array.isArray(answer) || answer.length > 20 || !answer.every((item) => isRecord(item) && typeof item.errType === 'string')) {
    throw new SchemaError(PROVIDER, 'TST-CF Express returned an unexpected lookup answer');
  }
  const final = (answer as Record<string, unknown>[]).filter((item) => item.errType === 'fstatus');
  if (final.length !== 1 || typeof final[0]!.valStatus !== 'boolean') {
    throw new SchemaError(PROVIDER, 'TST-CF Express returned an unexpected lookup answer');
  }
  // A ten-digit PRO passes the page's own checks, so a refusal is a changed tracker.
  if (!final[0]!.valStatus) throw new SchemaError(PROVIDER, 'TST-CF Express refused the lookup');
}

function invalid(message = 'TST-CF Express changed its tracing results'): never {
  throw new SchemaError(PROVIDER, message);
}

/** "01/15/2025" as a day, or "01/15/2025 @ 14:05" as a wall clock; null for a field the page leaves unset. */
function clockOf(value: string | undefined): string | null {
  if (!value || value === UNSET) return null;
  const match = CLOCK.exec(value);
  if (!match) invalid('TST-CF Express returned an invalid date');
  return wallClock(match);
}

function wallClock([, month, day, year, hour, minute]: RegExpExecArray): string {
  const date = calendarDay(Number(year), Number(month), Number(day));
  // The clock's fields are checked here, since date libraries accept hour 24.
  if (!date || (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59))) invalid('TST-CF Express returned an invalid date');
  return hour === undefined ? date : `${date}T${hour.padStart(2, '0')}:${minute}:00`;
}

function milestone(local_time: string, description: string, staged: ClassifiedWording): CarrierEvent {
  return { local_time, description, stage: staged.stage, stage_source: staged.source };
}

/** The rows of the results table itself, not of the tables inside it. */
function ownRows($: CheerioAPI, table: Cheerio<AnyNode>): Cheerio<AnyNode> {
  return table.find('tr').filter((_, row) => $(row).closest('table').is(table));
}

interface Lookup { cells: Cheerio<AnyNode>; details: Cheerio<AnyNode>[] }

/**
 * The results table: a heading, then for each reference looked up a row with
 * the reference, the PRO and the documents or a notice, and the rows under it
 * that hold the partners' IDs and the shipment's details.
 */
function lookups($: CheerioAPI, table: Cheerio<AnyNode>): Lookup[] {
  const rows = ownRows($, table);
  if (rows.length > MAX_ROWS) invalid('TST-CF Express returned an oversized results table');
  const headings = rows.first().children('th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (headings.slice(0, 2).join('|') !== HEADINGS.join('|')) invalid();
  const found: Lookup[] = [];
  rows.slice(1).each((_, node) => {
    const cells = $(node).children('td');
    const first = clean(cells.eq(0).text(), 64);
    if (cells.length === 3 && first) found.push({ cells, details: [] });
    else if (cells.length === 2 && found.length && !first) found.at(-1)!.details.push(cells.eq(1));
    else invalid();
  });
  return found;
}

interface Details { facts: Map<string, string>; partners: Map<string, string>; consignee: string }

/**
 * The labelled values under a lookup: the shipment's details in its tables,
 * the partners' IDs outside them, and the consignee's town and province or
 * state. The shipper, the third party and the references are not kept.
 */
function details($: CheerioAPI, cells: readonly Cheerio<AnyNode>[]): Details {
  const facts = new Map<string, string>();
  const partners = new Map<string, string>();
  let consignee = '';
  for (const cell of cells) {
    cell.find('label').each((_, node) => {
      const label = $(node);
      const name = clean(label.text(), 80).replace(/\s*:$/, '');
      const holder = label.parent().clone();
      holder.find('label').remove();
      const value = clean(holder.text(), 200);
      const into = label.closest('table.status-detail').length ? facts : partners;
      if (name && !into.has(name)) into.set(name, value);
    });
    cell.find('table.status-detail').each((_, node) => {
      const rows = $(node).children('tr').length ? $(node).children('tr') : $(node).children('tbody').children('tr');
      const headings = rows.first().children('th').map((_, th) => clean($(th).text(), 40)).get();
      if (headings.join('|') !== PARTIES.join('|')) return;
      consignee = clean(rows.eq(1).children('td').eq(PARTIES.indexOf('Consignee')).text(), 80);
    });
  }
  return { facts, partners, consignee };
}

/** The country of a "TOWN, XX" place from its province or state, when it is Canada or the United States. */
function countryOf(place: string): string | null {
  const region = /,\s*([A-Z]{2})$/.exec(place)?.[1];
  if (!region) return null;
  return canadaProvinceTimeZone(region) ? 'CA' : usStateTimeZone(region) ? 'US' : null;
}

function weightOf(value: string | undefined): number | null {
  const pounds = Number(WEIGHT.exec(value ?? '')?.[1] ?? 0);
  return pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * Saia, with its PRO, when the page names Saia's shipment ID and the freight
 * goes to the United States, where Saia delivers it. Freight Saia brings to
 * TST-CF from there names it too; TST-CF delivers that.
 */
function handoff(partners: Map<string, string>, destination: string | null): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (destination !== 'US') return {};
  for (const [label, { carrier, pro }] of Object.entries(PARTNERS)) {
    const value = partners.get(label)?.replace(/[\s-]/g, '') ?? '';
    if (pro.test(value)) return { delivery_carrier: carrier, delivery_tracking_number: value };
  }
  return {};
}

/**
 * The tracing results page the URL tracing guide's lookup sends the browser
 * to, for one PRO. A PRO it has comes with its status line, weight, piece or
 * skid count, charges, service level, references, pickup day, appointment,
 * customs release or estimate, the cities of the shipper, consignee and third
 * party, and the partners' IDs; an unknown one with "Invalid Tracking Number".
 * Anonymous visitors get no scan history.
 */
export function parseTstCf(html: string, rawNumber: string): CarrierResult {
  const number = normalizeTstCfNumber(rawNumber);
  const $ = load(html);
  const table = $('table.tfi-table-results');
  if (table.length !== 1) {
    if (isTstCfBlockPage(html)) throw new ChallengeError(PROVIDER, 'TST-CF Express answered with a block page');
    invalid('TST-CF Express did not return its tracing results');
  }
  // The first column echoes what was asked; the second names the shipment found.
  const asked = lookups($, table).filter(({ cells }) => clean(cells.eq(0).text(), 64) === number);
  if (!asked.length) throw new IndeterminateError(PROVIDER, 'TST-CF Express answered for another lookup');
  if (asked.length > 1) invalid('TST-CF Express repeated a lookup');
  const [{ cells, details: rows }] = asked as [Lookup];
  const notice = clean(cells.eq(2).find('.track-error-msg').text(), 120);
  if (notice) {
    if (notice === NOT_FOUND && clean(cells.eq(1).text(), 32) === UNSET) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'TST-CF Express answered with a notice it does not usually give');
  }

  const { facts, partners, consignee } = details($, rows);
  const status = facts.get('Status') ?? '';
  const pro = clean(cells.eq(1).text(), 32);
  if (pro !== number) {
    // A completed pickup has no PRO column yet; its status names the PRO it was given.
    const assigned = ASSIGNED.exec(status);
    if (pro || !assigned || `${assigned[1]}${assigned[2]}` !== number) {
      throw new IndeterminateError(PROVIDER, 'TST-CF Express answered for another shipment');
    }
  }

  const events: CarrierEvent[] = [];
  const delivery = DELIVERED.exec(status);
  const delivered = delivery ? wallClock(delivery) : null;
  if (delivered) events.push(milestone(delivered, 'Delivered', { stage: 'delivered', source: 'carrier_map' }));
  const release = clockOf(facts.get('Customs Release'));
  if (release) events.push(milestone(release, 'Customs Release', { stage: 'in_transit', source: 'carrier_map' }));
  const shipped = clockOf(facts.get('Shipped'));
  if (shipped) events.push(milestone(shipped, 'Shipped', { stage: 'accepted', source: 'carrier_map' }));
  // Newest first; a day sorts before the clocks of that day.
  events.sort((a, b) => (a.local_time === b.local_time ? 0 : String(a.local_time) < String(b.local_time) ? 1 : -1));
  if (!status && !events.length) throw new NoHistoryError(PROVIDER);

  const staged = status ? tstCfStage(status) : null;
  const newest = events[0];
  // A status no rule reads leaves the stage to the newest milestone.
  const decided: ClassifiedWording | null = staged ?? (newest ? { stage: newest.stage as Stage, source: newest.stage_source! } : null);
  const settled = decided?.stage === 'delivered' || decided?.stage === 'returned';
  // The day of the delivery appointment once one is made, else of the estimate. The estimate
  // can be a note instead, such as one to call for it.
  const estimated = facts.get('Estimated Delivery') ?? '';
  const estimate = (clockOf(facts.get('Appointment')) ?? (CLOCK.test(estimated) ? clockOf(estimated) : null))?.slice(0, 10) ?? null;
  const destination = countryOf(consignee);
  const weight = weightOf(facts.get('Ship Weight'));
  const service = facts.get('Service Level');
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: status || null,
    last_update: null,
    ...(delivered ? { last_update_local: delivered } : {}),
    expected_delivery: settled ? null : estimate,
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(service && service !== UNSET ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...handoff(partners, destination),
    summary_only: true,
    events,
  };
}
