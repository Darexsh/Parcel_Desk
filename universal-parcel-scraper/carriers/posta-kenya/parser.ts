import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { postaKenyaStage } from './status.js';

export const PROVIDER = 'Posta Kenya';
// The pages are under 10 kB; a long history adds a few hundred bytes a scan.
export const POSTA_KENYA_MAX_BYTES = 512 * 1024;
/** The tracking page, an ASP.NET form that posts the number back to itself. */
export const POSTA_KENYA_TRACK = 'https://postglobal.posta.co.ke/postglobaltrack/Track.aspx';

const ZONE = 'Africa/Nairobi';
const MAX_ROWS = 1_000;
const FIELD = /^__[A-Z]{1,30}$/;
const MAX_FIELD_LENGTH = 50_000;
// The form's answer opens the result in a popup when the tracker holds the item.
const POPUP = /PopupCenter\('([^'\\]{1,200})',\s*'ResultSummary'/;
const RESULT_PAGE = /^TrackResult\.aspx\?type=[A-Za-z]{1,4}$/;
const ALERT = /alert\('([^'\\]{1,200})'\)/;
const NO_INFORMATION = 'No information available for this shipment';
// The result page's notice when the session holds no lookup.
const NO_SESSION = 'Tracking information is not available';
// "Tuesday, July 3, 2018", heading a day's scans.
const DAY_FORMAT = 'cccc, LLLL d, yyyy';
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// The details of a scan that are kept: why an item was not delivered or was held, and what happens next.
const DETAIL = /^(?:Reason|Measure|Retention reason)\s*:\s*(.+)$/i;
// A place ending with its country in brackets: "NAIROBI CITY SQUARE (Kenya)".
const PLACE = /^(.*?)\s*\(([^()]{2,60})\)$/;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// ASP.NET's error page.
const SERVER_ERROR = /<title>\s*Runtime Error\s*<\/title>|Server Error in '\/[^']*' Application/i;

/**
 * Posta Kenya's tracker looks up UPU S10 item codes: its own, ending KE, and
 * those of the posts that send mail to Kenya. The code needs a valid check digit.
 */
export function normalizePostaKenyaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Posta Kenya tracks S10 item codes');
}

/** Whether a page is ASP.NET's error page. */
export function isPostaKenyaErrorPage(html: string): boolean {
  return SERVER_ERROR.test(html.slice(0, 64_000));
}

/** A page without what the tracker's has: a block page, ASP.NET's error page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Posta Kenya answered with a block page');
  if (isPostaKenyaErrorPage(html)) throw new SchemaError(PROVIDER, 'Posta Kenya’s tracker failed with its error page');
  throw new SchemaError(PROVIDER, message);
}

/** The text of the page's own scripts; an attribute's handler is not one. */
function scripts($: CheerioAPI): string[] {
  return $('script').map((_, node) => $(node).text()).get();
}

/** What the form posts to look a code up, as pressing Enter in its field sends it. */
export function postaKenyaFormFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = $('form#form1');
  if (form.length !== 1 || form.find('input[name="txtID"]').length !== 1 || form.find('input[name="ImgBtnTrack"][type="image"]').length !== 1) {
    unexpected(html, 'Posta Kenya returned a tracking page without its form');
  }
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (FIELD.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(PROVIDER, 'Posta Kenya returned a tracking page without its state');
  }
  fields.set('txtID', number);
  fields.set('ImgBtnTrack.x', '0');
  fields.set('ImgBtnTrack.y', '0');
  return fields;
}

/**
 * The form's answer: the form again with the code in its field, and a script
 * that either opens the result page in a popup or alerts that the tracker has
 * no information for the code, which is not found. Returns the result page's
 * address, which the session the answer opened holds the item for.
 */
export function parsePostaKenyaAnswer(html: string, rawNumber: string): string {
  const number = normalizePostaKenyaNumber(rawNumber);
  const $ = load(html);
  const field = $('form#form1 input[name="txtID"]');
  if (field.length !== 1) unexpected(html, 'Posta Kenya returned a tracking page without its form');
  if (normalizeTrackingNumber(field.attr('value') ?? '') !== number) throw new SchemaError(PROVIDER, 'Posta Kenya answered for a different item');
  const code = scripts($).join('\n');
  const popup = POPUP.exec(code)?.[1];
  if (popup !== undefined) {
    if (!RESULT_PAGE.test(popup)) throw new SchemaError(PROVIDER, 'Posta Kenya opened an unexpected result page');
    return new URL(popup, POSTA_KENYA_TRACK).href;
  }
  const notice = ALERT.exec(code)?.[1];
  if (notice === NO_INFORMATION) throw new NotFoundError(PROVIDER);
  if (notice !== undefined) throw new SchemaError(PROVIDER, 'Posta Kenya’s tracker answered with an unexpected notice');
  unexpected(html, 'Posta Kenya’s tracker did not answer the lookup');
}

/** The lines of a cell, a `<br>` ending each. */
function linesOf(cell: Cheerio<AnyNode>): string[] {
  const copy = cell.clone();
  copy.find('br').replaceWith('\n');
  return copy.text().split('\n').map((line) => clean(line, 200));
}

