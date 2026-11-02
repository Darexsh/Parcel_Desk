import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isPosteItalianeTrackingNumber } from '../../core/detection/posteItaliane.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { sailpostStage } from './status.js';

export const PROVIDER = 'Sailpost';
// A long history is a few kilobytes.
export const SAILPOST_MAX_BYTES = 512 * 1024;
const ZONE = 'Europe/Rome';
// No public source gives Sailpost's layouts: letters and digits, eight to thirty, with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// A WCF date: epoch milliseconds, then the server's offset when the value is a local time.
const WCF_DATE = /^\/Date\((-?\d{1,15})([+-])(\d{2})(\d{2})\)\/$|^\/Date\((-?\d{1,15})\)\/$/;
const NOT_FOUND = 'nessun risultato';
// The code of a scan handing the item to Poste Italiane, whose number is then `TrackVett`.
const POSTE_HANDOFF = '903';
// A position that names a party instead of a place.
const PARTY = /^(?:mittente|destinatario)$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Sailpost's tracker, in capitals; anything else is not one it issues. */
export function normalizeSailpostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Sailpost codes are eight to thirty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Sailpost returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A required status code: a whole, nonnegative number. */
function code(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, `Sailpost returned an invalid ${key}`);
  return value;
}

interface WcfDate { millis: number; offsetMinutes: number | null }

function wcfDate(value: unknown): WcfDate | null {
  const match = typeof value === 'string' ? WCF_DATE.exec(value) : null;
  if (!match) return null;
  if (match[5] !== undefined) return { millis: Number(match[5]), offsetMinutes: null };
  const minutes = Number(match[3]) * 60 + Number(match[4]);
  return { millis: Number(match[1]), offsetMinutes: match[2] === '-' ? -minutes : minutes };
}

/**
 * A scan's clock. `Data` is the scan's day, as the server's local midnight
 * with its offset; the page and the app show that day alone. `DataUTC` is the
 * scan's instant. A scan the service dates by its day only, such as the end
 * of the storage period, gives the same midnight in both and keeps the day.
 */
function scanClock(row: Record<string, unknown>): Pick<CarrierEvent, 'time'> & { local_time?: string; order: number } {
  const local = wcfDate(row.Data);
  if (!local || local.millis <= 0 || local.offsetMinutes === null) throw new SchemaError(PROVIDER, 'Sailpost returned an invalid scan date');
  const day = DateTime.fromMillis(local.millis, { zone: FixedOffsetZone.instance(local.offsetMinutes) }).toISODate()!;
  const utc = row.DataUTC === undefined || row.DataUTC === null ? null : wcfDate(row.DataUTC);
  if (row.DataUTC !== undefined && row.DataUTC !== null && (!utc || utc.offsetMinutes !== null)) {
    throw new SchemaError(PROVIDER, 'Sailpost returned an invalid scan time');
  }
  if (utc && utc.millis > 0 && utc.millis !== local.millis) {
    const at = DateTime.fromMillis(utc.millis, { zone: ZONE });
    // An instant on another day than the one the page shows is not the scan's.
    if (at.toISODate() === day) return { time: at.toISO({ suppressMilliseconds: true })!, order: utc.millis };
  }
  return { local_time: day, order: local.millis };
}

interface Scan { key: string; order: number; event: CarrierEvent; handoff: string | null }

function projectRow(row: Record<string, unknown>, number: string): Scan {
  const own = text(row, 'CodRaccom', 64);
  if (own && normalizeTrackingNumber(own).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Sailpost answered for another item');
  const status = String(code(row, 'IdStato'));
  const family = code(row, 'CodStato');
  const description = text(row, 'Desc') || text(row, 'Stato', 80);
  if (!description) throw new SchemaError(PROVIDER, 'Sailpost returned a scan without wording');
  const position = text(row, 'Pos', 120);
  const location = PARTY.test(position) ? '' : position;
  const { order, ...clock } = scanClock(row);
  const staged = sailpostStage(status, family, description);
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    description,
    provider_code: status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.time ?? clock.local_time, status, description, location]), order, event, handoff: posteNumber(row, status) };
}

/**
 * Poste Italiane's number on a scan handing the item to it, which the app
 * links to Poste's tracker. It counts only when Poste's detection takes it whole.
 */
function posteNumber(row: Record<string, unknown>, status: string): string | null {
  if (status !== POSTE_HANDOFF) return null;
  const reference = normalizeTrackingNumber(text(row, 'TrackVett', 64)).toUpperCase();
  return isPosteItalianeTrackingNumber(reference) ? reference : null;
}

/**
 * The tracking service's reply for one code. It answers `Risultato: true`
 * with the error "Nessun risultato" and no scans for a code it does not know,
 * which the page reports as not found. `Track` echoes the code asked and each
 * scan's `CodRaccom` names its item.
 */
export function parseSailpost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSailpostNumber(raw);
  if (!isRecord(payload) || typeof payload.Risultato !== 'boolean') throw new SchemaError(PROVIDER, 'Sailpost returned an invalid envelope');
  const rows = payload.Events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Sailpost returned an item with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Sailpost returned an oversized history');
  const error = text(payload, 'Errore');
  if (!payload.Risultato) throw new IndeterminateError(PROVIDER, 'Sailpost did not complete the lookup');
  if (typeof payload.Track !== 'string') throw new SchemaError(PROVIDER, 'Sailpost returned an item without its code');
  if (normalizeTrackingNumber(payload.Track.slice(0, 64)).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Sailpost answered for another item');
  if (error) {
    if (error.toLowerCase() === NOT_FOUND && rows.length === 0) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Sailpost did not complete the lookup');
  }

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Sailpost returned an invalid scan');
    const scan = projectRow(row, number);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the service lists them; an oldest-first reply is turned round.
  if (scans[0]!.order < scans.at(-1)!.order) scans.reverse();
  const events = scans.map((scan) => scan.event);
  const handoff = scans.find((scan) => scan.handoff)?.handoff;

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(handoff ? { delivery_carrier: 'poste-italiane', delivery_tracking_number: handoff } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
