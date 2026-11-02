import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { aymakanMappedStage, aymakanStage } from './status.js';

export const PROVIDER = 'AyMakan';
// The pages are 50 to 90 kB.
export const AYMAKAN_MAX_BYTES = 1_000_000;
// `AY` and nine to eleven digits; older shipments have a bare six-digit number.
const NUMBER = /^(?:AY\d{9,11}|\d{6})$/;
// Cloudflare's challenge and block pages, which the site's CDN can serve in place of the tracker.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|<title>\s*(?:Just a moment|Attention Required!)/i;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2})$/;
// Every weekday, month and day comes round within 28 years, 29 February included.
const CALENDAR_CYCLE_YEARS = 28;
const TRACKING = /^Tracking #:\s*(\S+)$/;
const NOT_FOUND = 'No shipment found';
// Who took the parcel, after a delivery's wording: "… - Received by {name}".
const RECEIVER = /\s*-\s*(?:received|collected|signed|retrieved) by\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A number for AyMakan's tracker, in capitals as the page shows it; anything else is not one it issues. */
export function normalizeAymakanNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AyMakan numbers are AY and nine to eleven digits, or six digits');
  return number;
}

/** A Cloudflare challenge or block page in place of the tracker. */
export function assertNotChallenged(html: string): void {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AyMakan answered with a browser check');
}

/**
 * The newest day a scan can carry: the lookup's day in Saudi Arabia, and one
 * more in case the page dates scans in a zone further east.
 */
export function latestScanDay(now: number): string {
  return DateTime.fromMillis(now, { zone: 'Asia/Riyadh' }).plus({ days: 1 }).toISODate()!;
}

/**
 * A scan's day, which the page writes "Sat, Apr 05", without a year. The year
 * is the latest one, not after `latest`, in which that day falls on that
 * weekday: a day comes round on the same weekday after five years at the
 * soonest, so a scan less than five years old is dated exactly.
 */
export function aymakanDay(label: string, latest: string): string {
  const match = DAY.exec(label);
  if (!match) throw new SchemaError(PROVIDER, 'AyMakan returned an invalid scan date');
  const month = MONTHS.indexOf(match[2]!) + 1;
  const weekday = WEEKDAYS.indexOf(match[1]!);
  const newest = Number(latest.slice(0, 4));
  for (let year = newest; year >= newest - CALENDAR_CYCLE_YEARS; year -= 1) {
    const day = calendarDay(year, month, Number(match[3]));
    if (day && day <= latest && new Date(`${day}T00:00:00Z`).getUTCDay() === weekday) return day;
  }
  throw new SchemaError(PROVIDER, 'AyMakan returned an invalid scan date');
}

/** A timeline entry's wording, without who took the parcel or a phone number. */
export function aymakanWording(text: string): string {
  return clean(clean(text, 500).replace(RECEIVER, '').replace(PHONE, ''), 300).replace(/[\s,;:\-–]+$/, '');
}

type Selection = ReturnType<CheerioAPI>;

/** The timeline's entries, newest first as the page lists them: a heading with the wording and the day under it. */
function eventsOf($: CheerioAPI, main: Selection, latest: string): CarrierEvent[] {
  const titles = main.find('h3').filter((_, heading) => clean($(heading).text(), 40) === 'Timeline');
  const timeline = titles.closest('aside');
  if (titles.length !== 1 || timeline.length !== 1) throw new SchemaError(PROVIDER, 'AyMakan returned a page without its timeline');
  const headings = timeline.find('h4').toArray();
  if (headings.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'AyMakan returned an oversized timeline');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const heading of headings) {
    const days = $(heading).siblings('p');
    const description = aymakanWording($(heading).text());
    if (days.length !== 1 || !description) throw new SchemaError(PROVIDER, 'AyMakan returned an invalid timeline entry');
    const day = aymakanDay(clean(days.text(), 40), latest);
    // Scans are dated to the day: the same wording twice on one day adds nothing.
    const key = `${day} ${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = aymakanStage(description);
    events.push({ local_time: day, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  return events;
}

/**
 * The tracker's page for one number, `aymakan.com/tracking/{number}`, which
 * the site renders on its server: the shipment's status over "Tracking #:" and
 * the number, a progress rail, the route, masked parties and the timeline. A
 * number it does not know gets "No shipment found" under its search form,
 * which keeps the number. The route, the rail and who took the parcel are not
 * kept. `now` is the lookup's time, which sets the years of the scans' days.
 */
export function parseAymakan(html: string, raw: string, now = Date.now()): CarrierResult {
  const number = normalizeAymakanNumber(raw);
  assertNotChallenged(html);
  const $ = load(html);
  const main = $('main');
  if (main.length !== 1) throw new SchemaError(PROVIDER, 'AyMakan returned an unexpected page');
  const searched = clean(main.find('form input').first().attr('value') ?? '', 64).toUpperCase();
  const labels = main.find('p').filter((_, line) => TRACKING.test(clean($(line).text(), 100)));
  if (labels.length === 0) {
    const missing = main.find('h3').filter((_, heading) => clean($(heading).text(), 60) === NOT_FOUND).length === 1;
    if (missing && searched === number) throw new NotFoundError(PROVIDER);
    if (missing) throw new IndeterminateError(PROVIDER, 'AyMakan answered for another search');
    throw new SchemaError(PROVIDER, 'AyMakan returned a page without a shipment');
  }
  if (labels.length > 1) throw new SchemaError(PROVIDER, 'AyMakan returned several shipments');
  const shown = TRACKING.exec(clean(labels.text(), 100))![1]!.toUpperCase();
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'AyMakan answered for another shipment');
  const summary = clean(labels.siblings('h3').text(), 120);
  if (!summary) throw new SchemaError(PROVIDER, 'AyMakan returned a shipment without its status');

  const events = eventsOf($, main, latestScanDay(now));
  const newest = events[0];
  // The status over the shipment is the carrier's current one; the newest scan
  // with a stage decides only a status the list does not know.
  const listed = aymakanMappedStage(summary);
  const scanned = events.find((event) => event.stage);
  const worded = listed || scanned ? null : aymakanStage(summary);
  const stage = (listed ?? scanned?.stage ?? worded?.stage) as Stage | undefined;
  const source = listed ? 'carrier_map' : scanned ? scanned.stage_source : worded?.source;
  if (!newest && !stage) throw new NoHistoryError(PROVIDER);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest?.description ?? summary,
    last_update: null,
    last_update_local: typeof newest?.local_time === 'string' ? newest.local_time : null,
    expected_delivery: null,
    ...(newest ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
