import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { EXPLICIT_OFFSET_PATTERN, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { go4Stage, GO4_WORDING } from './status.js';

export const PROVIDER = 'GO4';
// One shipment's record is under a kilobyte.
export const GO4_MAX_BYTES = 64 * 1024;

const BRATISLAVA = 'Europe/Bratislava';
// The tracker's own rule: 1 and ten digits, or 2 and eleven.
const NUMBER = /^(?:1\d{9}|2\d{10})$/;
// "2021-02-01 13:26:00", as the reply writes its clocks.
const WALL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/;
// The zero date a MySQL column holds for a date it does not have.
const ZERO_DATE = /^0000-00-00(?:[ T]00:00(?::00)?)?$/;
const MAX_RECORDS = 50;
const MAX_ATTEMPTS = 100;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![\p{L}\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![\p{L}\d])/gu;

/** A number for GO4's tracker; anything else is not one it issues. */
export function normalizeGo4Number(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GO4 numbers are 1 and ten digits, or 2 and eleven');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GO4 returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Free text without phone numbers or the punctuation they leave behind. */
function withoutPhones(value: string): string {
  return clean(value.replace(PHONE, '')).replace(/\s+([,;:.])/g, '$1').replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * A clock of the reply, or null when the record has none. A clock with an
 * offset is an instant; a wall clock without one is Bratislava's, where GO4
 * works.
 */
function clockOf(row: Record<string, unknown>, key: string): DateTime | null {
  const raw = text(row, key, 40);
  if (!raw || ZERO_DATE.test(raw)) return null;
  if (EXPLICIT_OFFSET_PATTERN.test(raw)) {
    const instant = DateTime.fromISO(raw.replace(' ', 'T'), { setZone: true });
    // Luxon takes impossible offsets such as +25:00; real ones lie within fourteen hours of UTC.
    if (instant.isValid && Math.abs(instant.offset) <= 14 * 60) return instant;
    throw new SchemaError(PROVIDER, `GO4 returned an invalid ${key}`);
  }
  const wall = WALL.exec(raw);
  const local = wall ? `${wall[1]}T${wall[2]}${wall[3] ?? ':00'}` : '';
  // Parsing in UTC checks the calendar digits; Luxon would roll 24:00 or 30 February over.
  if (!wall || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `GO4 returned an invalid ${key}`);
  }
  return firstOccurrence(DateTime.fromISO(local, { zone: BRATISLAVA }));
}

const iso = (time: DateTime) => time.toISO({ suppressMilliseconds: true })!;

/** The shipment number a record names, or null for the tracker's empty record. */
function shipmentNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, 'GO4 returned an invalid shipment number');
    return String(value);
  }
  const number = typeof value === 'string' ? normalizeTrackingNumber(clean(value, 64)) : '';
  if (!number) throw new SchemaError(PROVIDER, 'GO4 returned an invalid shipment number');
  return number;
}

interface Scan { event: CarrierEvent; at: number }

function scan(time: DateTime, description: string): Scan {
  const staged = go4Stage(description);
  return { at: time.toMillis(), event: { time: iso(time), description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } };
}

/** The delivery attempts the page lists under "Predchádzajúce pokusy o doručenie", each with its reason. */
function attempts(record: Record<string, unknown>): Scan[] {
  const rows = record.kedyNedorucena ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'GO4 returned invalid delivery attempts');
  if (rows.length > MAX_ATTEMPTS) throw new SchemaError(PROVIDER, 'GO4 returned too many delivery attempts');
  return rows.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GO4 returned an invalid delivery attempt');
    const time = clockOf(row, 'Datum');
    if (!time) throw new SchemaError(PROVIDER, 'GO4 returned a delivery attempt without its date');
    const reason = withoutPhones(text(row, 'detailnyStatus'));
    return scan(time, reason ? `${GO4_WORDING.attempt}: ${reason}` : GO4_WORDING.attempt);
  });
}

/** The scans newest first; equal clocks keep the order the record's milestones come in. */
function newestFirst(scans: Scan[]): CarrierEvent[] {
  const seen = new Set<string>();
  return [...scans].sort((left, right) => right.at - left.at).filter(({ at, event }) => {
    const key = JSON.stringify([at, event.description]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ event }) => event);
}

/**
 * The reply of `GET https://getstatus.go4.eu/status.php`, the lookup GO4's
 * tracking page makes: a list holding one shipment's record. The page shows
 * the first record only, and reads a record whose `Zasielka_Kod` is null as
 * "Zásielka sa nenašla", which is not found. The record must name the whole
 * number asked.
 */
export function parseGo4(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGo4Number(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'GO4 returned an invalid envelope');
  if (!payload.length) throw new IndeterminateError(PROVIDER, 'GO4 returned no record for the number');
  if (payload.length > MAX_RECORDS) throw new SchemaError(PROVIDER, 'GO4 returned too many records');
  if (!payload.every(isRecord)) throw new SchemaError(PROVIDER, 'GO4 returned an invalid record');
  const record = payload[0]!;
  const asked = shipmentNumber(record.Zasielka_Kod);
  if (asked === null) throw new NotFoundError(PROVIDER);
  // The page follows whatever record comes first; a lookup only counts for the number asked.
  for (const other of payload) {
    const named = shipmentNumber(other.Zasielka_Kod);
    if (named !== null && named !== number) throw new IndeterminateError(PROVIDER, 'GO4 answered for another shipment');
  }

  const ordered = clockOf(record, 'DatumObjed');
  const collected = clockOf(record, 'DatumPrevz');
  const delivered = clockOf(record, 'DatumDoruc');
  const scans: Scan[] = [
    ...(delivered ? [scan(delivered, GO4_WORDING.delivered)] : []),
    ...attempts(record),
    ...(collected ? [scan(collected, GO4_WORDING.collected)] : []),
    ...(ordered ? [scan(ordered, GO4_WORDING.ordered)] : []),
  ];
  const events = newestFirst(scans);

  // The current status as the page writes it: the main status, then its detail.
  const main = withoutPhones(text(record, 'hlavnyStatus', 120));
  const detail = withoutPhones(text(record, 'detailnyStatus', 200));
  const status = [main, detail].filter(Boolean).join(' - ');
  if (!events.length && !status) throw new NoHistoryError(PROVIDER);
  const summary = main ? go4Stage(main)?.stage : undefined;
  const current = events.find((event) => event.stage);
  const scanned = current?.stage as Stage | undefined;
  // The status settles a delivery or a return the milestones have not reached, and stages a record without them.
  const settles = summary && (!scanned || ((summary === 'delivered' || summary === 'returned') && scanned !== 'delivered' && scanned !== 'returned'));
  const stage = settles ? summary : scanned;
  const source = settles && summary !== scanned ? 'carrier_map' : current?.stage_source;
  const done = stage === 'delivered' || stage === 'returned';
  const estimate = done ? null : clockOf(record, 'DateEstimatedDelivery');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: status || events[0]!.description!,
    last_update: events[0]?.time ?? null,
    expected_delivery: estimate ? iso(estimate) : null,
    ...(stage === 'delivered' && delivered ? { delivered_at: iso(delivered) } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
