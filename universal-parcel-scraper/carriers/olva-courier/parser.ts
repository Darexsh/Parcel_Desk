import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { olvaStage } from './status.js';

export const PROVIDER = 'Olva Courier';
// The page is about forty kilobytes, its data included.
export const OLVA_MAX_BYTES = 1024 * 1024;

// The tracker answers shipments of this year and the five before it.
const YEARS_KEPT = 6;
const NOT_FOUND = 'No se encontró información para el criterio proporcionado.';
// The data the page renders, which WordPress writes on one line of a script.
const DATA = /^var OlvaTracking = (\{.*\});\s*$/m;
// Bot checks the host, or a CDN in front of it, could put in place of the page.
const CHALLENGE = /sgcaptcha|captcha|cf-turnstile|_cf_chl_opt|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 - Forbidden)/i;
// Olva's own number as its tracker returns it: the year, a hyphen and an eight-digit serial.
const OLVA_NUMBER = /^(\d{2})-(\d{8})$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const WEIGHT = /^\d{1,5}(?:\.\d{1,3})?$/;
const MAX_EVENTS = 500;

/**
 * One lookup the tracker's search field takes: `q` as the page sends it, the
 * reading the tracker gives it and what its reply must name.
 */
export type OlvaQuery =
  | { q: string; kind: 'remito'; number: string }
  | { q: string; kind: 'guia_cliente' | 'cod_externo'; externalCode: string };

/**
 * The lookups for a number, in the order to ask them. Olva prints its own
 * numbers as the two-digit year, a hyphen and the serial, or the serial, a
 * hyphen and the year, and the tracker reads a number only with its hyphen.
 * Without it, nine or ten digits read both ways: the readings whose year the
 * tracker still keeps are asked, the later year first, as a parcel tracked
 * now is a recent one. AliExpress's guides, `ALI-OLVA` and eight digits, are
 * asked as the tracker's example writes them; written without `ALI-`, they
 * are the shipment's external code.
 */
export function olvaQueries(raw: string, now = Date.now()): OlvaQuery[] {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const guide = /^(ALI)?(OLVA\d{8})$/.exec(number);
  if (guide) {
    return guide[1] ? [{ q: `ALI-${guide[2]}`, kind: 'guia_cliente', externalCode: guide[2]! }]
      : [{ q: guide[2]!, kind: 'cod_externo', externalCode: guide[2]! }];
  }
  if (/^\d{9,10}$/.test(number)) {
    const year = new Date(now).getUTCFullYear() % 100;
    const readings = [[number.slice(0, 2), number.slice(2)], [number.slice(-2), number.slice(0, -2)]]
      .map(([issued, serial]) => ({ age: (year - Number(issued) + 100) % 100, number: `${issued}-${serial!.padStart(8, '0')}` }))
      .filter((reading) => reading.age < YEARS_KEPT)
      // Stable: for the same year, the year-first reading, the tracker's own form, comes first.
      .sort((left, right) => left.age - right.age);
    const queries = [...new Set(readings.map((reading) => reading.number))]
      .map((reading): OlvaQuery => ({ q: reading, kind: 'remito', number: reading }));
    if (queries.length) return queries;
  }
  throw new InvalidInputError(PROVIDER, 'Olva Courier tracks its own numbers of the last six years and AliExpress guides');
}

/** A text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number, optional = false): string {
  const value = row[key];
  if (optional && (value === null || value === undefined)) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Olva Courier returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The data the page renders for the number in its address. */
function pageData(page: string): Record<string, unknown> {
  const match = DATA.exec(page);
  if (!match) {
    if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Olva Courier answered with a browser check');
    throw new SchemaError(PROVIDER, 'Olva Courier returned a page without its tracking data');
  }
  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Olva Courier returned tracking data that is not JSON', { cause });
  }
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'Olva Courier returned invalid tracking data');
  return data;
}

/**
 * A scan's date and time, "08/05/2026" and "18:40:07": the wall clock of the
 * place in Peru that scanned it, with no zone. A time of 00:00:00 is a scan
 * the tracker kept only the day of.
 */
