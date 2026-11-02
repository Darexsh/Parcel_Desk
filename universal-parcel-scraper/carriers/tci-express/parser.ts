import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { tciExpressStage } from './status.js';

export const PROVIDER = 'TCI Express';
// The page is about ninety kilobytes, most of it menus and scripts.
export const TCI_EXPRESS_MAX_BYTES = 1024 * 1024;
// TCI Express books and delivers within India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
const NUMBER = /^\d{9,10}$/;
const DAY = /^\d{2}-[A-Z]{3}-\d{4}$/i;
const DAY_FORMAT = 'dd-LLL-yyyy';
const CLOCK = /^\d{2}:\d{2}$/;
// Each table's title row, then its column headings.
const TABLES: Readonly<Record<string, string>> = {
  'Booking Information': 'Booking Station|Delivery Station|Booking Date|Packets|Weight|Expected Delivery Date',
  'Transhipment Information': 'From Station|To Station|Despatch Date|Time|Arrival Date|Time',
  'Delivery Information': 'Delivery Status|Delivery Date / Attempted Date',
};
// A station as the tables name it, "XLKH (LUCKNOW HUB)". The delivery station's
// cell adds a free-text note after a hyphen, which can be a phone number.
const STATION = /^([A-Z][A-Z0-9]{1,7}) ?\(([^()]{1,80})\)/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com|_Incapsula_Resource/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A TCI Express docket: nine or ten digits. Anything else is not a number TCI Express issues. */
export function normalizeTciExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TCI Express dockets are nine or ten digits');
  return number;
}

/** A day as the tables write it, "26-JUN-2024", as an ISO calendar day. */
function calendarDay(text: string): string {
  // Parsing in UTC checks the calendar alone; a day that reads back changed is not one.
  const parsed = DateTime.fromFormat(text, DAY_FORMAT, { zone: 'UTC', locale: 'en-US' });
  if (!DAY.test(text) || !parsed.isValid || parsed.toFormat(DAY_FORMAT, { locale: 'en-US' }).toUpperCase() !== text.toUpperCase()) {
    throw new SchemaError(PROVIDER, 'TCI Express returned an invalid date');
  }
  return parsed.toISODate();
}

/** A transhipment clock: an Indian wall clock to the minute, or its day alone when the time cell is empty. */
function scanClock(date: string, time: string): Pick<CarrierEvent, 'time'> & { local_time: string } {
  const day = calendarDay(date);
  if (!time) return { local_time: day };
  const local = `${day}T${time}`;
  const wall = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!CLOCK.test(time) || !wall.isValid || wall.toFormat("yyyy-MM-dd'T'HH:mm") !== local) {
    throw new SchemaError(PROVIDER, 'TCI Express returned an invalid scan time');
  }
  return { time: wall.toUTC().toISO({ suppressMilliseconds: true }), local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
}

/** A station's code and name, without the note the delivery station can carry. */
function station(text: string): string {
  const match = STATION.exec(text);
  if (!match) throw new SchemaError(PROVIDER, 'TCI Express returned an invalid station');
  return `${match[1]} (${clean(match[2])})`;
}

