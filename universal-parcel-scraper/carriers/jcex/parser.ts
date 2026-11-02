import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { countryCode, countryTimeZone, firstOccurrence, usStateTimeZone, type ParsedTime } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jcexStage } from './status.js';

export const PROVIDER = 'JCEX';
// A long history is a few dozen kilobytes.
export const JCEX_MAX_BYTES = 512 * 1024;
// JCZ, ten digits and DH, as JCEX prints its waybills.
const NUMBER = /^JCZ\d{10}DH$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;
// JCEX works on Hangzhou's clock and writes its own rows on it; a row kept as
// a wall clock is read in it only to set aside future rows and its timeline.
const HOME_ZONE = 'Asia/Shanghai';
const HOME_OFFSET = '+08:00';
// A US place as USPS writes it: "TOWN, ST 00000", or a facility naming its state before its kind.
const US_STATE = /,\s*([A-Z]{2})\b/;
const US_FACILITY_STATE = /\s([A-Z]{2})\s*(?:\(USPS\)|(?:(?:NETWORK|REGIONAL|INTERNATIONAL)\s+)?DISTRIBUTION\s+CENTER)$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Once JCEX takes a parcel in, it writes a timeline up to the delivering partner: rows on one
// second of the minute, each a whole number of six minutes after the one before.
const TIMELINE_STEP_MS = 6 * 60_000;
const TIMELINE_ROWS = 3;
// How soon after the receipt its first rows come.
const TIMELINE_START_MS = 60_000;

