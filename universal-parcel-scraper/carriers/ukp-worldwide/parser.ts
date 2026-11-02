import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { ukpStage } from './status.js';

export const PROVIDER = 'UKP Worldwide';
export const CARRIER = 'ukp-worldwide';
// A page is about 250 kB, most of it the site's theme.
export const UKP_MAX_BYTES = 1024 * 1024;

// The tracker looks a number up whole, in any case; only WHISU and nine digits are known, so any
// number of letters and digits is asked.
const NUMBER = /^(?=.*\d)[A-Z0-9]{8,30}$/;
// "13:12, 3rd Aug 2021": a wall clock to the minute, with no zone.
const CLOCK = /^(\d{1,2}):(\d{2}), (\d{1,2})(?:st|nd|rd|th) ([A-Za-z]{3,9}) (\d{4})$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const FOUND = 'Tracking results';
const NOT_FOUND = 'Nothing found';
const NOT_RECOGNISED = /the tracking number entered is not recognised/i;
const COLUMNS = ['Date', 'Tracking Event', 'Code', 'Location'];
// A US postcode after a state, "PA 17402", or alone.
const POSTCODE = /(?:^|\s+)\d{5}(?:-\d{4})?$/;
const MAX_EVENTS = 200;

/** A number for UKP Worldwide's tracker: letters and digits, upper case. */
export function normalizeUkpNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'UKP Worldwide numbers are letters and digits');
  return number;
}

/**
 * A row's wall clock. USPS's rows without a clock, such as "in transit to next
 * facility", come at 0:00 and keep their day alone.
 */
function wallClock(text: string): string {
  const parts = CLOCK.exec(text);
  const month = parts ? MONTHS.indexOf(parts[4]!.slice(0, 3).toLowerCase()) + 1 : 0;
  if (parts && month) {
    const [hour, minute, day, year] = [parts[1], parts[2], parts[3], parts[5]].map(Number) as [number, number, number, number];
    const date = calendarDay(year, month, day);
    if (date && year >= 2000 && hour <= 23 && minute <= 59) {
      return hour === 0 && minute === 0 ? date : `${date}T${String(hour).padStart(2, '0')}:${parts[2]}:00`;
    }
  }
  throw new SchemaError(PROVIDER, 'UKP Worldwide returned an invalid scan time');
}

/**
 * A row's place, each part once and without postcodes: USPS's rows give the
 * town twice around its postcode ("YORK,PA 17402,YORK,PA") and a facility's
 * name twice.
 */
function placeOf(location: string): string {
  const parts: string[] = [];
  for (const raw of location.split(',')) {
    const part = raw.trim().replace(POSTCODE, '').trim();
    if (part && !parts.some((kept) => kept.toUpperCase() === part.toUpperCase())) parts.push(part);
  }
  return parts.join(', ');
}

/** The table's rows, oldest first on the page, as scans newest first. */
function eventsOf($: CheerioAPI, table: ReturnType<CheerioAPI>): CarrierEvent[] {
  const header = table.find('thead tr').first().children('td, th').toArray().map((cell) => clean($(cell).text(), 40));
  if (header.join('|') !== COLUMNS.join('|')) throw new SchemaError(PROVIDER, 'UKP Worldwide returned an unexpected table');
  const rows = table.find('tbody tr').toArray();
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'UKP Worldwide returned an invalid history');
  const events = rows.map((row, index) => {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 300));
    if (cells.length !== COLUMNS.length) throw new SchemaError(PROVIDER, 'UKP Worldwide returned an invalid scan');
    const [clock, description, code, location] = cells as [string, string, string, string];
    if (!description) throw new SchemaError(PROVIDER, 'UKP Worldwide returned a scan without wording');
    const place = placeOf(location.slice(0, 200));
    const staged = ukpStage(description);
    const event: CarrierEvent = {
      local_time: wallClock(clock), description,
      ...(place ? { location: place } : {}),
      ...(code ? { provider_code: code.slice(0, 16) } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { event, index };
  });
  // Newest first; a day alone counts as the day's start, and rows of one clock keep the page's order.
  const key = (time: string) => (time.length === 10 ? `${time}T00:00:00` : time);
  return events.sort((left, right) => key(right.event.local_time!).localeCompare(key(left.event.local_time!)) || right.index - left.index)
    .map(({ event }) => event);
}

/**
 * The tracker's page for one number, `/tracking/?x=`, which its server
 * renders: "Tracking results" over a table of scans, oldest first, with a
 * time, wording, code and place, or "Nothing found" for a number it does not
 * recognise. The page does not repeat the number; the tracker looks up only
 * the whole number, so the answer belongs to the request.
 */
export function parseUkp(html: string, raw: string): CarrierResult {
  normalizeUkpNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'UKP Worldwide answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const headings = $('#left-area h2').toArray().map((heading) => clean($(heading).text(), 80));
  const tables = $('#left-area table');

  if (headings.includes(NOT_FOUND)) {
    if (tables.length || !NOT_RECOGNISED.test(clean($('#left-area').text(), 2_000))) {
      throw new SchemaError(PROVIDER, 'UKP Worldwide returned an unexpected page');
    }
    throw new NotFoundError(PROVIDER, 'UKP Worldwide does not recognise this number');
  }
  if (!headings.includes(FOUND)) throw new SchemaError(PROVIDER, 'UKP Worldwide returned a page without results');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'UKP Worldwide returned results without their table');

  const events = eventsOf($, tables);
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
