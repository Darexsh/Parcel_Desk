import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { ocasaStage } from './status.js';

export const PROVIDER = 'OCASA';
// A long history is about 15 kB of page.
export const OCASA_MAX_BYTES = 512 * 1024;
export const OCASA_ZONE = 'America/Argentina/Buenos_Aires';
// Letters and digits with at least one digit, as the tracker's layouts are:
// eleven or eighteen digits, or three letters and ten characters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{10,20}$/;
const MONTHS: Readonly<Record<string, number>> = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12,
};
// "23/NOV - 07:10 hs.": a day, a month and a clock, without a year.
const CLOCK = /^(\d{1,2})\/([A-Z]{3}) - (\d{1,2}):(\d{2}) hs\.?$/i;
// A leap day can need four years back.
const YEARS_BACK = 4;
// An event listed below another can carry a later clock: some first scans at
// a centre read twelve hours off the pickup they follow.
const LISTED_LATER_DAYS = 30;
const NOT_FOUND = 'No hay registros para mostrar.';
// The CAPTCHA step of the other tracker address, or a firewall or bot check's page.
const BLOCKED = /id="captchaform"|g-recaptcha|<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)|_cf_chl_opt|cf-turnstile/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** An OCASA number in capitals, as the tracker shows it; anything else is not one OCASA issues. */
export function normalizeOcasaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'OCASA numbers are ten to twenty letters and digits');
  return number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * An event's wall clock. The tracker gives a day, a month and a clock without
 * a year: the year is the latest that puts the clock no later than `bound`,
 * the day after the lookup in Argentina for the first event, and a month
 * after the event listed above it for the others. No offset is assigned.
 */
function wallClock(text: string, bound: string): string {
  const match = CLOCK.exec(text);
  const month = match ? MONTHS[match[2]!.toUpperCase()] : undefined;
  const [day, hour, minute] = match ? [Number(match[1]), Number(match[3]), Number(match[4])] : [0, 0, 0];
  if (!match || !month || hour > 23 || minute > 59) throw new SchemaError(PROVIDER, 'OCASA returned an invalid event time');
  const latest = Number(bound.slice(0, 4));
  for (let year = latest; year >= latest - YEARS_BACK; year -= 1) {
    const date = calendarDay(year, month, day);
    const local = date ? `${date}T${pad(hour)}:${pad(minute)}:00` : '';
    if (local && local <= bound) return local;
  }
  throw new SchemaError(PROVIDER, 'OCASA returned an invalid event time');
}