/** A JCEX waybill number; anything else is a number its tracker is not asked for. */
export function normalizeJcexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'JCEX waybill numbers are JCZ, ten digits and DH');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `JCEX returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A place as JCEX writes it, "TOWN,TOWN,FR,00000" or "TOWN, ST 00000", without its postcode and each part once. */
function placeOf(location: string): string {
  const parts: string[] = [];
  for (const raw of location.split(',')) {
    const part = raw.trim().replace(/\s+\d{4,6}(?:-\d{4})?$/, '');
    if (!part || /^\d{4,6}(?:-\d{4})?$/.test(part) || part.toUpperCase() === parts.at(-1)?.toUpperCase()) continue;
    parts.push(part);
  }
  return parts.join(', ');
}

/**
 * The zone a row's place keeps. A bare country code is the place, even when
 * the row's country is another: JCEX files its Hong Kong hub's rows under the
 * destination with the destination's offset. A US place settles a zone
 * through its state.
 */
function placeZone(location: string, country: string): string | null {
  const place = /^[A-Z]{2}$/.test(location) && countryCode(location) ? location : country;
  if (place !== 'US') return countryTimeZone(place);
  if (place === location) return null;
  return usStateTimeZone(US_STATE.exec(location)?.[1] ?? US_FACILITY_STATE.exec(location)?.[1]);
}

/** A wall clock's instant under an offset, when the offset reads it back unchanged. */
function labelledTime(local: string, label: string): ParsedTime | null {
  if (!OFFSET.test(label)) return null;
  const placed = DateTime.fromISO(`${local}${label}`, { setZone: true });
  if (!placed.isValid || placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) return null;
  return { iso: placed.toISO({ suppressMilliseconds: true }), timestamp: placed.toMillis() };
}

/**
 * A wall clock's instant under the row's `timeZone`, when that is the offset
 * the row's place keeps at that time. Other rows keep their wall clocks: an
 * offset the place does not have is someone else's clock, and a place without
 * one clock does not say which offset is its own.
 */
function placedTime(local: string, label: string, location: string, country: string): ParsedTime | null {
  const zone = placeZone(location, country);
  const time = zone ? labelledTime(local, label) : null;
  if (!zone || !time) return null;
  return DateTime.fromMillis(time.timestamp, { zone }).offset === DateTime.fromISO(time.iso, { setZone: true }).offset ? time : null;
}

/** A row as JCEX lists it, before its clock is settled. */
interface Row {
  readonly index: number;
  readonly description: string;
  readonly location: string;
  readonly country: string;
  readonly code: string;
  readonly label: string;
  /** Its wall clock. */
  readonly local: string;
  /** Its wall clock's instant on Beijing's clock. */
  readonly home: number;
}

function rowOf(row: unknown, index: number): Row | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'JCEX returned an invalid scan');
  const description = text(row, 'eventDetailEn') || text(row, 'eventDetailCn');
  if (!description) return null;
  const wall = WALL_CLOCK.exec(text(row, 'eventTime', 64));
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  const home = local ? firstOccurrence(DateTime.fromISO(local, { zone: HOME_ZONE })) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!home?.isValid || home.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'JCEX returned an invalid scan time');
  return { index, description, location: placeOf(text(row, 'location', 200)), country: text(row, 'countryCode', 8).toUpperCase(),
    code: text(row, 'platformEventCode', 64), label: text(row, 'timeZone', 16), local, home: home.toMillis() };
}

/**
 * JCEX lists a scan it relays from Yanwen or the delivering partner a second
 * time as its own row, on Beijing's wall clock under China's offset or the
 * destination's: a row whose wall clock, on Beijing's clock, is the instant
 * another row of the same code states under an offset other than China's.
 * The copies are dropped, and the offsets they were dated from are the
 * relaying sources' own: every row under one keeps it, wherever its place.
 */
function relayedCopies(rows: readonly Row[]): { copies: Set<Row>; offsets: Set<string> } {
  const stated = new Map<string, Row[]>();
  for (const row of rows) {
    const time = row.code && row.label !== HOME_OFFSET ? labelledTime(row.local, row.label) : null;
    if (!time) continue;
    const key = JSON.stringify([row.code, time.timestamp]);
    stated.set(key, [...(stated.get(key) ?? []), row]);
  }
  const copies = new Set<Row>();
  const relayed = new Set<Row>();
  for (const row of rows) {
    const sources = stated.get(JSON.stringify([row.code, row.home]))?.filter((other) => other !== row) ?? [];
    if (!sources.length) continue;
    copies.add(row);
    sources.forEach((source) => relayed.add(source));
  }
  return { copies, offsets: new Set([...relayed].filter((row) => !copies.has(row)).map((row) => row.label)) };
}

/**
 * JCEX also lists a scan it relays on Beijing's clock a second time in its own
 * words, filed under the bare country code: a row on China's offset whose
 * place is `CN`, at the wall clock another row on China's offset states with
 * another place or none. Those copies go too, and the source's words stay.
 */
function rewordedCopies(rows: readonly Row[]): Set<Row> {
  const home = rows.filter((row) => row.label === HOME_OFFSET);
  const stated = new Set(home.filter((row) => row.location !== 'CN').map((row) => row.local));
  return new Set(home.filter((row) => row.location === 'CN' && stated.has(row.local)));
}

/**
 * A row's clock. A row filed under neither a country nor a place is JCEX's
 * own order data, on Beijing's clock whatever offset it carries. A row under
 * a relaying source's offset keeps it. Others take their instant where their
 * place settles it, else keep their wall clock.
 */
function clockOf(row: Row, offsets: ReadonlySet<string>): { clock: { time: string } | { local_time: string }; at: number; order: number } {
  const time = !row.country && !row.location ? labelledTime(row.local, HOME_OFFSET)
    : offsets.has(row.label) ? labelledTime(row.local, row.label) : placedTime(row.local, row.label, row.location, row.country);
  if (time) return { clock: { time: time.iso }, at: time.timestamp, order: time.timestamp };
  // A wall clock is ordered on its place's clock where the place keeps one.
  const zone = placeZone(row.location, row.country);
  const placed = zone ? firstOccurrence(DateTime.fromISO(row.local, { zone })) : null;
  return { clock: { local_time: row.local }, at: row.home, order: placed?.isValid ? placed.toMillis() : row.home };
}

function stageOf(code: string, description: string): { stage: Stage; source: string } | undefined {
  const mapped = jcexStage(code || null, normalizeStatusWording(description));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, source: worded.source };
}

function projectRow(row: Row, offsets: ReadonlySet<string>): { at: number; order: number; index: number; event: CarrierEvent } {
  const { clock, at, order } = clockOf(row, offsets);
  const staged = stageOf(row.code, row.description);
  const event: CarrierEvent = {
    ...clock,
    description: row.description,
    ...(row.location ? { location: row.location } : {}),
    ...(row.code ? { provider_code: row.code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at, order, index: row.index, event };
}

/**
 * The instants of the timeline JCEX writes: three or more instants on one
 * second of the minute other than :00, each a whole number of six minutes
 * after the one before. They come in a row, or start within a minute after
 * the receipt, when the scans that follow can fall between them.
 */
function timeline(instants: readonly number[]): Set<number> {
  const sorted = [...new Set(instants)].sort((a, b) => a - b);
  const written = new Set<number>();
  const add = (run: readonly number[]) => { if (run.length >= TIMELINE_ROWS) run.forEach((at) => written.add(at)); };
  let run: number[] = [];
  for (const at of sorted) {
    const last = run.at(-1);
    if (last !== undefined && (at - last) % TIMELINE_STEP_MS === 0) {
      run.push(at);
      continue;
    }
    add(run);
    run = at % 60_000 ? [at] : [];
  }
  add(run);
  sorted.forEach((start, index) => {
    const receipt = index > 0 && start - sorted[index - 1]! < TIMELINE_START_MS;
    if (receipt && start % 60_000) add(sorted.slice(index).filter((at) => (at - start) % TIMELINE_STEP_MS === 0));
  });
  return written;
}

/** The one shipment of a reply that is for the number asked. */
function shipmentFor(data: unknown, number: string): Record<string, unknown> {
  if (!Array.isArray(data) || !data.every(isRecord)) throw new SchemaError(PROVIDER, 'JCEX returned invalid shipments');
  const matching = data.filter((entry) => normalizeTrackingNumber(text(entry, 'number', 64)) === number);
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'JCEX did not answer for the number once');
  const content = matching[0]!.content;
  if (!isRecord(content)) throw new SchemaError(PROVIDER, 'JCEX returned a shipment without its content');
  return content;
}

/**
 * The reply of `POST /api/track/tracking`, the lookup track.jcex.com makes:
 * one entry per number asked, its shipment under `content` with JCEX's
 * waybill and order numbers, its status and its scans, mostly newest first.
 * An unknown number comes back without either number; a waybill JCEX has
 * printed but not scanned has them and no scans. The recipient's province,
 * city and postcode, the postcodes in the scans' places, the shipment's
 * reference and its other numbers are not read.
 */
export function parseJcex(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeJcexNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'JCEX returned an invalid envelope');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'JCEX did not complete the lookup');
  const shipment = shipmentFor(payload.data, number);
  const own = [text(shipment, 'waybillNumber', 64), text(shipment, 'orderNumber', 64)].filter(Boolean).map(normalizeTrackingNumber);
  const rows = shipment.trackDetails ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'JCEX returned an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'JCEX returned an oversized history');
  if (!own.length) {
    if (rows.length || text(shipment, 'platformEventStatus', 32) !== 'NotFound') throw new SchemaError(PROVIDER, 'JCEX returned a shipment without its number');
    throw new NotFoundError(PROVIDER);
  }
  if (!own.includes(number)) throw new IndeterminateError(PROVIDER, 'JCEX answered for another shipment');

  const seen = new Set<string>();
  const listed = rows.map(rowOf).filter((row): row is Row => {
    const key = row && JSON.stringify([row.local, row.label, row.code, row.description, row.location]);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const { copies, offsets } = relayedCopies(listed);
  const reworded = rewordedCopies(listed);
  const projected = listed.filter((row) => !copies.has(row) && !reworded.has(row)).map((row) => projectRow(row, offsets));
  // Neither a row dated after the read nor a row of the timeline JCEX writes is a scan.
  const written = timeline(projected.map(({ at }) => at));
  const ahead = projected.filter(({ at }) => at > readAt || written.has(at));
  // Rows come newest first, but JCEX puts its own milestone, such as the
  // handover to the delivering partner, on top: the rows are ordered by their
  // clocks, and rows at one time keep the reply's order.
  const events = projected.filter((scan) => !ahead.includes(scan))
    .sort((a, b) => b.order - a.order || a.index - b.index).map(({ event }) => event);
  // The rows written ahead are named, so that a provider's copies of them are not taken for scans.
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'JCEX has no scans for the waybill yet', ahead.length
      ? { reason: 'written_ahead', writtenAhead: [...new Set(ahead.map(({ event }) => event.time ?? event.local_time!))] } : undefined);
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = text(shipment, 'recipientCountryCode', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...(/^[A-Z]{2}$/.test(destination) && countryCode(destination) ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    ...(ahead.length ? { written_ahead: [...new Set(ahead.map(({ event }) => event.time ?? event.local_time!))] } : {}),
  };
}
