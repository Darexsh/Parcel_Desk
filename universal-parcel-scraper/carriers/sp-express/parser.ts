import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { spExpressStage } from './status.js';

export const PROVIDER = 'SP Express';
// A parcel's page is about 40 kB, most of it the site's own markup.
export const SP_EXPRESS_MAX_BYTES = 1024 * 1024;
export const SP_EXPRESS_HOST = 'https://en.sp.express';
// Its own order numbers: 483, the sending date as YYMMDD and six digits.
const ORDER = /^483\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{6}$/;
// Parcels of Cainiao's economy flow, on the tracker's Cainiao page: a destination country code and twelve digits.
const CAINIAO = /^[A-Z]{2}\d{12}$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha-delivery\.com/i;
// The notice the search page shows after the tracker sent an unknown number back to it, in English and Polish.
const NOT_FOUND = /\$\.notify\(\s*"(?:Shipping not find the specified ID!|Nie znaleziono przesyłki o podanym ID!)/;
// The notice in place of the history of an older parcel.
const ARCHIVED = /^(?:Status history is in archive|Historia statusów tej przesyłki już wygasła)\.?$/i;
// "2026-03-02 14:05", or with seconds on older pages.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/;
const WEIGHT = /^(\d{1,5}(?:[.,]\d{1,3})?)\s*(kg|g)$/i;
const DIMENSIONS = /^(\d{1,4}(?:[.,]\d{1,2})?) x (\d{1,4}(?:[.,]\d{1,2})?) x (\d{1,4}(?:[.,]\d{1,2})?) cm$/i;
// A partner's or Cainiao's reference the tracker puts in brackets after a wording, as "(SINT0000000001)".
const REFERENCE = /^[A-Z]{0,8}\d{5,}[A-Z]{0,4}$/i;
// Who took the parcel, which partners put where the place goes: "Signed by: …", "Odebrał: …".
const PERSON = /:|\b(?:sign|podpis|odebra|odbior|receiv|recipient|empf)/i;
const MAX_ROWS = 300;
// The progress rail's steps, in their order, and the stage each one reaches.
const RAIL: readonly (readonly [string, Stage])[] = [
  ['stat-ico-new', 'registered'],
  ['stat-ico-accepted', 'accepted'],
  ['stat-ico-hub', 'in_transit'],
  ['stat-ico-transportation', 'in_transit'],
  ['stat-ico-delivery', 'out_for_delivery'],
  ['stat-ico-delivered', 'delivered'],
];

/** Which of the tracker's pages looks a number up. */
export type SpExpressPage = 'tt' | 'tt-cainiao';

/** An SP Express order number, or a Cainiao parcel's, in capitals; anything else is not one it issues. */
export function normalizeSpExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!ORDER.test(number) && !CAINIAO.test(number)) {
    throw new InvalidInputError(PROVIDER, 'SP Express numbers are 483, a sending date and six digits, or a country code and twelve digits');
  }
  return number;
}

/** The tracker page that looks the number up: Cainiao parcels have their own. */
export function spExpressPage(raw: string): SpExpressPage {
  return CAINIAO.test(normalizeSpExpressNumber(raw)) ? 'tt-cainiao' : 'tt';
}

/** The tracker's page for one number. */
export function spExpressTrackingUrl(raw: string): string {
  const number = normalizeSpExpressNumber(raw);
  return `${SP_EXPRESS_HOST}/${spExpressPage(number)}/${number}`;
}

/** The search page an unknown number is sent back to. */
export function spExpressSearchUrl(raw: string): string {
  return `${SP_EXPRESS_HOST}/${spExpressPage(raw)}`;
}

/** A scan's wall clock. The page names no zone, and partners scan in other countries, so it stays local. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const local = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'SP Express returned an invalid scan time');
  }
  // The hub's manifest and inbound scans come dated at midnight: a day without a time.
  return local.endsWith('T00:00:00') ? local.slice(0, 10) : local;
}

/** A place as the tracker writes it ("Nysa", "Unna (DE)", "Paris/France"), or nothing for a person, a reference or a dash. */
function place(text: string): string {
  const value = clean(text, 120).replace(/\s*\/\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
  if (!/\p{L}/u.test(value) || PERSON.test(value) || REFERENCE.test(value)) return '';
  return value;
}

/**
 * A wording and what the tracker puts in brackets after it: the place of the
 * scan, a reference or who signed. Only a place is kept.
 */
function split(text: string): { wording: string; place: string } {
  const value = clean(text, 400);
  if (!value.endsWith(')')) return { wording: value, place: '' };
  let depth = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] === ')') depth += 1;
    else if (value[index] === '(' && --depth === 0) {
      const wording = clean(value.slice(0, index), 300);
      // A wording that is all brackets is kept whole.
      if (!wording) break;
      return { wording, place: place(value.slice(index + 1, -1)) };
    }
  }
  return { wording: value, place: '' };
}