/** The rows of each table under its title, as cell texts, after checking its headings. */
function tables($: CheerioAPI, block: Cheerio<Element>): Map<string, string[][]> {
  const found = new Map<string, string[][]>();
  for (const table of block.find('table.table-custom').toArray()) {
    const rows = $(table).children('tbody').children('tr');
    const title = clean(rows.eq(0).text(), 80);
    const header = TABLES[title];
    if (!header || found.has(title)) throw new SchemaError(PROVIDER, 'TCI Express returned an unexpected table');
    const headings = rows.eq(1).children('th').map((_, cell) => clean($(cell).text(), 80)).get().join('|');
    if (headings !== header) throw new SchemaError(PROVIDER, `TCI Express returned an unexpected ${title} table`);
    const data = rows.slice(2);
    if (data.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TCI Express returned an oversized history');
    const width = header.split('|').length;
    found.set(title, data.toArray().map((row) => {
      const cells = $(row).children('td');
      if (cells.length !== width) throw new SchemaError(PROVIDER, `TCI Express returned an incomplete ${title} row`);
      return cells.map((_, cell) => clean($(cell).text(), 300)).get();
    }));
  }
  return found;
}

function weightKg(text: string): number | null {
  const weight = /^\d{1,6}(?:\.\d{1,3})?$/.test(text) ? Number(text) : 0;
  return weight > 0 ? weight : null;
}

/**
 * The page `track-your-shipment?trackshipment={docket}&dwb=dwb` answers for
 * one docket. The server renders a block under the form: the docket's number
 * and status line, then its booking, its transhipments between stations and
 * the results of its delivery runs. A docket the tracker does not know leaves
 * the block empty.
 */
export function parseTciExpress(html: string, raw: string): CarrierResult {
  const number = normalizeTciExpressNumber(raw);
  const $ = load(html);
  const results = $('section.track_doc > .container > .row');
  if (results.length !== 1 || $('#dwbno').length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TCI Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'TCI Express returned a page without its tracker');
  }
  const blocks = results.children('div.col-lg-12.col-md-12');
  if (blocks.length !== 1) throw new SchemaError(PROVIDER, 'TCI Express returned an unexpected number of dockets');
  const block = blocks.first();
  if (!block.children().length && !clean(block.text())) throw new NotFoundError(PROVIDER);
  const heading = block.children('div.track_num');
  // An older docket keeps only its delivery rows, without the heading that names it.
  if (!heading.length && block.find('table.table-custom').length) throw new IndeterminateError(PROVIDER, 'TCI Express answered without the docket number');
  const label = heading.find('td').filter((_, cell) => /^Docket Number:/i.test(clean($(cell).text())));
  if (heading.length !== 1 || label.length !== 1) throw new SchemaError(PROVIDER, 'TCI Express returned a docket without its number');
  const echoed = clean(label.find('b').first().text(), 32);
  if (!echoed) throw new SchemaError(PROVIDER, 'TCI Express returned a docket without its number');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'TCI Express answered for another docket');

  const found = tables($, block);
  const booking = found.get('Booking Information') ?? [];
  if (booking.length > 1) throw new SchemaError(PROVIDER, 'TCI Express returned more than one booking');
  // Oldest first: the booking, then each transhipment's despatch and arrival in
  // the page's order, then the delivery rows, which the page lists newest first.
  const scans: CarrierEvent[] = [];
  let expected: string | null = null;
  let weight: number | null = null;
  for (const [from, , date, , kilograms, estimate] of booking) {
    scans.push({ local_time: calendarDay(date!), location: station(from!), description: 'Booked' });
    expected = estimate ? calendarDay(estimate) : null;
    weight = weightKg(kilograms!);
  }
  for (const [from, to, despatchDate, despatchTime, arrivalDate, arrivalTime] of found.get('Transhipment Information') ?? []) {
    const next = station(to!);
    scans.push({ ...scanClock(despatchDate!, despatchTime!), location: station(from!), description: `Despatched to ${next}` });
    // A leg still on the road has no arrival yet.
    if (arrivalDate) scans.push({ ...scanClock(arrivalDate, arrivalTime!), location: next, description: 'Arrived' });
    else if (arrivalTime) throw new SchemaError(PROVIDER, 'TCI Express returned an arrival time without its day');
  }
  for (const [wording, date] of (found.get('Delivery Information') ?? []).reverse()) {
    const description = clean(wording!.replace(PHONE, ' '), 300);
    if (!description) throw new SchemaError(PROVIDER, 'TCI Express returned a delivery row without wording');
    scans.push({ local_time: calendarDay(date!), description });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Days in order; within a day, the order above: the delivery rows have no time.
  const ordered = scans.map((scan, index) => ({ scan, index, day: String(scan.local_time).slice(0, 10) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const { scan } of ordered.reverse()) {
    const key = JSON.stringify([scan.local_time, scan.description, scan.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = tciExpressStage(scan.description!);
    events.push({ ...scan, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const finished = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time,
    expected_delivery: finished ? null : expected,
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
