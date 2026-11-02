import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { aexStage } from './status.js';

export const PROVIDER = 'AEX';
// A short history is about 50 kB of page, most of it the site's own markup.
export const AEX_MAX_BYTES = 1024 * 1024;
// A guía is its series, up to three characters starting with a letter (`A` for most), then six
// to eighteen letters and digits, as AEX's API documentation sets them.
const NUMBER = /^[A-Z](?=[A-Z0-9]*\d)[A-Z0-9]{6,20}$/;
const MONTHS: Readonly<Record<string, number>> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12,
};
// A day's heading, "Martes, 05 de Diciembre del 2023", and an event's clock, "16:56:00".
const DAY = /^(?:\p{L}+,\s*)?(\d{1,2}) de (\p{L}+) del? (\d{4})$/u;
const CLOCK = /^(\d{2}):(\d{2}):(\d{2})$/;
const NOT_FOUND = /No se encuentra el n[uú]mero de seguimiento que ingresaste/i;
// The empty form, which the tracker also shows for a guía whose series it does not issue.
const PROMPT = /Ingres[aá] el n[uú]mero de gu[ií]a de transporte para ver los eventos/i;
// A firewall or bot check's page in place of the tracker.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)|g-recaptcha|hcaptcha/i;
// A run of seven or more digits, as phone and ID numbers are written.
const DIGITS = /\+?\d(?:[\s().-]{0,2}\d){6,}/g;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A guía in capitals, as the tracker shows it; anything else is not one AEX issues. */
export function normalizeAexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AEX guías are a series letter, then six to twenty letters and digits');
  return number;
}

/** An event's text without phone or ID numbers. */
export function aexWording(text: string): string {
  return clean(clean(text, 400).replace(DIGITS, '').replace(/\s+([,;:.])/g, '$1'), 300).replace(/^[\s,;:.\-–]+/, '');
}

/** A day's heading as a calendar day. */
function calendarOf(heading: string): string {
  const match = DAY.exec(heading);
  const month = match ? MONTHS[match[2]!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()] : undefined;
  const date = match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  if (!date || date < '2000-01-01') throw new SchemaError(PROVIDER, 'AEX returned an invalid event day');
  return date;
}

/** An event's wall clock on its day; the page names no zone, so no offset is assigned. */
function wallClock(day: string, text: string): string {
  const match = CLOCK.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw new SchemaError(PROVIDER, 'AEX returned an invalid event time');
  }
  return `${day}T${text}`;
}

/** One `.tracking-event-row`: its clock, the guía's state and the event. Its comment is not read. */
function rowOf(row: Cheerio<AnyNode>): { clock: string; state: string; event: string } {
  const clock = row.children('.tracking-hour');
  const content = row.children('.tracking-content');
  const state = content.children('.tracking-status');
  const event = content.children('.tracking-event');
  if (clock.length !== 1 || content.length !== 1 || state.length > 1 || event.length > 1) {
    throw new SchemaError(PROVIDER, 'AEX event layout changed');
  }
  return { clock: clean(clock.text(), 20), state: clean(state.text(), 200), event: clean(event.text(), 400) };
}

/** The heading of the history card, "Historial de eventos - Guía {guía}". */
function historyHeading($: CheerioAPI): Cheerio<AnyNode> {
  return $('.card-header').filter((_, node) => /^Historial de eventos\b/.test(clean($(node).text(), 200)));
}

/**
 * The page `tracking.php?guia=` renders on the server for one guía: a card headed with the guía
 * it looked up, then a progress rail and the events grouped under a heading for each day, newest
 * first. Each event has a clock, the guía's state, the event and sometimes a comment, which names
 * whoever took a delivery. An unknown guía gets a notice in place of the events; a guía whose
 * series the tracker does not know gets the empty form under an empty heading.
 */
export function parseAex(html: string, raw: string): CarrierResult {
  const number = normalizeAexNumber(raw);
  const $ = load(html);
  const heading = historyHeading($);
  if (!heading.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AEX answered with a CAPTCHA or block page');
    throw new SchemaError(PROVIDER, 'AEX did not return its tracking page');
  }
  if (heading.length > 1) throw new SchemaError(PROVIDER, 'AEX tracking page changed');
  const label = /^Gu[ií]a\b\s*(.*)$/u.exec(clean(heading.find('small').text(), 100));
  if (!label) throw new SchemaError(PROVIDER, 'AEX tracking page changed');
  const card = heading.parent();
  if (!label[1]) {
    if (PROMPT.test(clean(card.text(), 2_000))) throw new InvalidInputError(PROVIDER, 'AEX\'s tracker does not read this as one of its guías');
    throw new SchemaError(PROVIDER, 'AEX returned a page without the guía');
  }
  // The heading repeats the guía asked, in capitals and without spaces; it is the only identity on the page.
  if (normalizeTrackingNumber(label[1]).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'AEX answered for another guía');

  const notice = card.find('.alert').filter((_, node) => NOT_FOUND.test(clean($(node).text(), 300)));
  const timeline = card.find('#trackingDetalle .timeline-container');
  if (notice.length) {
    if (timeline.length) throw new SchemaError(PROVIDER, 'AEX returned both events and its not-found notice');
    throw new NotFoundError(PROVIDER);
  }
  if (timeline.length !== 1) throw new SchemaError(PROVIDER, 'AEX returned a page without events or its notice');

  let day = '';
  let rows = 0;
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const node of timeline.children().toArray()) {
    const child = $(node);
    if (child.is('.tracking-date-title')) {
      day = calendarOf(clean(child.text(), 80));
      continue;
    }
    if (!child.is('.tracking-event-row')) continue;
    if (!day) throw new SchemaError(PROVIDER, 'AEX listed an event before its day');
    if (++rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'AEX returned an oversized history');
    const row = rowOf(child);
    const local = wallClock(day, row.clock);
    const event = aexWording(row.event);
    const state = aexWording(row.state);
    const description = event || state;
    if (!description) throw new SchemaError(PROVIDER, 'AEX returned an event without wording');
    const key = JSON.stringify([local, state, event]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = aexStage(event, state);
    events.push({ local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // The timeline exists once AEX holds the guía; it is empty only until the first event.
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