function wallClock(date: string, time: string): string {
  const day = DATE.exec(date);
  const valid = day ? calendarDay(Number(day[3]), Number(day[2]), Number(day[1])) : null;
  if (!valid || !TIME.test(time)) throw new SchemaError(PROVIDER, 'Olva Courier returned an invalid scan time');
  return time === '00:00:00' ? valid : `${valid}T${time}`;
}

interface Scan { event: CarrierEvent; index: number }

function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Olva Courier returned an invalid scan');
  const code = text(row, 'statusCode', 40, true).toUpperCase();
  // The page shows the description, else the title: the title is the same for every scan of a code.
  const description = text(row, 'description', 300, true) || text(row, 'title', 300, true);
  if (!description) throw new SchemaError(PROVIDER, 'Olva Courier returned a scan without wording');
  const local = wallClock(text(row, 'date', 16), text(row, 'time', 16));
  const location = text(row, 'location', 120, true);
  const staged = olvaStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, index };
}

/** Whether the reply is about the shipment asked for: Olva's own number, or the external code. */
function boundTo(tracking: Record<string, unknown>, query: OlvaQuery): string {
  const number = text(tracking, 'number', 16);
  if (!OLVA_NUMBER.test(number)) throw new SchemaError(PROVIDER, 'Olva Courier returned a shipment without its number');
  const same = query.kind === 'remito' ? number === query.number : text(tracking, 'externalCode', 64, true) === query.externalCode;
  if (!same) throw new SchemaError(PROVIDER, 'Olva Courier answered for a different shipment');
  return number;
}

/** The weight the page shows, in kilograms; anything else is left out. */
function weightOf(tracking: Record<string, unknown>): number | null {
  const value = cleanScalar(tracking.weight, 16);
  const unit = cleanScalar(tracking.unitOfWeight, 8).toUpperCase();
  const kg = unit === 'KG' && WEIGHT.test(value) ? Number(value) : 0;
  return kg > 0 ? kg : null;
}

/**
 * The tracking page `GET /?q=` renders for one lookup. Its script holds
 * `OlvaTracking`: how the tracker read the query, the query as it shows it,
 * and either the shipment or the message the page shows instead. The
 * shipment names Olva's own number, the external code it was booked under,
 * the recipient and the scans in groups by milestone. Only the number, the
 * code, the weight and the scans are read.
 */
export function parseOlvaPage(page: string, query: OlvaQuery, rawNumber: string): CarrierResult {
  const data = pageData(page);
  if (data.hasQuery !== '1' || text(data, 'display', 64) !== query.q) {
    throw new SchemaError(PROVIDER, 'Olva Courier did not look up the number asked');
  }
  if (text(data, 'queryType', 32) !== query.kind) throw new SchemaError(PROVIDER, 'Olva Courier read the number another way');
  const message = text(data, 'errorMsg', 300, true);
  if (data.trackingData === null || data.trackingData === undefined) {
    if (message === NOT_FOUND) throw new NotFoundError(PROVIDER);
    // A failure the page reports in place of the shipment is not a missing parcel.
    if (message) throw new IndeterminateError(PROVIDER, 'Olva Courier reported a lookup failure');
    throw new SchemaError(PROVIDER, 'Olva Courier returned neither a shipment nor a message');
  }
  if (!isRecord(data.trackingData) || !isRecord(data.trackingData.tracking) || !Array.isArray(data.trackingData.groups)) {
    throw new SchemaError(PROVIDER, 'Olva Courier returned an invalid shipment');
  }
  const tracking = data.trackingData.tracking;
  const number = boundTo(tracking, query);

  const rows: unknown[] = [];
  for (const group of data.trackingData.groups) {
    if (!isRecord(group) || !Array.isArray(group.events)) throw new SchemaError(PROVIDER, 'Olva Courier returned an invalid milestone');
    rows.push(...(group.events as unknown[]));
  }
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Olva Courier returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row, index);
    // A scan two milestones list is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock: the milestones do not list their scans in order. Scans at the
  // same clock keep the reply's order, reversed, and a day without a time comes before that day's clocks.
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : right.index - left.index);
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const weight = weightOf(tracking);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(weight ? { weight_kg: weight } : {}),
    ...(normalizeTrackingNumber(number) !== normalizeTrackingNumber(rawNumber) ? { canonical_tracking_number: number } : {}),
    events,
  };
}
