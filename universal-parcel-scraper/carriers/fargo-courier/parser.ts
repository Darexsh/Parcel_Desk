import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { FARGO_COURIER_INVOICE, fargoCourierStage } from './status.js';

export const PROVIDER = 'Fargo Courier';
// A waybill's page is about 25 kB.
export const FARGO_COURIER_MAX_BYTES = 512 * 1024;
const ZONE = 'Africa/Nairobi';
// Seven digits on older waybills, FCLIN and eight digits on later ones. The
// shape stays open to other prefixes; the reply must name the waybill asked.
const NUMBER = /^[A-Z]{0,6}\d{6,10}$/;
const HEADERS = ['Event Code', 'Event', 'Event Date', 'Event Time', 'Location'];
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
// One of Fargo's branches, all in Kenya, by its code: HDO is the Nairobi hub.
const BRANCH = /^[A-Z]{2,4}$/;
// The page the tracker answers a waybill it does not have with, and any
// failure of its own: HTTP 500 and no word about the waybill.
const FAILURE = /We could not complete your request/i;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|Sucuri WebSite Firewall|cloudproxy@sucuri|lsrecaptcha|g-recaptcha|h-captcha/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written. Manifest, run and invoice
// numbers are shorter, or follow letters or a hyphen.
const PHONE = /(?<![A-Z\d-])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Fargo waybill number in capitals, as the tracker prints it; anything else is not one it issues. */
export function normalizeFargoCourierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Fargo Courier waybills are six to ten digits, after letters on some');
  return number;
}

export function isFargoCourierChallenge(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

/**
 * A reply that is not a waybill's page: a bot check, or the tracker's error
 * page, which it shows for a waybill it does not have as for its own
 * failures, so it is inconclusive.
 */
export function fargoCourierFailure(html: string): never {
  if (isFargoCourierChallenge(html)) throw new ChallengeError(PROVIDER, 'Fargo Courier answered with a browser check');
  if (FAILURE.test(html.slice(0, 64_000))) {
    throw new IndeterminateError(PROVIDER, 'Fargo Courier could not complete the lookup, which is also its answer for a waybill it does not have');
  }
  throw new IndeterminateError(PROVIDER, 'Fargo Courier failed to answer the lookup');
}

/** The value next to a label in the waybill's summary, without the colon the page puts first. */
function field($: CheerioAPI, label: string): string | null {
  const headings = $('th').filter((_, node) => clean($(node).text(), 80) === label);
  if (headings.length !== 1) return null;
  const value = headings.first().next('td');
  return value.length ? clean(value.text(), 120).replace(/^:\s*/, '') : null;
}

interface Row { code: string; description: string; day: string; clock: string; location: string }

/** A wall clock checked digit by digit; Luxon would roll 24:00 over to the next day. */
function wallClock(row: Row): string {
  const day = DAY.exec(row.day);
  const clock = CLOCK.exec(row.clock);
  const wall = day && clock ? `${day[3]}-${day[2]}-${day[1]}T${clock[1]}:${clock[2]}:00` : '';
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!wall || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Fargo Courier returned an invalid scan time');
  }
  return wall;
}

/** The event table's rows, as the page lists them, newest first. */
function rows($: CheerioAPI): Row[] {
  const tables = $('table').filter((_, node) => $(node).find('thead th').map((__, cell) => clean($(cell).text(), 40)).get().join('|') === HEADERS.join('|'));
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Fargo Courier event table changed');
  const lines = tables.first().find('tbody > tr');
  if (lines.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Fargo Courier returned an oversized history');
  return lines.toArray().map((line) => {
    const cells = $(line).children('td');
    if (cells.length !== HEADERS.length) throw new SchemaError(PROVIDER, 'Fargo Courier event table changed');
    // The event's text comes in lines of sixty characters, broken at a space.
    cells.eq(1).find('br').replaceWith(' ');
    const [code, description, day, clock, location] = cells.toArray().map((cell) => clean($(cell).text(), 300));
    return { code: code!.toUpperCase(), description: description!, day: day!, clock: clock!, location: location! };
  });
}

/**
 * The tracker's page for one waybill: a summary, the proof of delivery, the
 * sender and receiver, and the waybill's events, newest first. Only the
 * events are kept. The page must name the waybill asked.
 */
export function parseFargoCourier(html: string, raw: string): CarrierResult {
  const number = normalizeFargoCourierNumber(raw);
  if (isFargoCourierChallenge(html)) throw new ChallengeError(PROVIDER, 'Fargo Courier answered with a browser check');
  const $ = load(html);
  const waybill = field($, 'Waybill Number');
  if (waybill === null) {
    if (FAILURE.test($('body').text())) fargoCourierFailure(html);
    throw new SchemaError(PROVIDER, 'Fargo Courier returned a page without a waybill');
  }
  // The tracker also finds a waybill by its parcels' labels, and prints the
  // waybill in the case it was entered in.
  if (waybill.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Fargo Courier answered for another waybill');

  const scans = rows($).filter((row) => row.code !== FARGO_COURIER_INVOICE);
  // Fargo works only in Kenya, which keeps one offset all year. A scan at
  // anything but a branch code leaves the whole history on wall clocks.
  const kenyan = scans.every((row) => BRANCH.test(row.location));
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of scans) {
    const description = clean(row.description.replace(PHONE, '').replace(/\s+([,;:.])/g, '$1'), 300).replace(/[\s,;:-]+$/, '');
    if (!description) throw new SchemaError(PROVIDER, 'Fargo Courier returned a scan without wording');
    const wall = wallClock(row);
    const time = kenyan ? zonedTime(wall, "yyyy-MM-dd'T'HH:mm:ss", ZONE)?.iso : undefined;
    const key = JSON.stringify([row.code, description, wall, row.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = fargoCourierStage(row.code, description);
    events.push({
      ...(time ? { time } : { local_time: wall }),
      ...(row.location ? { location: row.location } : {}),
      description,
      ...(row.code ? { provider_code: row.code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  const clock = (event: CarrierEvent) => String(event.time ?? event.local_time);
  const newestFirst = clock(events[0]!) < clock(events.at(-1)!) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const decider = newestFirst.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
