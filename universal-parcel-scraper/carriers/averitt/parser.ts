import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { averittStage } from './status.js';

export const PROVIDER = 'Averitt Express';
// A shipment's page is about 25 kB, most of it the site around the tracking.
export const AVERITT_MAX_BYTES = 512 * 1024;

// Averitt's PRO numbers: ten digits, leading zeros included.
const NUMBER = /^\d{10}$/;
// "09/17/2026 2:18 PM"
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/;
const POUNDS = /^\d{1,6}(?:\.\d{1,3})?$/;
const POUNDS_TO_KG = 0.453_592_37;
// The results page's notice for a number the tracker has no shipment for.
const NOTHING_FOUND = 'Nothing found to display.';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|requested URL was rejected|Incapsula incident|_Incapsula_Resource/i;
// The page's blank for a field it has no value for.
const BLANK = '-';
// A stage the page's status settles over the newest row.
const SETTLED = new Set<Stage>(['delivered', 'returned', 'exception']);
const MAX_ROWS = 500;

/** An Averitt PRO number: ten digits. Anything else is not one the tracker is asked for. */
export function normalizeAverittNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Averitt PRO numbers are ten digits');
  return number;
}

/** "09/17/2026 2:18 PM" as a wall clock. The page gives no zone. */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const [, month, day, year, hour, minute, half] = match;
  if (Number(hour) < 1 || Number(hour) > 12 || Number(minute) > 59) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day),
    hour: (Number(hour) % 12) + (half === 'PM' ? 12 : 0), minute: Number(minute) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * The value next to one label in a list of the page, or '' without one or
 * with the page's blank. The lists also name the shipper, the consignee, who
 * took the delivery, the references and the delivering service center; only
 * the labels asked for are read.
 */
function labelled($: CheerioAPI, scope: string, label: string): string {
  const items = $(`${scope} li.ae-result-list--item`)
    .filter((_, item) => clean($(item).children('.ae-result-list--item-label').text(), 80) === label);
  if (items.length > 1) throw new SchemaError(PROVIDER, 'Averitt repeated a detail of the shipment');
  const value = items.length ? clean(items.children('.ae-result-list--item-val').text(), 120) : '';
  return value === BLANK ? '' : value;
}

/** The results page the tracker answers with when it has no single shipment to show. */
function resultsPage($: CheerioAPI): never {
  const main = $('main');
  if (main.find('[name="detailsLink[]"]').length) throw new IndeterminateError(PROVIDER, 'Averitt listed several shipments for the number');
  if (clean(main.children('div.ae-section').text(), 200) === NOTHING_FOUND) throw new NotFoundError(PROVIDER);
  throw new SchemaError(PROVIDER, 'Averitt returned an unexpected results page');
}

interface Row { key: string; event: CarrierEvent }

/** One row of the shipment progression: the place, its clock and the status there. */
function row($: CheerioAPI, cells: ReturnType<CheerioAPI>): Row {
  const cell = (title: string) => {
    const matches = cells.filter((_, node) => $(node).attr('data-title') === title);
    if (matches.length !== 1) throw new SchemaError(PROVIDER, 'Averitt changed its shipment progression');
    return clean(matches.text(), 200);
  };
  const local_time = wallClock(cell('Date/Time'));
  const description = cell('Status');
  if (!local_time || !description) throw new SchemaError(PROVIDER, 'Averitt returned a row without its clock and status');
  const location = cell('Location');
  const staged = averittStage(description);
  const event: CarrierEvent = {
    local_time,
    ...(location && location !== BLANK ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local_time, description, location]), event };
}

/** The rows of the shipment progression, newest first and once each. */
function progression($: CheerioAPI): CarrierEvent[] {
  const tables = $('#shipment-progression').nextAll('table');
  if (!tables.length) throw new SchemaError(PROVIDER, 'Averitt returned a page without its shipment progression');
  const rows = tables.first().find('tbody > tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Averitt returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, node) => {
    const parsed = row($, $(node).children('td'));
    if (seen.has(parsed.key)) return;
    seen.add(parsed.key);
    events.push(parsed.event);
  });
  // The page lists the oldest first; a list the other way round is kept.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/**
 * The pickup and the delivery the summary dates, for a shipment whose rows
 * Averitt no longer shows. The delivery counts only on a delivered shipment.
 */
function summaryEvents($: CheerioAPI, delivered: boolean): CarrierEvent[] {
  const events: CarrierEvent[] = [];
  const event = (local_time: string | null, location: string, description: string, stage: Stage) => {
    if (local_time) events.push({ local_time, ...(location ? { location } : {}), description, stage, stage_source: 'carrier_map' });
  };
  if (delivered) {
    const day = labelled($, '#delivery-information', 'Date:');
    const time = labelled($, '#delivery-information', 'Time:');
    event(day && time ? wallClock(`${day} ${time}`) : null, labelled($, '#delivery-information', 'Delivery Point:'), 'Delivered', 'delivered');
  }
  event(wallClock(labelled($, '#pickup-information', 'Pickup Date / Time:')), labelled($, '#pickup-information', 'Origin Point:'),
    'Picked Up', 'accepted');
  return events;
}

/** The shipment's weight in kilograms, from the pounds Averitt weighs freight in. */
function weightOf($: CheerioAPI): number | undefined {
  const pounds = labelled($, '#shipment-information', 'Weight:');
  if (!POUNDS.test(pounds) || !(Number(pounds) > 0)) return undefined;
  return Math.round(Number(pounds) * POUNDS_TO_KG * 1000) / 1000;
}

/**
 * The tracking page of `servlet/rsoLTLtrack` for one PRO number: the status,
 * the PRO number and service unit, the pickup, shipment and delivery details,
 * and the shipment progression, a row per terminal scan with its place, a wall
 * clock and the status there. A number without a shipment comes back on the
 * results page with "Nothing found to display.", which names no number.
 */
export function parseAveritt(html: string, rawNumber: string): CarrierResult {
  const number = normalizeAverittNumber(rawNumber);
  const $ = load(html);
  const heading = clean($('main h1.ae-page-heading').text(), 80);
  if (heading === 'Tracking Results') resultsPage($);
  if (heading !== 'Tracking Details') {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Averitt answered with a block page');
    throw new SchemaError(PROVIDER, 'Averitt did not return a tracking page');
  }
  if (labelled($, 'main', 'PRO Number:') !== number) throw new SchemaError(PROVIDER, 'Averitt answered for another shipment');

  const statuses = $('main .ae-tracking-results--status-container p.h1');
  if (statuses.length > 1) throw new SchemaError(PROVIDER, 'Averitt returned several statuses');
  const status = clean(statuses.text(), 120);
  const headline: ClassifiedWording | null = status ? averittStage(status) : null;
  const rows = progression($);
  const events = rows.length ? rows : summaryEvents($, headline?.stage === 'delivered');
  if (!events.length && !headline) throw new NoHistoryError(PROVIDER);

  // The page's status settles a delivery, a return or a problem, and a
  // shipment without a staged row; otherwise the newest staged row is ahead of it.
  const newest = events[0];
  const scanned = events.find((event) => event.stage);
  const settled = headline !== null && (SETTLED.has(headline.stage) || !scanned);
  const decided = settled ? headline : scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null;
  const weight = weightOf($);
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (settled ? status : newest?.description) || status || null,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    ...(rows.length ? {} : { summary_only: true }),
    events,
  };
}
