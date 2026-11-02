import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { TFORCE_PARS } from './number.js';
import { NOT_AVAILABLE, tforceFreightShipmentStage, tforceFreightStage } from './status.js';

export const PROVIDER = 'TForce Freight';

const TOKEN = /^[A-Za-z0-9_-]{40,400}$/;
// The F5 firewall in front of the site, and its JavaScript bot defence.
const BLOCK = /<title>\s*Request Rejected\s*<\/title>|The requested URL was rejected|\/TSPD\/|\bbobcmn\b/i;
// The site's error page, for a refused token or a failure of its own.
const UNABLE = /Unable to process your request/i;
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
// The page's twelve-hour clock: hour 00 and hour 13 are no reading of it.
const CLOCK = /^(0?[1-9]|1[0-2]):([0-5]\d) ?([AP])M$/i;
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const POUNDS = /^(\d{1,3}(?:,?\d{3})*(?:\.\d+)?) ?lbs?$/i;
const POUNDS_TO_KG = 0.453_592_37;
const HEADINGS = ['Location', 'Date', 'Time', 'Activity'];
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Stages after which the tracker shows no estimate.
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

type Selection = ReturnType<CheerioAPI>;


/**
 * A PRO number as TForce Freight's tracker takes it: nine digits whose last is
 * the first eight modulo 7, or eight digits, which the tracker reads with a
 * leading zero. A PARS number gives its PRO.
 */
export function normalizeTforceFreightNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const digits = TFORCE_PARS.exec(number)?.[1] ?? number;
  const pro = /^\d{8,9}$/.test(digits) ? digits.padStart(9, '0') : '';
  if (!pro || !hasMod7CheckDigit(pro)) throw new InvalidInputError(PROVIDER, 'TForce Freight PRO numbers are nine digits ending in a check digit');
  return pro;
}

/** A firewall page in place of the site's own. */
export function assertNotBlocked(html: string): void {
  if (BLOCK.test(html.slice(0, 20_000))) throw new ChallengeError(PROVIDER, 'TForce Freight rejected the request at its firewall');
}

/**
 * The anti-forgery token of the tracking page, which the lookup posts back
 * with its cookie. The page keeps it once, near the top, for every form its
 * scripts send. A CAPTCHA switched on for the PRO search is refused before any
 * lookup.
 */
