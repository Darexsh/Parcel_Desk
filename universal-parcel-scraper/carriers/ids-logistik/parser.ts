import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { EXPLICIT_OFFSET_PATTERN, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { AT_END_DEPOT_CODES, IDS_BORDERED, IDS_CODES, IDS_MP, IDS_STEPS } from './status.js';

export const PROVIDER = 'IDS Logistik';
// A shipment's reply is a few kilobytes.
export const IDS_MAX_BYTES = 256 * 1024;
// The partner list is about thirty kilobytes.
export const IDS_PARTNERS_MAX_BYTES = 512 * 1024;

const BERLIN = 'Europe/Berlin';
// The tracking form's own rule: 13 to 16 digits.
const NUMBER = /^\d{13,16}$/;
// "2026-10-16 14:32:00.000000", as PHP writes a date; the page reads it to the minute.
const WALL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/;
const MAX_SCANS = 500;
const MAX_PARTNERS = 1_000;
// The page shows only the older of two equal sentences less than five minutes apart.
const REPEAT_MS = 5 * 60_000;

/** A number for IDS's tracker; anything else is not one it issues. */
export function normalizeIdsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'IDS Logistik shipment numbers are 13 to 16 digits');
  return number;
}

/**
 * The recipient's postcode, which the tracking form asks for with every
 * number. The form drops characters other than letters, digits and spaces.
 */
export function normalizeIdsPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'postcode', 'IDS Logistik requires the recipient\'s postcode');
  if (!DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'IDS Logistik requires a valid recipient postcode');
  return postcode.replace(/-/g, '');
}

/** An optional code or identifier; an object, array, fraction or negative number is a changed reply. */
function text(row: JsonObject, key: string, maxLength = 64): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `IDS Logistik returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A clock of the reply, or null when it has none. A clock with an offset is
 * an instant; a wall clock without one is Germany's, where IDS works.
 */
function clockOf(value: unknown, name: string): DateTime | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `IDS Logistik returned an invalid ${name}`);
  const raw = clean(value, 40);
  if (EXPLICIT_OFFSET_PATTERN.test(raw)) {
    const instant = DateTime.fromISO(raw.replace(' ', 'T'), { setZone: true });
    // Luxon takes impossible offsets such as +25:00; real ones lie within fourteen hours of UTC.
    if (instant.isValid && Math.abs(instant.offset) <= 14 * 60) return instant;
    throw new SchemaError(PROVIDER, `IDS Logistik returned an invalid ${name}`);
  }
  const wall = WALL.exec(raw);
  const local = wall ? `${wall[1]}T${wall[2]}:${wall[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits; Luxon would roll 24:00 or 30 February over.
  if (!wall || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `IDS Logistik returned an invalid ${name}`);
  }
  return firstOccurrence(DateTime.fromISO(local, { zone: BERLIN }));
}

const iso = (time: DateTime) => time.toISO({ suppressMilliseconds: true })!;

/** The depot a header end names: `start` collects the shipment, `end` delivers it. */
function depotOf(header: JsonObject, key: 'start' | 'end'): string {
  const end = header[key];
  if (end === null || end === undefined) return '';
  if (!isRecord(end)) throw new SchemaError(PROVIDER, `IDS Logistik returned an invalid ${key} depot`);
  return text(end, 'depotId', 16);
}

/**
 * The partner list the tracking page reads (`GET /api/ids/partner`), as each
 * depot's town. Only the depot ids and towns are read.
 */
export function parseIdsPartners(payload: unknown): ReadonlyMap<string, string> {
  const rows = isRecord(payload) ? payload.partner : null;
  if (!Array.isArray(rows) || rows.length > MAX_PARTNERS) throw new SchemaError(PROVIDER, 'IDS Logistik returned an invalid partner list');
  const towns = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.city !== 'string' || typeof row.depot !== 'string') continue;
    const town = clean(row.city, 100);
    for (const depot of row.depot.split(/[\s,;/]+/)) if (depot && town) towns.set(depot, town);
  }
  return towns;
}

interface Scan { event: CarrierEvent; at: number; order: number }

/** The step of the page's progress rail the reply's `status` names. */
function stepOf(value: unknown): number {
  const step = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : value;
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) throw new SchemaError(PROVIDER, 'IDS Logistik returned an invalid status');
  return step;
}

/**
 * The reply of `POST https://www.ids-logistik.de/api/shipping/status`, the
 * lookup IDS's tracking page makes with the number and the recipient's
 * postcode, read as the page reads it: a scan is named by its status code,
 * else by its `mp` code at that code's depot, and the page hides the rest. A
 * shipment IDS has no record of under that number and postcode comes back
 * with no scans, no manifest, no header id and status 0, which the page
 * explains as no information yet: not found. `towns` gives each depot's town.
 */
