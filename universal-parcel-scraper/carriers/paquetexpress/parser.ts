import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { paquetexpressHidden, paquetexpressKnown, paquetexpressLabel, paquetexpressStage } from './status.js';

export const PROVIDER = 'Paquetexpress';
// A parcel's history takes a few kilobytes.
export const PAQUETEXPRESS_MAX_BYTES = 1_000_000;
// Tracking codes are eleven to thirteen digits, with a digit of margin either
// way; a guía is the branch that issued it, two letters and its sequence. The tracker also takes
// shippers' references, which the adapter does not look up.
const TRACKING = /^\d{10,14}$/;
const GUIA = /^[A-Z]{3}\d{2}[A-Z]{2}\d{4,9}$/;
// The clock the backend keeps scans on: central Mexico's wall clock, which it
// now turns into `fechahora` at a fixed six hours behind UTC.
const STORED = FixedOffsetZone.instance(-360);
const CENTRAL = 'America/Mexico_City';
// How far a branch's clock (`hora`) runs from central Mexico's, in minutes:
// Baja California, Sonora and Sinaloa behind it, Quintana Roo ahead.
const BRANCH_SHIFTS: ReadonlySet<number> = new Set([-120, -60, 0, 60]);
const CLOCK = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
// The service's estimated day, such as "14 de Octubre del 2026".
const PROMISE = /^(\d{1,2})\s+de\s+(\p{L}+)\s+del?\s+(\d{4})$/iu;
const MONTHS: Readonly<Record<string, number>> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
// 2000-01-01T00:00:00Z: an earlier stamp is a placeholder, not a scan.
const MIN_STAMP = 946_684_800_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Stages whose estimated day the tracker shows; a parcel out for delivery
// keeps it only when the shipper asks the tracker to show it throughout. A
// parcel delivered or waiting at its branch has no estimate left.
const ESTIMATED: ReadonlySet<Stage> = new Set(['registered', 'accepted', 'in_transit']);

/** A tracking code or guía the service can look up; anything else is not one the adapter can track. */
export function normalizePaquetexpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw.trim()) : '';
  if (!TRACKING.test(number) && !GUIA.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Paquetexpress tracks its tracking codes and guías');
  }
  return number;
}

/** An optional text or number field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `Paquetexpress returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/**
 * A row's instant and clock. The backend stores each scan on central Mexico's
 * wall clock and returns it as `fechahora`, read at UTC-6 whatever the season,
 * so a scan from before Mexico ended daylight saving time reads an hour late:
 * the stored wall clock, read in Mexico City's zone, gives the instant. The
 * row's `hora` is the branch's own clock, which runs a whole number of hours
 * from central time; that difference sets the offset the clock is shown with.
 * The printed date can be a day off, so the date comes from `fechahora`.
 */
function scanTime(row: Record<string, unknown>): { time: string; timestamp: number } {
  const stamp = row.fechahora;
  if (typeof stamp !== 'number' || !Number.isSafeInteger(stamp) || stamp < MIN_STAMP) {
    throw new SchemaError(PROVIDER, 'Paquetexpress returned a row without a valid clock');
  }
  const stored = DateTime.fromMillis(stamp, { zone: STORED });
  const { year, month, day, hour, minute, second } = stored;
  const instant = firstOccurrence(DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: CENTRAL }));
  const clock = CLOCK.exec(text(row, 'hora', 16));
  let shift = 0;
  if (clock && Number(clock[1]) < 24) {
    const difference = (((Number(clock[1]) * 60 + Number(clock[2]) - hour * 60 - minute) % 1440) + 1440) % 1440;
    const signed = difference > 720 ? difference - 1440 : difference;
    if (BRANCH_SHIFTS.has(signed)) shift = signed;
  }
  const shown = instant.setZone(FixedOffsetZone.instance(instant.offset + shift));
  const time = shown.isValid ? shown.toISO({ suppressMilliseconds: true }) : null;
  if (!time) throw new SchemaError(PROVIDER, 'Paquetexpress returned a row without a valid clock');
  return { time, timestamp: instant.toMillis() };
}

/**
 * A row's wording as the tracker prints it, without the person it names. The
 * service appends the user who made a web-services label after "POR", the
 * sender a driver collected from after "A", and whoever took a delivery after
 * ", recibió". A code the map does not know is cut at the first of these.
 */
function wording(code: string, status: string): string {
  // The tracker repairs this one mis-encoded letter as well.
  const fixed = status.replaceAll('Ã³', 'ó');
  const cuts = paquetexpressKnown(code)
    ? [/,/, /(?:^|\s)POR\s/, ...(code === 'HCM' ? [/(?:^|\s)a\s/i] : [])]
    : [/[,:;]/, /(?:^|\s)(?:por|a)\s/i, /(?:^|\s)recib/i];
  let end = fixed.length;
  for (const cut of cuts) {
    const match = cut.exec(fixed);
    if (match && match.index < end) end = match.index;
  }
  return clean(fixed.slice(0, end), 200) || paquetexpressLabel(code) || code;
}