/** The calendar day a heading names, its weekday included. */
function dayOf(text: string): string {
  const day = DateTime.fromFormat(text, DAY_FORMAT, { locale: 'en-US', zone: 'UTC' });
  if (!day.isValid || day.year < 2000) throw new SchemaError(PROVIDER, 'Posta Kenya returned an invalid scan date');
  return day.toFormat('yyyy-MM-dd');
}

/**
 * When a scan happened, to the minute. A scan the page places in Kenya is on
 * Nairobi's clock, which has no summer time; any other scan, abroad or without
 * a country, keeps its wall clock.
 */
function clockOf(day: string, text: string, kenya: boolean): { time: string } | { local_time: string } {
  const match = CLOCK.exec(text);
  if (!match) throw new SchemaError(PROVIDER, 'Posta Kenya returned an invalid scan time');
  const wall = `${day}T${match[1]}:${match[2]}:00`;
  const zoned = kenya ? zonedTime(wall, "yyyy-MM-dd'T'HH:mm:ss", ZONE) : null;
  return zoned ? { time: zoned.iso } : { local_time: wall };
}

/** A place's office and its country, which the page names in brackets after it when it knows it. */
function placeOf(text: string): { office: string; country: string; code: string | null } {
  const match = PLACE.exec(text);
  const code = match ? countryCode(match[2]) : null;
  return match && code ? { office: match[1]!, country: clean(match[2], 60), code } : { office: text, country: '', code: null };
}

/**
 * One scan row: the event's name with its kept details, the place, and the
 * clock. The place's second line, the office the item came from or was bagged
 * to, is not read. An office written with a digit, a postcode or an office
 * number, is dropped, and the scan keeps its country. Who signed for the item
 * and their identity document are never read.
 */
function scanOf(day: string, cells: Cheerio<AnyNode>): CarrierEvent {
  const [wording = '', ...rest] = linesOf(cells.eq(0));
  if (!wording) throw new SchemaError(PROVIDER, 'Posta Kenya returned a scan without wording');
  const details = rest.map((line) => DETAIL.exec(line)?.[1]).filter((detail): detail is string => Boolean(detail))
    .map((detail) => clean(detail, 120));
  const place = placeOf(linesOf(cells.eq(1))[0] ?? '');
  const office = /\d/.test(place.office) ? '' : clean(place.office, 120);
  const location = [office, place.country].filter(Boolean).join(', ');
  const description = details.length ? `${wording}: ${details.join('; ')}` : wording;
  const staged = postaKenyaStage(wording);
  return {
    ...clockOf(day, clean(cells.eq(2).text(), 20), place.code === 'KE'),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The result page for one item, which opens in a popup: its details, then its
 * scans, oldest first, under a heading for each day. The details must name the
 * whole requested code; of the rest only the destination's country is read.
 * The sender, the addressee, who took delivery and the proof of delivery are
 * never read. A page whose session holds no lookup is inconclusive.
 */
export function parsePostaKenyaResult(html: string, rawNumber: string): CarrierResult {
  const number = normalizePostaKenyaNumber(rawNumber);
  const $ = load(html);
  const panel = $('div#myDiv > table');
  if (!panel.length) {
    if (scripts($).some((code) => code.includes(NO_SESSION))) {
      throw new IndeterminateError(PROVIDER, 'Posta Kenya’s result page no longer held the lookup', { reason: 'session_lost' });
    }
    unexpected(html, 'Posta Kenya returned a result page without the item');
  }
  if (panel.length !== 1) throw new SchemaError(PROVIDER, 'Posta Kenya returned several items for one code');
  const rows = panel.children('tbody').children('tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Posta Kenya returned an oversized history');
  let section: 'summary' | 'details' | 'events' = 'summary';
  let day: string | null = null;
  const items: string[] = [];
  let destination = '';
  const scans: CarrierEvent[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    const text = (index: number) => clean(cells.eq(index).text(), 200);
    if (cells.length === 1 && text(0) === 'Item Details') section = 'details';
    else if (cells.length === 1 && text(0) === 'Item Events') section = 'events';
    else if (section === 'details' && cells.length === 2) {
      if (text(0) === 'Shipment ID') items.push(text(1));
      if (text(0) === 'Destination') destination = text(1);
    } else if (section === 'events' && cells.length === 3) {
      if (text(1) === 'Event Location' && text(2) === 'Event Time') day = dayOf(text(0));
      else if (!day) throw new SchemaError(PROVIDER, 'Posta Kenya returned a scan without its day');
      else scans.push(scanOf(day, cells));
    }
  }
  if (section !== 'events') throw new SchemaError(PROVIDER, 'Posta Kenya returned a result page without its history');
  if (items.length !== 1) throw new SchemaError(PROVIDER, 'Posta Kenya returned a result page without one item');
  if (normalizeTrackingNumber(items[0]!) !== number) throw new SchemaError(PROVIDER, 'Posta Kenya answered for a different item');

  const seen = new Set<string>();
  const events = scans.filter((event) => {
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const country = placeOf(destination).code;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
