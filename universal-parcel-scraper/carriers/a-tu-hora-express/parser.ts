import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { aTuHoraStage } from './status.js';

export const PROVIDER = 'A Tu Hora Express';
// A long history is a few kilobytes.
export const A_TU_HORA_MAX_BYTES = 512 * 1024;
// The tracker's forms: a ten-digit code it pads with six zeros, the sixteen-digit
// service number, and that number with three digits and the delivery postcode.
const SHORT = /^\d{10}$/;
const SERVICE = /^\d{16}$/;
const LONG = /^(\d{16})\d{3}(\d{5})$/;
// The tracker's postcode field takes five characters: a Spanish postcode.
const POSTCODE = /^\d{5}$/;
const GUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;
const POSTCODE_MESSAGE = 'A Tu Hora Express shows a shipment only with its five-digit delivery postcode';

/** What the tracker is asked with: the code as typed or padded, its service number and the delivery postcode. */
export interface ATuHoraCredential {
  readonly code: string;
  readonly service: string;
  readonly postcode: string;
}

/** The 24-digit form, which carries its delivery postcode at the end. */
export function carriesPostcode(raw: string): boolean {
  return raw.length <= 64 && LONG.test(normalizeTrackingNumber(raw));
}

/**
 * A code and postcode for the tracker. The 24-digit form brings its own
 * postcode; the shorter ones need the caller's, as the tracker's form does.
 */
export function aTuHoraCredential(raw: string, rawPostcode?: string | null): ATuHoraCredential {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const long = LONG.exec(number);
  if (long) return { code: number, service: long[1]!, postcode: long[2]! };
  if (!SHORT.test(number) && !SERVICE.test(number)) {
    throw new InvalidInputError(PROVIDER, 'A Tu Hora Express shipment codes are 10, 16 or 24 digits');
  }
  const service = SHORT.test(number) ? `000000${number}` : number;
  const postcode = (rawPostcode ?? '').replace(/\s+/g, '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'the delivery postcode', POSTCODE_MESSAGE);
  if (!POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, POSTCODE_MESSAGE);
  return { code: service, service, postcode };
}

/**
 * The first lookup's reply: the shipment's internal identifier, or an empty
 * body, which the page reports as not found, for a code and postcode it
 * does not pair.
 */
export function parseATuHoraGuid(payload: unknown): string {
  if (payload === null) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || typeof payload.guid !== 'string') throw new SchemaError(PROVIDER, 'A Tu Hora Express returned a shipment without its identifier');
  const guid = payload.guid.trim();
  if (!GUID.test(guid)) throw new SchemaError(PROVIDER, 'A Tu Hora Express returned an invalid shipment identifier');
  return guid;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `A Tu Hora Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan code, a string or a nonnegative integer. */
function code(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' ? !Number.isSafeInteger(value) || value < 0 : typeof value !== 'string') {
    throw new SchemaError(PROVIDER, `A Tu Hora Express returned an invalid ${key}`);
  }
  return cleanScalar(value, 16);
}

/**
 * A scan's `fecHoraAlta`, `dd/MM/yyyy HH:mm:ss`: a wall clock the page shows
 * without a zone, so it stays local.
 */
function wallClock(value: unknown): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'A Tu Hora Express returned an invalid scan time');
  }
  return local;
}

/** A `dd/MM/yyyy` day as `yyyy-MM-dd`, or null. */
function day(value: unknown): string | null {
  const match = DAY.exec(clean(value, 16));
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return DateTime.fromISO(iso, { zone: 'UTC' }).isValid ? iso : null;
}

/**
 * A scan: its clock, wording, code and town. The coordinates beside it can
 * place the recipient's door, and are not kept.
 */
function scanOf(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const description = text(row, 'des');
  if (!description) throw new SchemaError(PROVIDER, 'A Tu Hora Express returned a scan without wording');
  const local = wallClock(row.fecHoraAlta);
  const status = code(row, 'cod');
  const reason = code(row, 'codInc');
  const location = text(row, 'pob', 120);
  const staged = aTuHoraStage(status, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(status ? { provider_code: status } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, status, reason, description, location]), event };
}

/** The shipment's own service number, its agency code and delivery note number. */
function serviceNumber(data: Record<string, unknown>): string {
  const agency = data.codAgeCargo;
  const note = data.albaran;
  if (typeof agency !== 'string' || typeof note !== 'string' || !note.trim()) {
    throw new SchemaError(PROVIDER, 'A Tu Hora Express returned a shipment without its number');
  }
  return `${agency.trim()}${note.trim()}`;
}

/** The weight the page shows, when the shipment has one. */
function weight(data: Record<string, unknown>): number | null {
  const value = data.pesoOri;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 10_000 ? value : null;
}

/**
 * The reply of `/service/envios/detalle-envio/{guid}`. The shipment must be
 * the one the first lookup named, under the service number asked. Its scans
 * are `estados`, newest first, and `ultEstado` repeats the newest.
 */
export function parseATuHora(payload: unknown, credential: ATuHoraCredential, guid: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'A Tu Hora Express returned an invalid shipment');
  if (typeof payload.guid !== 'string') throw new SchemaError(PROVIDER, 'A Tu Hora Express returned a shipment without its identifier');
  if (payload.guid.trim().toUpperCase() !== guid.toUpperCase() || serviceNumber(payload) !== credential.service) {
    throw new IndeterminateError(PROVIDER, 'A Tu Hora Express answered for another shipment');
  }
  const rows: unknown = payload.estados ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'A Tu Hora Express returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'A Tu Hora Express returned an oversized history');
  const latest = payload.ultEstado ?? null;
  if (latest !== null && !isRecord(latest)) throw new SchemaError(PROVIDER, 'A Tu Hora Express returned an invalid latest status');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  // The page lists `estados`; `ultEstado` adds a row only when they lack it.
  for (const row of latest ? [...rows as unknown[], latest] : rows as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'A Tu Hora Express returned an invalid scan');
    const scan = scanOf(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock; rows of one clock keep the reply's order.
  const ordered = events.map((event, index) => ({ event, index }))
    .sort((left, right) => String(right.event.local_time).localeCompare(String(left.event.local_time)) || left.index - right.index)
    .map(({ event }) => event);

  const newest = ordered[0]!;
  const scanned = ordered.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const settled = stage === 'delivered' || stage === 'returned';
  // The page shows `fecEntr` as the expected day only when the reply allows it and the shipment is open.
  const shown = payload.boMuestraFechaPrevista === true && !settled && !(isRecord(latest) && latest.estadoFinal === true);
  const expected = shown ? day(payload.fecEntr) : null;
  const departed = day(payload.fecha);
  const kg = weight(payload);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected && (!departed || expected >= departed) ? expected : null,
    ...(kg === null ? {} : { weight_kg: kg }),
    events: ordered.slice(0, MAX_EVENTS),
    ...(ordered.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