export function parseTforceFreightForm(html: string): string {
  assertNotBlocked(html);
  if (UNABLE.test(html)) throw new IndeterminateError(PROVIDER, 'TForce Freight tracking page is unavailable');
  const $ = load(html);
  const forms = $('form#trackingByProForm[action="/ltl/apps/Tracking"]');
  if (forms.length !== 1 || forms.find('input[name="ProNumbers"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'TForce Freight did not return its tracking form');
  }
  const captcha = $('input#requiredreCaptchaPROhidden').attr('value');
  if (captcha === undefined) throw new SchemaError(PROVIDER, 'TForce Freight tracking form changed');
  if (/^true$/i.test(captcha.trim())) throw new ChallengeError(PROVIDER, 'TForce Freight asks for a CAPTCHA');
  const token = $('input[name="__RequestVerificationToken"][value]').filter((_, input) => Boolean($(input).attr('value'))).first().attr('value') ?? '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'TForce Freight tracking form changed');
  return token;
}

function dayOf(value: string): string | null {
  const match = DAY.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
}

/** A row's clock: its date and twelve-hour time as an offset-less wall clock, or its date alone. */
function clockOf(date: string, time: string): { local_time?: string } {
  if (!date && !time) return {};
  const day = dayOf(date);
  if (!day) throw new SchemaError(PROVIDER, 'TForce Freight returned an invalid history date');
  if (!time) return { local_time: day };
  const match = CLOCK.exec(time);
  if (!match) throw new SchemaError(PROVIDER, 'TForce Freight returned an invalid history time');
  const hour = (Number(match[1]) % 12) + (match[3]!.toUpperCase() === 'P' ? 12 : 0);
  return { local_time: `${day}T${String(hour).padStart(2, '0')}:${match[2]}:00` };
}

/**
 * One history row: the service center's city and state, its wall clock and
 * the activity. The trailer is not kept. The page leaves out a row without an
 * activity.
 */
function eventOf($: CheerioAPI, row: Selection): CarrierEvent | null {
  const cells = row.children('td');
  if (cells.length < HEADINGS.length) throw new SchemaError(PROVIDER, 'TForce Freight returned an invalid history row');
  const cell = (index: number, max: number) => clean($(cells[index]).text(), max);
  const activity = clean(cell(3, 300).replace(PHONE, ''), 200);
  if (!activity) return null;
  const event: CarrierEvent = { ...clockOf(cell(1, 32), cell(2, 32)), description: activity };
  const location = cell(0, 80);
  if (location) event.location = location;
  const staged = tforceFreightStage(activity);
  if (staged) Object.assign(event, { stage: staged.stage, stage_source: staged.source });
  return event;
}

/** The value the card prints after a label, such as "Weight" or "Estimated Delivery". */
function labelled($: CheerioAPI, card: Selection, name: string): string | null {
  const labels = card.find('label').toArray();
  const index = labels.findIndex((label) => $(label).attr('for') !== undefined && clean($(label).text(), 80) === name);
  return index >= 0 && index + 1 < labels.length ? clean($(labels[index + 1]).text(), 120) : null;
}

/** The shipment's weight in pounds, as kilograms. */
function weightKg(value: string | null): number | null {
  const match = POUNDS.exec(value ?? '');
  const pounds = match ? Number(match[1]!.replace(/,/g, '')) : Number.NaN;
  return Number.isFinite(pounds) && pounds > 0 && pounds < 1_000_000 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * The country code that ends the consignee's city line, "CITY ST US". The
 * state comes before it, so a line without a country never reads a state as
 * one ("CA" is California there).
 */
function destinationCountry(card: Selection): string | null {
  const line = clean(card.find('#lblOrigShipToCityState').first().text(), 120);
  const code = /\s[A-Z]{2} ([A-Z]{2})$/.exec(line)?.[1];
  return code ? countryCode(code) : null;
}

/** The tracker's estimate while the freight is on its way; a day before the newest scan's is stale. */
function estimate($: CheerioAPI, card: Selection, newestDay: string | null): string | null {
  const day = dayOf(labelled($, card, 'Estimated Delivery') ?? '');
  return day && !(newestDay && day < newestDay) ? day : null;
}

/** The PRO a result card is for, and the status the card shows beside it. */
function heading(card: Selection): { pro: string; status: string } {
  const spans = card.children('.card-header').find('button > span');
  return { pro: clean(spans.eq(0).text(), 32), status: clean(spans.eq(1).text(), 80) };
}

/**
 * The tracking page after its search: one card per PRO, under a group for the
 * PRO asked, with the shipment's status, its history newest first in the
 * page's order (the clocks are each service center's own), and its details.
 * The consignee and shipper, the signer, the delivery appointment, the bill of
 * lading and PO numbers, the pieces, the trailers and the service centers'
 * codes are never read.
 */
export function parseTforceFreight(html: string, raw: string): CarrierResult {
  const pro = normalizeTforceFreightNumber(raw);
  assertNotBlocked(html);
  const $ = load(html);
  const results = $('#accordionExample');
  if (results.length !== 1) {
    if (UNABLE.test(html)) throw new IndeterminateError(PROVIDER, 'TForce Freight did not answer the lookup');
    throw new SchemaError(PROVIDER, 'TForce Freight returned an unexpected page');
  }
  const cards = results.find('.card.trackingResultCard').toArray().map((card) => $(card));
  if (cards.length === 0) {
    // The tracker's answer to a PRO its own check refuses, which the adapter's check refuses first.
    if (/^Invalid Data\.?$/i.test(clean($('#errorText').text(), 80))) throw new InvalidInputError(PROVIDER, 'TForce Freight refused the PRO', { reason: 'wrong_number' });
    // The page as it is before a search: the lookup was not made.
    if (results.find('.card').length === 0) throw new IndeterminateError(PROVIDER, 'TForce Freight did not answer the lookup');
    throw new SchemaError(PROVIDER, 'TForce Freight returned a changed result');
  }
  const mine = cards.filter((card) => heading(card).pro === pro);
  if (mine.length === 0) throw new IndeterminateError(PROVIDER, 'TForce Freight answered for another shipment');
  if (mine.length > 1) throw new SchemaError(PROVIDER, 'TForce Freight returned the PRO twice');
  const card = mine[0]!;
  const summary = heading(card).status;
  if (!summary) throw new SchemaError(PROVIDER, 'TForce Freight returned a shipment without its status');
  if (summary.toLowerCase() === NOT_AVAILABLE) {
    // The notice repeats the PRO as it was typed, without the leading zero the card adds to eight digits.
    const notice = /Please check ProNumber (\d{8,9})\b/.exec(clean(card.text(), 2000));
    if (notice?.[1]!.padStart(9, '0') === pro) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'TForce Freight has no tracking for the PRO');
  }

  const tables = card.find('table');
  const headings = tables.first().find('thead th').toArray().map((cell) => clean($(cell).text(), 40));
  if (tables.length !== 1 || HEADINGS.some((name, index) => headings[index] !== name)) {
    throw new SchemaError(PROVIDER, 'TForce Freight returned a changed history');
  }
  const rows = tables.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TForce Freight returned an invalid history');
  const seen = new Set<string>();
  const events = rows.map((row) => eventOf($, $(row))).filter((event): event is CarrierEvent => {
    if (!event) return false;
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const summaryStage = tforceFreightShipmentStage(summary);
  const newest = events[0];
  if (!newest && !summaryStage) throw new NoHistoryError(PROVIDER);
  // A delivery the status shows decides. Otherwise the newest scan with a
  // stage does, since it can be more precise than "In Transit"; without one,
  // the status.
  const scanned = events.find((event) => event.stage);
  const delivered = summaryStage === 'delivered';
  const stage = (delivered ? summaryStage : scanned?.stage ?? summaryStage) as Stage | undefined;
  const source = delivered || !scanned ? 'carrier_map' : scanned.stage_source;
  // A delivery shows its own scan's wording, wherever the page lists it.
  const shown = delivered ? events.find((event) => event.stage === 'delivered') : newest;
  const newestDay = typeof newest?.local_time === 'string' ? newest.local_time.slice(0, 10) : null;
  const weight = weightKg(labelled($, card, 'Weight'));
  const service = labelled($, card, 'Service');
  const country = destinationCountry(card);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: shown?.description ?? summary,
    last_update: null,
    last_update_local: typeof newest?.local_time === 'string' ? newest.local_time : null,
    expected_delivery: stage && FINAL.has(stage) ? null : estimate($, card, newestDay),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(newest ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
