import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load } from 'cheerio';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { correosDeMexicoStage } from './status.js';

export const PROVIDER = 'Correos de México';
// The tracking page is about 15 kB, and a page with a long history under 50 kB.
export const CORREOS_DE_MEXICO_MAX_BYTES = 1_000_000;
export const CORREOS_DE_MEXICO_ORIGIN = 'https://www.correosdemexico.gob.mx';
const PAGE_PATH = '/SSLServicios/SeguimientoEnvio/Seguimiento.aspx';
/** The tracking page: a WebForms page that posts its form back to itself. */
export const CORREOS_DE_MEXICO_PAGE = `${CORREOS_DE_MEXICO_ORIGIN}${PAGE_PATH}`;

const ZONE = 'America/Mexico_City';
const MAX_ROWS = 500;
const MAX_FIELDS = 10;
const MAX_FIELD_LENGTH = 50_000;
const FIELD_NAME = /^__[A-Z]{1,30}$/;
const YEAR = /^\d{4}$/;
// The history's columns; the last, unheaded and printed white, is the event's
// sequence number in the item's whole history.
const HEADINGS = ['Fecha', 'Hora', 'Origen', 'Evento', ''];
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2}):(\d{2})$/;
const SEQUENCE = /^\d{1,6}$/;
const TOTAL = /^Total de eventos\s*:\s*(\d{1,6})$/;
// "No se encontró información relacionada conla guía: AA000000000MX", for the year asked.
const NO_INFORMATION = /^No se encontró información relacionada con\s?la guía:\s*([A-Z0-9]{1,40})$/i;
// The page the site shows while it is down, also where it redirects a failed request.
const MAINTENANCE = /Sitio temporalmente en Mantenimiento/i;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Web Page Blocked|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|FortiGuard|FortiWeb|incapsula|Incident ID/i;
// States wholly on central time, UTC−6 all year since Mexico dropped summer
// time in 2022, by the abbreviation the tracker prints after an office, with
// its accents, dots and spaces removed. Offices elsewhere, in states with
// several zones, and abroad keep their wall clocks.
const CENTRAL_STATES = new Set(['ags', 'camp', 'chis', 'cdmx', 'df', 'col', 'dgo', 'gto', 'gro', 'hgo', 'jal', 'mex', 'edomex',
  'mich', 'mor', 'oax', 'pue', 'qro', 'slp', 'tab', 'tlax', 'ver', 'yuc', 'zac']);
// Mexico City's own names, which the tracker can print without a comma before them.
const CAPITAL = new Set(['cdmx', 'df']);

/** Correos de México's tracker follows S10 item codes: its own, ending MX, and those other posts send to Mexico. */
export function normalizeCorreosDeMexicoNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Correos de México tracks S10 item codes');
}

/** The page's own address for one number, which answers for the current year. */
export function correosDeMexicoLookupUrl(number: string): string {
  return `${CORREOS_DE_MEXICO_PAGE}?guia=${encodeURIComponent(number)}`;
}