/** The estimated day, as `YYYY-MM-DD`, if the row's promise is a valid date. */
function promisedDay(row: Record<string, unknown>): string | null {
  const match = PROMISE.exec(text(row, 'promesa', 60));
  const month = match ? MONTHS[match[2]!.toLocaleLowerCase('es-MX')] : undefined;
  if (!match || !month) return null;
  const day = DateTime.fromObject({ year: Number(match[3]), month, day: Number(match[1]) }, { zone: 'UTC' });
  return day.isValid && day.year >= 2000 ? day.toISODate() : null;
}

interface Scan {
  readonly event: CarrierEvent & { time: string; description: string };
  readonly row: Record<string, unknown>;
  readonly timestamp: number;
  readonly quiet: boolean;
  readonly index: number;
  /** The tracking codes of the parcels whose history has this row. */
  readonly parcels: Set<string>;
}

/**
 * The row that sets the guía's stage: the newest that moves something, from
 * a parcel not yet delivered while one is, so one delivered parcel does not
 * settle the others.
 */
function decidingScan(scans: readonly Scan[]): Scan | undefined {
  const newestByParcel = new Map<string, Scan>();
  for (const scan of scans) {
    if (scan.quiet) continue;
    for (const parcel of scan.parcels) if (!newestByParcel.has(parcel)) newestByParcel.set(parcel, scan);
  }
  const open = [...newestByParcel.values()].filter((scan) => scan.event.stage !== 'delivered');
  return open.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index)[0]
    ?? scans.find((scan) => !scan.quiet);
}

/**
 * The history `GET /ptxws/rest/api/v1/guia/historico/{number}/{token}` returns
 * as a list of rows, oldest first: an empty list for a number it does not
 * know, and one error row when it refuses the tracker's token. It matches
 * tracking codes, guías and shippers' references, so a row counts only when
 * its tracking code, or its guía, is the number asked; a guía covers every
 * parcel on it. Each row's code, wording, clocks and place are read, with the
 * estimated day and delivery type of the newest. The shipper's reference, the
 * recipient's city and the names inside the wording are never read.
 */
export function parsePaquetexpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizePaquetexpressNumber(raw);
  if (!Array.isArray(payload) || payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Paquetexpress returned an unexpected reply');
  if (payload.length === 0) throw new NotFoundError(PROVIDER);
  if (!payload.every(isRecord)) throw new SchemaError(PROVIDER, 'Paquetexpress returned an invalid row');
  if (payload.some((row) => 'error' in row || 'errorDescripcion' in row)) {
    // "ERROR DE ACCESSO": the service refused the tracker's token, which says nothing about the number.
    throw new IndeterminateError(PROVIDER, 'Paquetexpress refused the tracking request');
  }
  const byCode = TRACKING.test(number);
  const rows = payload.filter((row) => (byCode ? text(row, 'rastreo', 40) : text(row, 'guia', 40).toUpperCase()) === number);
  // The number is another shipment's reference.
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'Paquetexpress answered with a shipment the number does not identify');

  // The parcels of one guía can repeat the rows they share; identical rows are kept once.
  const seen = new Map<string, Scan>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const code = text(row, 'eventoId', 16).toUpperCase();
    if (paquetexpressHidden(code)) continue;
    const { time, timestamp } = scanTime(row);
    const description = wording(code, text(row, 'status', 500));
    if (!description) throw new SchemaError(PROVIDER, 'Paquetexpress returned a row without a code or wording');
    const location = text(row, 'ciudadEvento', 200) || text(row, 'sucursal', 100);
    const event: Scan['event'] = { time, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}) };
    const parcel = text(row, 'rastreo', 40);
    const key = JSON.stringify(event);
    const repeated = seen.get(key);
    if (repeated) {
      repeated.parcels.add(parcel);
      continue;
    }
    const stage = paquetexpressStage(code, description, text(row, 'tipoEntrega', 20).toUpperCase());
    if (stage && stage !== 'quiet') Object.assign(event, { stage: stage.stage, stage_source: stage.source });
    const scan: Scan = { event, row, timestamp, quiet: stage === 'quiet', index: scans.length, parcels: new Set([parcel]) };
    seen.set(key, scan);
    scans.push(scan);
  }
  // Newest first; the tracker lists the reply reversed, so of equal clocks the later row is newer.
  scans.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const newest = scans[0];
  if (!newest) throw new NoHistoryError(PROVIDER);

  const moving = decidingScan(scans);
  const stage = moving?.event.stage as Stage | undefined;
  const showAlways = newest.row.confMostrarPromesaComercial === true;
  const promised = stage && (ESTIMATED.has(stage) || (stage === 'out_for_delivery' && showAlways)) ? promisedDay(newest.row) : null;
  // A day already behind the newest scan is no longer an estimate.
  const expected = promised && promised >= newest.event.time.slice(0, 10) ? promised : null;
  const events = scans.map((scan) => scan.event);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: moving!.event.stage_source } : {}),
    last_status_text: (moving ?? newest).event.description,
    last_update: newest.event.time,
    expected_delivery: expected,
    ...(stage === 'delivered' ? { delivered_at: moving!.event.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
