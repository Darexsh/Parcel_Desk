import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { cruzDelSurStage } from './status.js';

export const PROVIDER = 'Cruz del Sur';
// A long history is about 40 kB of page.
export const CRUZ_DEL_SUR_MAX_BYTES = 512 * 1024;
// Nine digits, which labels print as seven, a hyphen and two. The tracker
// refuses a NIC of zeros.
const NUMBER = /^(?!0+$)\d{9}$/;
const SHOWN = /^NIC\s*(\d{1,10})$/;
// "1- Despacho creado": the event's place in the line, then its wording.
const HEADING = /^\d{1,3}\s*-\s*(\S.*)$/;
const DATE = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^(\d{1,2}):(\d{2})\s*hs\.?$/i;
const NOT_FOUND = 'No existe NIC.';
// A firewall or bot check's page in place of the tracker's.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenges\.cloudflare\.com/i;
const MAX_EVENTS = 100;

/** A NIC as nine digits; anything else is not a number Cruz del Sur issues. */
export function normalizeCruzDelSurNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Cruz del Sur NICs are nine digits');
  return number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The section of the page under the given title, if there is exactly one. */
function section($: CheerioAPI, title: RegExp): Cheerio<AnyNode> | undefined {
  const boxes = $('div.text_box').filter((_, box) => $(box).find('div.title_section_3').toArray()
    .some((node) => title.test(clean($(node).text(), 120))));
  if (boxes.length > 1) throw new SchemaError(PROVIDER, 'Cruz del Sur tracking page changed');
  return boxes.length ? boxes.first() : undefined;
}

/** An event's wall clock: a day, then a clock to the minute when the page gives one. No offset is assigned. */
function wallClock(day: string, clock: string | undefined): string {
  const date = DATE.exec(day);
  const local = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!local) throw new SchemaError(PROVIDER, 'Cruz del Sur returned an invalid event date');
  if (clock === undefined) return local;
  const time = CLOCK.exec(clock);
  const [hour, minute] = time ? [Number(time[1]), Number(time[2])] : [24, 60];
  if (hour > 23 || minute > 59) throw new SchemaError(PROVIDER, 'Cruz del Sur returned an invalid event time');
  return `${local}T${pad(hour)}:${pad(minute)}:00`;
}

/**
 * One event of the tracking line: a heading, a day and usually a clock, and
 * the branch. Any other line under it is left out.
 */
function eventOf($: CheerioAPI, heading: Cheerio<AnyNode>): CarrierEvent {
  const wording = HEADING.exec(clean(heading.text(), 200))?.[1];
  const row = heading.parent();
  const clocks = row.find('input').toArray().map((node) => clean($(node).attr('value'), 40));
  if (!wording || clocks.length < 1 || clocks.length > 2) throw new SchemaError(PROVIDER, 'Cruz del Sur event layout changed');
  const event: CarrierEvent = { local_time: wallClock(clocks[0]!, clocks[1]), description: wording };
  const branch = row.find('label.secondary_color').filter((_, node) => /^Sucursal\s*:/i.test(clean($(node).text(), 200)));
  if (branch.length > 1) throw new SchemaError(PROVIDER, 'Cruz del Sur event layout changed');
  const location = clean(branch.find('span.primary_color').text(), 120);
  if (location) event.location = location;
  return event;
}

/**
 * The page `herramientas_seguimiento_resultado.php` renders for one NIC: a
 * title with the NIC, a panel with the loading date, the sender, the
 * recipient and their branches, and the tracking line, oldest event first. A
 * NIC it does not hold gets "No existe NIC." in place of all three.
 */
export function parseCruzDelSur(html: string, raw: string): CarrierResult {
  const number = normalizeCruzDelSurNumber(raw);
  const $ = load(html);
  const title = $('div.title_section_3').filter((_, node) => /^Datos del env[ií]o\b/i.test(clean($(node).text(), 120)));
  if (!title.length) {
    const notice = clean($('div.title_section_3 > span.red_color').first().text(), 200);
    if (notice === NOT_FOUND) throw new NotFoundError(PROVIDER);
    if (notice) throw new SchemaError(PROVIDER, 'Cruz del Sur answered with an unexpected notice');
    // The search form asks for a reCAPTCHA before it opens the result page.
    if ($('#formulario-seguimiento').length) throw new ChallengeError(PROVIDER, 'Cruz del Sur sent the lookup back to its reCAPTCHA form');
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Cruz del Sur answered with a block page');
    throw new SchemaError(PROVIDER, 'Cruz del Sur did not return a tracking page');
  }
  if (title.length > 1) throw new SchemaError(PROVIDER, 'Cruz del Sur tracking page changed');
  const shown = SHOWN.exec(clean(title.find('span.red_color').text(), 40))?.[1];
  if (!shown) throw new SchemaError(PROVIDER, 'Cruz del Sur tracking page changed');
  // The tracker reads the NIC as a number, so a leading zero may not be shown.
  if (shown.replace(/^0+/, '') !== number.replace(/^0+/, '')) throw new IndeterminateError(PROVIDER, 'Cruz del Sur answered for another NIC');

  const line = section($, /^L[ií]nea de seguimiento$/i);
  if (!line) throw new SchemaError(PROVIDER, 'Cruz del Sur tracking page changed');
  const headings = line.find('label.red_color');
  // A NIC the panel describes exists, even before its first event.
  if (!headings.length) throw new NoHistoryError(PROVIDER);
  if (headings.length > MAX_EVENTS * 3) throw new SchemaError(PROVIDER, 'Cruz del Sur returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  headings.each((_, node) => {
    const event = eventOf($, $(node));
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = cruzDelSurStage(event.description!);
    if (staged) Object.assign(event, { stage: staged.stage, stage_source: staged.source });
    events.push(event);
  });
  // The line runs oldest first, numbered in that order.
  events.reverse();

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
