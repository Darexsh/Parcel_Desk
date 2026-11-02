import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { skyboxStage } from './status.js';

export const PROVIDER = 'SkyBox';
export const CARRIER = 'skybox';
// A fragment is about 21 kB.
export const SKYBOX_MAX_BYTES = 512 * 1024;

// Twelve digits, which the tracker prints as four digits, a dash and eight digits.
const NUMBER = /^\d{12}$/;
const SHOWN_NUMBER = /^\d{4}-?\d{8}$/;
// "04/24/2025 18:00": month, day, year and a wall clock to the minute with no zone.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
// Bot checks and firewall refusals that could stand in for the fragment.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
// The whole message the fragment shows for a number the tracker does not know.
const NOT_FOUND = 'The tracking number does not exists';
const MAX_EVENTS = 200;

/** A number for SkyBox's tracker: twelve digits, with or without the dash it prints after the fourth. */
export function normalizeSkyboxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SkyBox numbers are twelve digits');
  return number;
}

/** A row's wall clock, to the minute. */
function wallClock(text: string): string {
  const parts = CLOCK.exec(text);
  if (parts) {
    const [month, day, year, hour, minute] = parts.slice(1).map(Number) as [number, number, number, number, number];
    const date = calendarDay(year, month, day);
    if (date && year >= 2000 && hour <= 23 && minute <= 59) return `${date}T${parts[4]}:${parts[5]}:00`;
  }
  throw new SchemaError(PROVIDER, 'SkyBox returned an invalid scan time');
}

/** A hidden or disabled field's value, or null when the fragment has no such field. */
function field($: CheerioAPI, id: string): string | null {
  const input = $(`input#${id}`);
  if (input.length > 1) throw new SchemaError(PROVIDER, 'SkyBox returned several parcels');
  return input.length ? clean(input.attr('value') ?? '', 80) : null;
}

/** The tracking table, newest first: each row gives a scan's wording, its place and its wall clock. */
function eventsOf($: CheerioAPI): CarrierEvent[] {
  const card = $('#collapse-tracking');
  if (card.length > 1) throw new SchemaError(PROVIDER, 'SkyBox returned several histories');
  const rows = card.find('table tbody tr').toArray();
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'SkyBox returned an invalid history');
  const events = rows.map((row): CarrierEvent => {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 300));
    const [description, location, clock] = cells;
    if (cells.length !== 3 || !description || clock === undefined) throw new SchemaError(PROVIDER, 'SkyBox returned an invalid scan');
    const staged = skyboxStage(description);
    return {
      local_time: wallClock(clock),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  // Newest first; the table lists them so, and a stable sort keeps scans of one minute in its order.
  return events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
}

/**
 * The fragment SkyBox's public tracking page loads for one number,
 * `/TrackingInformation/GetContentPublic?tracking=`, which its server renders.
 * Its search box carries the number asked. A known parcel has a skybill id,
 * a card with SkyBox's number, the number it arrived under, the reception
 * date, the suite, the origin, the destination, the consignee, the weight and
 * the items, a status bar and the tracking table. SkyBox's number must be the
 * one asked. An unknown number has the skybill id 0, one message and no card.
 * Only the tracking table is kept.
 */
export function parseSkybox(html: string, raw: string): CarrierResult {
  const number = normalizeSkyboxNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SkyBox answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  if ($('#trackinginfo-search-content').length !== 1) throw new SchemaError(PROVIDER, 'SkyBox returned an unexpected page');
  const asked = field($, 'trackinginfosearch-txtTracking');
  if (!asked) throw new SchemaError(PROVIDER, 'SkyBox returned a fragment without the number asked');
  if (normalizeTrackingNumber(asked) !== number) throw new IndeterminateError(PROVIDER, 'SkyBox answered for another number');
  const skybill = field($, 'hdn_trackinginfosearch_skybillid');
  if (skybill === null || !/^\d+$/.test(skybill)) throw new SchemaError(PROVIDER, 'SkyBox returned a fragment without its skybill');
  const sections = $('.trackinginfosearch-section');

  if (Number(skybill) === 0) {
    const message = clean($('#search-msg').text(), 120);
    if (sections.length || message !== NOT_FOUND) throw new SchemaError(PROVIDER, 'SkyBox returned an unexpected fragment');
    throw new NotFoundError(PROVIDER, 'SkyBox does not know this number');
  }

  const shown = field($, 'trackinginfosearch-lblTrackingNumber');
  if (!sections.length || !shown || !SHOWN_NUMBER.test(shown)) throw new SchemaError(PROVIDER, 'SkyBox returned a parcel without its number');
  // The tracker also finds a parcel by the number it arrived under; only SkyBox's own number is taken.
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'SkyBox answered for another parcel');

  const events = eventsOf($);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}