export function parseIdsReply(payload: unknown, raw: string, rawPostcode: string, towns: ReadonlyMap<string, string> | null = null): CarrierResult {
  const number = normalizeIdsNumber(raw);
  const postcode = normalizeIdsPostcode(rawPostcode);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'IDS Logistik returned an invalid envelope');
  // The reply echoes the number and postcode it was asked for.
  if (normalizeTrackingNumber(text(payload, 'trackingNumber')) !== number) throw new SchemaError(PROVIDER, 'IDS Logistik answered for another shipment');
  const echoed = text(payload, 'zipCode', 16);
  if (echoed && deliveryPostcodeText(echoed) !== postcode) throw new SchemaError(PROVIDER, 'IDS Logistik answered for another postcode');
  const result = payload.result;
  // The page reads an empty list as no data too, but the lookup never answers an unknown number so.
  if (Array.isArray(result) && !result.length) throw new IndeterminateError(PROVIDER, 'IDS Logistik returned no shipment record');
  if (!isRecord(result)) throw new SchemaError(PROVIDER, 'IDS Logistik returned an invalid shipment record');
  const shipment = text(result, 'shipmentId');
  if (shipment && normalizeTrackingNumber(shipment) !== number) throw new SchemaError(PROVIDER, 'IDS Logistik answered for another shipment');
  const header = result.header;
  const rows = result.history;
  const errors = result.errors ?? [];
  if (!isRecord(header)) throw new SchemaError(PROVIDER, 'IDS Logistik returned an invalid shipment header');
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'IDS Logistik returned an invalid history');
  if (!Array.isArray(errors)) throw new SchemaError(PROVIDER, 'IDS Logistik returned invalid errors');
  const start = depotOf(header, 'start');
  const end = depotOf(header, 'end');
  const bordered = clockOf(header.bordered, 'manifest time');
  const known = header.id !== null && header.id !== undefined;
  let step = stepOf(result.status);

  const scans: Scan[] = [];
  const add = (at: DateTime, order: number, depot: string, named: { wording: string; stage: Stage }, code?: string) => {
    const town = depot ? towns?.get(depot) : undefined;
    scans.push({ at: at.toMillis(), order, event: { time: iso(at), ...(town ? { location: town } : {}), description: named.wording,
      stage: named.stage, stage_source: 'carrier_map', ...(code ? { provider_code: code } : {}) } });
  };
  const times = rows.map((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'IDS Logistik returned an invalid scan');
    const time = clockOf(row.time, 'scan time');
    if (!time) throw new SchemaError(PROVIDER, 'IDS Logistik returned a scan without its time');
    const code = text(row, 'code', 16);
    const coded = IDS_CODES.get(code);
    if (coded) {
      add(time, index, AT_END_DEPOT_CODES.has(code) ? end : text(row, 'depotId', 16), coded, code);
    } else {
      const depot = text(row, 'depotId', 16);
      const marked = IDS_MP.get(text(row, 'mp', 16));
      if (marked && depot && depot === (marked.depot === 'start' ? start : end)) {
        add(time, index, depot, marked);
        step = Math.max(step, marked.step);
      }
    }
    return time.toMillis();
  });
  if (bordered) {
    // The page lists the manifest before the first scan made at or after it.
    const next = times.findIndex((at) => at >= bordered.toMillis());
    add(bordered, (next < 0 ? times.length : next) - 0.5, start, IDS_BORDERED);
    step = Math.max(step, IDS_BORDERED.step);
  }
  // A shipment IDS holds without a scan the page shows is at its first step.
  if (!bordered && !scans.length && known) step = 1;

  // Newest first; a later row comes first on the same clock, as the page reverses the list.
  const ordered = scans.sort((left, right) => right.at - left.at || right.order - left.order);
  const events = ordered.filter((scan, index) => {
    const older = ordered[index + 1];
    return !older || older.event.description !== scan.event.description || Math.abs(scan.at - older.at) >= REPEAT_MS;
  }).map(({ event }) => event);

  const summary = IDS_STEPS[step] ?? null;
  if (!events.length && !summary) {
    if (errors.length) throw new IndeterminateError(PROVIDER, 'IDS Logistik reported an error for the lookup');
    if (!rows.length && !known) throw new NotFoundError(PROVIDER, 'IDS Logistik has no shipment under this number and postcode');
  }
  const scanned = events.find((event) => event.stage)?.stage as Stage | undefined;
  // The rail settles a delivery the scans the page shows have not reached.
  const stage = summary?.stage === 'delivered' && scanned !== 'delivered' ? 'delivered' : scanned ?? summary?.stage ?? 'registered';
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_status_text: events[0]?.description ?? summary?.label ?? IDS_STEPS[1]!.label,
    last_update: events[0]?.time ?? null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