/** A wall clock moved by whole days; UTC only does the calendar arithmetic. */
function plusDays(local: string, days: number): string {
  return DateTime.fromISO(local, { zone: 'UTC' }).plus({ days }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

// The delivery sentence names whoever took the parcel: "Entregamos el envio a … Gracias …".
const DELIVERED = /^Entregamos el env[ií]o\b/i;
const THANKS = /\bGracias por utilizar\b.*$/i;
// A clause naming who received or signed, or an ID, to the end of the sentence.
// A parcel "para ser recibido por la sucursal" is on its way to a branch.
const RECEIVER = /\s*[,;:\-–]?\s*(?<![\p{L}])(?:recibi[óo]|(?<!\bser )recibid[oa] por|firm[óo]|firmad[oa] por|D\.?N\.?I\.?|documento)(?![\p{L}])[\s\S]*$/iu;
// A run of seven or more digits, as phone and ID numbers are written.
const DIGITS = /\+?\d(?:[\s().-]{0,2}\d){6,}/g;
// The centre a sentence names in brackets after "OCASA": the same for every
// shipment wherever it goes, so it is no place.
const CENTRE = /\s*\([^()]*\)(?=\s*(?:[,.]|$|responsable\b))/giu;

/**
 * An event's sentence without what the tracker should not have put there: the
 * person a delivery was handed to, a receiver's clause, phone and ID numbers,
 * and the bracketed centre of a distribution centre's sentence.
 */
export function ocasaWording(sentence: string): string {
  let text = clean(sentence, 400);
  if (DELIVERED.test(text)) {
    const thanks = THANKS.exec(text)?.[0];
    text = `${text.match(DELIVERED)![0]}.${thanks ? ` ${thanks}` : ''}`;
  }
  text = text.replace(RECEIVER, '').replace(DIGITS, '');
  if (/centro de distribuci[óo]n/i.test(text)) text = text.replace(CENTRE, '');
  return clean(text.replace(/\s+([,;:.])/g, '$1'), 300).replace(/^[\s,;:.\-–]+/, '');
}

type Row = { heading: string; sentence: string; clock: string };

/** One event of the timeline: the newest has its own classes, the others share theirs. */
function rowOf(item: Cheerio<AnyNode>): Row {
  const heading = item.children('p.ultimoestado, p.estado');
  const clock = item.children('p.ultimahora, p.hora');
  const sentence = item.children('p.descripcion');
  if (heading.length !== 1 || clock.length !== 1 || sentence.length > 1) throw new SchemaError(PROVIDER, 'OCASA event layout changed');
  return { heading: clean(heading.text(), 200), sentence: clean(sentence.text(), 400), clock: clean(clock.text(), 40) };
}

/** Whether the page's location panel names an origin, a destination or an address. */
function hasDetails($: CheerioAPI): boolean {
  return ['.remitente', '.destinatario', '.direccion'].some((selector) => clean($(`.detalle ${selector}`).text(), 400) !== '');
}

/**
 * The page `TrackingOnline/index` renders for one number: the number it looked
 * up, the timeline of events, newest first, each with a heading, a day and a
 * clock, and a sentence, and a panel with the origin, the recipient and the
 * delivery address. A number it does not hold gets "No hay registros para
 * mostrar." in place of the timeline and an empty panel.
 */
export function parseOcasa(html: string, raw: string, now = Date.now()): CarrierResult {
  const number = normalizeOcasaNumber(raw);
  const $ = load(html);
  const shown = $('.tracking-number-container .tracking-number');
  if (!shown.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'OCASA answered with a CAPTCHA or block page');
    throw new SchemaError(PROVIDER, 'OCASA did not return a tracking page');
  }
  if (shown.length > 1) throw new SchemaError(PROVIDER, 'OCASA tracking page changed');
  // The tracker trims and capitalizes the number, and pads a short numeric one with zeros.
  if (normalizeTrackingNumber(clean(shown.text(), 80)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'OCASA answered for another number');
  }
  const timeline = $('.cardtimeline');
  if (timeline.length !== 1) throw new SchemaError(PROVIDER, 'OCASA tracking page changed');
  const items = timeline.find('ul.timeline > li');
  if (!items.length) {
    if (clean(timeline.find('h4').text(), 120) !== NOT_FOUND) throw new SchemaError(PROVIDER, 'OCASA returned a page without events or its notice');
    // A shipment the panel describes exists, even without an event yet.
    if (hasDetails($)) throw new NoHistoryError(PROVIDER);
    throw new NotFoundError(PROVIDER);
  }
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'OCASA returned an oversized history');

  // The page lists the events in the order they happened, newest first.
  let bound = DateTime.fromMillis(now, { zone: OCASA_ZONE }).plus({ days: 1 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  items.each((_, node) => {
    const row = rowOf($(node));
    const local = wallClock(row.clock, bound);
    bound = plusDays(local, LISTED_LATER_DAYS);
    const description = (row.sentence && ocasaWording(row.sentence)) || ocasaWording(row.heading);
    if (!description) throw new SchemaError(PROVIDER, 'OCASA returned an event without wording');
    const event: CarrierEvent = { local_time: local, description };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = ocasaStage(description, row.heading);
    if (staged) Object.assign(event, { stage: staged.stage, stage_source: staged.source });
    events.push(event);
  });

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