/** Whether a page is a firewall's or bot check's instead of the site's. */
export function isCorreosDeMexicoBlockPage(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** One history row, before it becomes an event. */
export interface CorreosDeMexicoScan {
  /** The event's place in the item's history, counted across years. */
  readonly sequence: number;
  /** Its wall clock, `yyyy-MM-ddTHH:mm:ss`. */
  readonly wall: string;
  readonly location: string;
  readonly description: string;
}

/** What the form posts back to ask for another year. */
export interface CorreosDeMexicoForm {
  readonly action: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** The tracking page's answer for one number and one year. */
export interface CorreosDeMexicoPage {
  /** The year it answered for. */
  readonly year: string;
  /** The older years its form offers, newest first. */
  readonly olderYears: readonly string[];
  readonly form: CorreosDeMexicoForm;
  /** That year's scans, or null when the page has no information on the number for it. */
  readonly scans: readonly CorreosDeMexicoScan[] | null;
}

/** The fields to post to look the number up for another year, as the page's search button does. */
export function correosDeMexicoYearFields(form: CorreosDeMexicoForm, number: string, year: string): URLSearchParams {
  return new URLSearchParams({ ...form.fields, __EVENTTARGET: 'Busqueda', __EVENTARGUMENT: '', Guia: number, Periodo: year });
}

function failedPage(html: string, message: string): never {
  if (isCorreosDeMexicoBlockPage(html)) throw new ChallengeError(PROVIDER, 'Correos de México answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

function scanOf(cells: readonly string[]): CorreosDeMexicoScan {
  const day = DAY.exec(cells[0] ?? '');
  const clock = CLOCK.exec(cells[1] ?? '');
  const date = day ? calendarDay(Number(day[3]), Number(day[2]), Number(day[1])) : null;
  if (!date || !clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3]) > 59) {
    throw new SchemaError(PROVIDER, 'Correos de México returned a scan without a valid clock');
  }
  const description = clean(cells[3], 300);
  if (!description) throw new SchemaError(PROVIDER, 'Correos de México returned a scan without wording');
  if (!SEQUENCE.test(cells[4] ?? '')) throw new SchemaError(PROVIDER, 'Correos de México returned a scan without its sequence number');
  return { sequence: Number(cells[4]), wall: `${date}T${clock[1]}:${clock[2]}:${clock[3]}`, location: clean(cells[2], 200), description };
}

/**
 * The tracking page after a lookup: the number it answered for, the year
 * selected in its form, that year's history or its no-information notice, and
 * the form's fields for asking another year.
 */
export function readCorreosDeMexicoPage(html: string, rawNumber: string, askedYear?: string): CorreosDeMexicoPage {
  const number = normalizeCorreosDeMexicoNumber(rawNumber);
  if (MAINTENANCE.test(html.slice(0, 64_000))) {
    throw new IndeterminateError(PROVIDER, 'Correos de México answered with its maintenance page', { reason: 'maintenance' });
  }
  const $ = load(html);
  const forms = $('form#form1');
  if (forms.length !== 1) failedPage(html, 'Correos de México did not return its tracking page');
  const form = forms.first();
  if (clean(form.attr('method'), 8).toUpperCase() !== 'POST') throw new SchemaError(PROVIDER, 'Correos de México tracking form changed');
  let action: URL;
  try { action = new URL(form.attr('action') ?? '', CORREOS_DE_MEXICO_PAGE); }
  catch { throw new SchemaError(PROVIDER, 'Correos de México tracking form changed'); }
  const query = [...action.searchParams.keys()];
  if (action.origin !== CORREOS_DE_MEXICO_ORIGIN || action.pathname.toLowerCase() !== PAGE_PATH.toLowerCase() || action.hash
    || !(query.length === 0 || (query.length === 1 && normalizeTrackingNumber(action.searchParams.get('guia') ?? '') === number))) {
    throw new SchemaError(PROVIDER, 'Correos de México tracking form changed');
  }

  const fields: Record<string, string> = {};
  const hidden = form.find('input[type="hidden"]');
  if (hidden.length > MAX_FIELDS) throw new SchemaError(PROVIDER, 'Correos de México tracking form changed');
  hidden.each((_, node) => {
    const name = $(node).attr('name') ?? '';
    const value = $(node).attr('value') ?? '';
    if (!FIELD_NAME.test(name) || value.length > MAX_FIELD_LENGTH || Object.hasOwn(fields, name)) {
      throw new SchemaError(PROVIDER, 'Correos de México tracking form changed');
    }
    fields[name] = value;
  });
  if (!fields.__VIEWSTATE || !fields.__EVENTVALIDATION || form.find('input#Busqueda[name="Busqueda"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'Correos de México tracking form changed');
  }

  const guia = form.find('input#Guia[name="Guia"]');
  if (guia.length !== 1) throw new SchemaError(PROVIDER, 'Correos de México tracking form changed');
  if (returnedTrackingNumber(guia.attr('value')) !== number) {
    throw new SchemaError(PROVIDER, 'Correos de México answered for a different number');
  }
  const options = form.find('select#Periodo[name="Periodo"] > option');
  const years = options.map((_, node) => clean($(node).attr('value'), 8)).get();
  const selected = options.filter('[selected]').map((_, node) => clean($(node).attr('value'), 8)).get();
  if (!years.length || years.length > 10 || !years.every(year => YEAR.test(year)) || selected.length !== 1) {
    throw new SchemaError(PROVIDER, 'Correos de México tracking form changed');
  }
  const year = selected[0]!;
  if (askedYear !== undefined && year !== askedYear) {
    throw new IndeterminateError(PROVIDER, 'Correos de México answered for another year than the one asked');
  }
  const olderYears = years.filter(other => other < year).sort().reverse();

  const message = clean($('#lblMensaje').text(), 200);
  const table = $('table#GDDatos');
  const page = (scans: readonly CorreosDeMexicoScan[] | null): CorreosDeMexicoPage =>
    ({ year, olderYears, form: { action: action.href, fields }, scans });
  if (!table.length) {
    const missing = NO_INFORMATION.exec(message);
    // Only the notice naming the whole number is a missing item, for that year.
    if (missing && normalizeTrackingNumber(missing[1]!) === number) return page(null);
    throw new IndeterminateError(PROVIDER, 'Correos de México did not answer the lookup');
  }
  if (table.length !== 1 || message) throw new SchemaError(PROVIDER, 'Correos de México returned an invalid history');
  const rows = table.find('tr');
  const headings = rows.first().children('th').map((_, node) => clean($(node).text(), 40)).get();
  if (JSON.stringify(headings) !== JSON.stringify(HEADINGS)) throw new SchemaError(PROVIDER, 'Correos de México history columns changed');
  const body = rows.slice(1);
  if (!body.length) throw new IndeterminateError(PROVIDER, 'Correos de México returned the number without a history', { reason: 'no_history' });
  if (body.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Correos de México returned an invalid history');
  const scans = body.map((_, row) => {
    const cells = $(row).children('td').map((__, cell) => $(cell).text()).get();
    if (cells.length !== HEADINGS.length) throw new SchemaError(PROVIDER, 'Correos de México history columns changed');
    return scanOf(cells.map(cell => clean(cell, 300)));
  }).get();
  const total = TOTAL.exec(clean($('#NumeroEventos').text(), 60));
  if (!total || Number(total[1]) !== scans.length) throw new SchemaError(PROVIDER, 'Correos de México returned an incomplete history');
  return page(scans);
}

/** The first event a set of scans holds, by the history's sequence; 1 is the item's first. */
export function firstSequence(scans: readonly CorreosDeMexicoScan[]): number {
  return Math.min(...scans.map(scan => scan.sequence));
}

/** Whether an office's scans are on central time: its state, after the last comma, is wholly on it. */
function onCentralTime(location: string): boolean {
  const comma = location.lastIndexOf(',');
  const tail = comma >= 0 ? location.slice(comma + 1) : location.split(' ').at(-1) ?? '';
  const state = tail.normalize('NFD').replace(/[\u0300-\u036f.\s]/g, '').toLowerCase();
  return CENTRAL_STATES.has(state) && (comma >= 0 || CAPITAL.has(state));
}

/** When the scan happened: on Mexico City's clock for an office on central time, else as a local wall clock. */
function clockOf(scan: CorreosDeMexicoScan): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  if (onCentralTime(scan.location)) {
    const placed = zonedTime(scan.wall, "yyyy-MM-dd'T'HH:mm:ss", ZONE);
    if (placed?.iso.startsWith(scan.wall)) return { time: placed.iso };
  }
  return { local_time: scan.wall };
}

/**
 * One item's history, from the scans of every year it was found in: newest
 * first, by wall clock and then by the history's sequence. A history that does
 * not reach the item's first event, because its earlier years are no longer
 * offered, is marked truncated.
 */
export function correosDeMexicoResult(scans: readonly CorreosDeMexicoScan[], rawNumber: string): CarrierResult {
  normalizeCorreosDeMexicoNumber(rawNumber);
  if (!scans.length) throw new SchemaError(PROVIDER, 'Correos de México returned an empty history');
  const seen = new Set<string>();
  // Within a day the sequence can put a scan before one clocked minutes
  // earlier at the same or the next office; the clocks give the order.
  const chronological = [...scans]
    .sort((left, right) => (left.wall < right.wall ? -1 : left.wall > right.wall ? 1 : left.sequence - right.sequence))
    .filter((scan) => {
      const identity = JSON.stringify([scan.wall, scan.location, scan.description]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  let returning = false;
  const events: CarrierEvent[] = chronological.map((scan) => {
    const classified = correosDeMexicoStage(scan.description);
    returning ||= classified?.stage === 'returned';
    // After the item is sent back, its counter wait and delivery are the sender's.
    const stage = returning && (classified?.stage === 'ready_for_pickup' || classified?.stage === 'delivered')
      ? { stage: 'returned' as const, source: 'carrier_map' } : classified;
    return { ...clockOf(scan), description: scan.description, ...(scan.location ? { location: scan.location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  }).reverse();

  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  // The office an item waits at is its pickup point. A delivered item was
  // collected there when it waited there last before the delivery.
  const earlier = events.slice(1);
  const waiting = stage === 'ready_for_pickup' ? latest
    : stage === 'delivered' && lastMovement(earlier) === 'ready_for_pickup'
      ? earlier.find(event => event.stage === 'ready_for_pickup')
      : undefined;
  const point = waiting?.location ?? '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time! }),
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    ...(stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(firstSequence(scans) > 1 ? { history_truncated: true } : {}),
    events,
  };
}
