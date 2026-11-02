import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { glsItalyEnglish, glsItalyRailStage, glsItalyScanStage } from './status.js';

export const PROVIDER = 'GLS Italy';
const ZONE = 'Europe/Rome';

// A national shipment number: the sending depot's two characters, a letter and
// a letter or digit, then at most nine digits, as the tracker's form asks.
const NUMBER = /^[A-Z][A-Z0-9]\d{1,9}$/;
// The tracker's notice for a number it does not know, in English and Italian.
const ABSENT = /^(?:Unfortunately there are no results\.|Non sono stati trovati risultati\.)/;
const MAX_ROWS = 50;
const MAX_SCANS = 500;
const MAX_EVENTS = 100;

/** A national shipment number as GLS Italy's tracker takes it: depot code and digits, without the space. */
export function normalizeGLSItalyNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'GLS Italy tracks national shipment numbers: a two-character depot code and up to nine digits');
  }
  return number;
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function shipmentNumber(row: JsonObject): string {
  return typeof row.tuNo === 'string' ? returnedTrackingNumber(row.tuNo) : '';
}

/** The row's own count of parcels: the first row of a several-row reply is the shipment the page shows above its parcels. */
function isShipmentOverview(row: JsonObject): boolean {
  return records(row.infos).some((info) => info.type === 'TOTALAMOUNT');
}

/**
 * The reply's row for the requested shipment. A shipment of one parcel comes
 * back as one row; the page reads a reply of several rows as the shipment
 * first, then its parcels.
 */
function shipmentRow(rows: JsonObject[], number: string): JsonObject {
  const matching = rows.filter((row) => shipmentNumber(row) === number);
  if (rows.length > 1 && matching[0] === rows[0] && isShipmentOverview(rows[0]!)) return rows[0]!;
  if (matching.length === 1) return matching[0]!;
  throw new SchemaError(PROVIDER, matching.length ? 'GLS Italy returned an ambiguous shipment' : 'GLS Italy returned a different shipment');
}

/**
 * A scan's clock, from its separate date and time. The national search only
 * answers for shipments inside GLS Italy's network, so a timed scan is read in
 * Italian time. A scan with only a date, and an hour the clocks skip, keep the
 * reply's digits as a local clock.
 */
function scanClock(row: JsonObject): { time: string } | { local_time: string } {
  const date = typeof row.date === 'string' ? row.date.trim() : '';
  // A scan without a clock carries an empty time.
  const time = typeof row.time === 'string' ? row.time.trim() : row.time ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (time !== '' && !(typeof time === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(time)))) {
    throw new SchemaError(PROVIDER, 'GLS Italy returned an invalid scan clock');
  }
  // UTC only checks the calendar and clock fields; no offset is assigned.
  const parsed = DateTime.fromISO(time ? `${date}T${time}` : date, { zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'GLS Italy returned an invalid scan clock');
  if (!time) return { local_time: date };
  const local = parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const zoned = zonedTime(local, "yyyy-MM-dd'T'HH:mm:ss", ZONE);
  return zoned?.iso.startsWith(local) ? { time: zoned.iso } : { local_time: local };
}

/** The shipment's weight as the page prints it ("0,8 Kg"). */
function weight(row: JsonObject): number | null {
  const info = records(row.infos).find((entry) => entry.type === 'WEIGHT');
  const match = /^(\d{1,5}(?:,\d{1,3})?) ?kg$/i.exec(clean(info?.value, 32));
  const kilograms = match ? Number(match[1]!.replace(',', '.')) : Number.NaN;
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

/**
 * The tracker's reply for one national shipment: its scans, newest first as
 * the page lists them, each with its sentence, town and wall clock. The
 * addresses, the signer, the note beside a delivery (the masked name of who
 * took it) and the customer's references are never read.
 */
export function parseGLSItaly(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGLSItalyNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.tuStatus)) throw new SchemaError(PROVIDER, 'GLS Italy returned an invalid tracking reply');
  if (payload.tuStatus.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GLS Italy returned too many shipments');
  const rows = records(payload.tuStatus);
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'GLS Italy returned no shipment');
  const row = shipmentRow(rows, number);
  if (!Array.isArray(row.history) || row.history.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'GLS Italy returned an invalid scan list');
  if (!row.history.length) throw new NoHistoryError(PROVIDER);

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const scan of row.history) {
    if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'GLS Italy returned an invalid scan');
    const sentence = textFromHtml(scan.evtDscr, 500);
    if (!sentence) throw new SchemaError(PROVIDER, 'GLS Italy returned a scan without wording');
    // The English locale was asked: an Italian sentence shows the English one.
    const description = glsItalyEnglish(sentence) ?? sentence;
    const clock = scanClock(scan);
    // The town of the depot, the hub or the delivery; the street and the note are not read.
    const location = isRecord(scan.address) ? textFromHtml(scan.address.city, 120) : '';
    const key = JSON.stringify([clock, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = glsItalyScanStage(description);
    events.push({ ...clock, description, ...(location ? { location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
  }
  const latest = events[0]!;
  const progress = isRecord(row.progressBar) ? row.progressBar : {};
  const rail = typeof progress.statusInfo === 'string' ? glsItalyRailStage(progress.statusInfo.trim()) : undefined;
  // GLS's return flag outranks any forward step. Otherwise the newest scan
  // says where the parcel is, and the rail stands in when its sentence says
  // nothing the map or the shared rules read.
  const current: ClassifiedWording | null = progress.retourFlag === true ? { stage: 'returned', source: 'carrier_map' }
    : latest.stage ? { stage: latest.stage as ClassifiedWording['stage'], source: latest.stage_source! }
      : rail ? { stage: rail, source: 'carrier_map' } : null;
  const kilograms = weight(row);
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(kilograms !== null ? { weight_kg: kilograms } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}

/**
 * The tracker's reply to a lookup. Its 404 with the no-results notice is the
 * only missing shipment; any other error reply leaves the answer open.
 */
export function parseGLSItalyReply(status: number, payload: unknown, raw: string): CarrierResult {
  const number = normalizeGLSItalyNumber(raw);
  if (status === 404) {
    const notice = isRecord(payload) ? textFromHtml(payload.exceptionText, 400) : '';
    if (ABSENT.test(notice) && !(isRecord(payload) && 'tuStatus' in payload)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'GLS Italy answered with an error instead of the shipment');
  }
  if (isRecord(payload) && !('tuStatus' in payload) && 'exceptionText' in payload) {
    throw new IndeterminateError(PROVIDER, 'GLS Italy answered with an error instead of the shipment');
  }
  return parseGLSItaly(payload, number);
}