/** The History table's rows, newest first, with or without a column for the place. */
function scans($: CheerioAPI): CarrierEvent[] {
  const tables = $('table.list.hTop');
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'SP Express returned several histories');
  if (!tables.length) return [];
  const rows = tables.find('tr').toArray();
  const header = rows.shift();
  const columns = header ? $(header).children('td,th').toArray().map((cell) => clean($(cell).text(), 40).toLowerCase()) : [];
  const withPlace = columns.length === 3 && columns[2] === 'lokalizacja';
  if (columns[0] !== 'data' || columns[1] !== 'status' || (columns.length !== 2 && !withPlace)) {
    throw new SchemaError(PROVIDER, 'SP Express returned a history with other columns');
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SP Express returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = $(row).children('td').toArray().map((cell) => $(cell).text());
    if (cells.length !== columns.length) throw new SchemaError(PROVIDER, 'SP Express returned an invalid scan');
    const local = wallClock(clean(cells[0], 40));
    const { wording, place: bracketed } = split(cells[1]!);
    if (!wording) throw new SchemaError(PROVIDER, 'SP Express returned a scan without wording');
    const location = (withPlace ? place(cells[2]!) : '') || bracketed;
    const key = JSON.stringify([local, wording.toLowerCase(), location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = spExpressStage(wording);
    events.push({ local_time: local, description: wording, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  return events;
}

/** The furthest lit step of the progress rail. */
function railStage($: CheerioAPI): Stage | undefined {
  let reached: Stage | undefined;
  for (const [name, stage] of RAIL) {
    if ($(`.stat-item-ico-container.active > .stat-item-ico.${name}`).length) reached = stage;
  }
  return reached;
}

/** The Order details table, by its labels in lower case. */
function details($: CheerioAPI): Map<string, string> {
  const values = new Map<string, string>();
  $('table.list.hLeft tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length !== 2) return;
    const label = clean(cells.eq(0).text(), 60).toLowerCase();
    if (label && !values.has(label)) values.set(label, clean(cells.eq(1).text(), 120));
  });
  return values;
}

function weight(text: string | undefined): number | undefined {
  const match = WEIGHT.exec(text ?? '');
  if (!match) return undefined;
  const value = Number(match[1]!.replace(',', '.')) / (match[2]!.toLowerCase() === 'g' ? 1000 : 1);
  return value > 0 ? Math.round(value * 1000) / 1000 : undefined;
}

/** The number the page's Reference link opens, on the page it was asked on. */
function referenced($: CheerioAPI, page: SpExpressPage): string {
  const heading = $('h2').filter((_, element) => /^(?:Reference|Odnośnik)$/i.test(clean($(element).text(), 40)));
  if (heading.length !== 1) return '';
  const href = clean(heading.nextAll('a[href]').first().attr('href'), 300);
  let url: URL;
  try { url = new URL(href, SP_EXPRESS_HOST); } catch { return ''; }
  const match = /^\/(tt|tt-cainiao)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match || match[1] !== page) return '';
  try { return decodeURIComponent(match[2]!).toUpperCase(); } catch { return ''; }
}

/**
 * The tracker's search page an unknown number was sent back to. The session
 * holds the notice it shows; any other page is not an answer about the number.
 */
export function parseSpExpressSearchPage(html: string): never {
  if (NOT_FOUND.test(html)) throw new NotFoundError(PROVIDER);
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SP Express answered with a browser check');
  throw new IndeterminateError(PROVIDER, 'SP Express sent the lookup back to its search page without a notice');
}

/**
 * SP Express's tracker page for one number, `/tt/{number}` or
 * `/tt-cainiao/{number}`: the progress rail, the current status, the history
 * newest first, or a notice that it is archived, the order details and a
 * Reference link that opens the number. The link must open the number asked.
 */
export function parseSpExpress(html: string, raw: string): CarrierResult {
  const number = normalizeSpExpressNumber(raw);
  const $ = load(html);
  if (!$('form#tt-form').length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SP Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'SP Express did not return its tracking page');
  }
  const bar = $('.tt-status-bar');
  if (!bar.length) {
    if (NOT_FOUND.test(html)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'SP Express returned a page without a shipment');
  }
  if (bar.length > 1) throw new SchemaError(PROVIDER, 'SP Express returned several shipments');
  const echoed = referenced($, spExpressPage(number));
  if (!echoed) throw new SchemaError(PROVIDER, 'SP Express returned a shipment without its number');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'SP Express answered for another number');

  const events = scans($);
  const archived = $('.alert.alert-warning').toArray().some((element) => ARCHIVED.test(clean($(element).text(), 80)));
  if (!$('table.list.hTop').length && !archived) throw new SchemaError(PROVIDER, 'SP Express returned a shipment without its history');
  const current = split(bar.text()).wording;
  if (!events.length && !current) throw new NoHistoryError(PROVIDER);

  const values = details($);
  const kilograms = weight(values.get('package weight') ?? values.get('weight'));
  const dimensions = DIMENSIONS.exec(values.get('parcel dimensions') ?? '');
  // "France (71580)": the recipient's postcode is not kept.
  const country = countryCode(clean((values.get('receiver country') ?? '').replace(/\s*\([^()]*\)\s*$/, ''), 60));
  const facts = {
    expected_delivery: null,
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(dimensions ? { dimensions_text: `${dimensions[1]} × ${dimensions[2]} × ${dimensions[3]} cm` } : {}),
    ...(country ? { destination_country: country } : {}),
  };

  if (!events.length) {
    // An older parcel's history is archived: the status bar is all that is left, without a clock.
    const worded = spExpressStage(current);
    const stage = worded?.stage ?? railStage($);
    return {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: worded?.source ?? 'carrier_map' } : {}),
      last_status_text: current,
      last_update: null,
      ...facts,
      summary_only: true,
      events: [],
    };
  }

  // Clocks come from several countries and keep no zone, so the page's order stands.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined ?? railStage($);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    ...facts,
    events,
  };
}
