import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { urbanoProcessStage, urbanoStage } from './status.js';

export const PROVIDER = 'Urbano';
// A long history is about ten kilobytes.
export const URBANO_MAX_BYTES = 512 * 1024;
// Guías, their barcodes and tracking codes: letters and digits, with at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// The shipment's own numbers the reply gives; the one asked must be one of them, whole.
const IDENTITY = ['rastreo', 'cod_seguimiento', 'guia_barra', 'guia_texto'] as const;
const MAX_ENTRIES = 20;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A number for Urbano's tracker, in upper case as the page sends it; anything else is not one Urbano issues. */
export function normalizeUrbanoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Urbano numbers are six to thirty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Urbano returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A whole number the reply gives as a number or as digits, or null without one. */
function integer(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\s*-?\d{1,6}\s*$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) ? parsed : null;
}

// Who signed for or took the parcel and their ID document, after a status
// ("Firma: … (DNI: …)", as the shipment's summary words a delivery, or
// "Recibido por …").
const SIGNATORY = /\s*[(,;\-–]?\s*\b(?:(?:firma|dni|doc(?:umento)?|nombre|recibe)\s*:|(?:recibid[oa]|firmad[oa]|entregad[oa])\s+(?:por|a)\b)[\s\S]*$/i;
const EMAIL = /[^\s@]+@[^\s@]+/g;
// A run of six or more digits, with spaces, dots or hyphens between them, as
// ID card and phone numbers are written.
const ID_OR_PHONE = /(?<![A-Z\d])\+?\d(?:[\s.-]?\d){5,}(?![A-Z\d])/gi;

/** A scan's wording without a signatory, an ID document, an e-mail address or phone numbers. */
export function urbanoWording(raw: string): string {
  const own = raw.replace(SIGNATORY, '').replace(EMAIL, '').replace(ID_OR_PHONE, '');
  return clean(clean(own).replace(/\s+([,;:.])/g, '$1'), 300).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * A scan's `auditoria`, "2026-05-12 15:47": the wall clock of the station that
 * scanned it, to the minute, with no zone. A time of 00:00 is a scan the
 * tracker kept only the day of.
 */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59) throw new SchemaError(PROVIDER, 'Urbano returned an invalid scan time');
  return match[4] === '00' && match[5] === '00' ? day : `${day}T${match[4]}:${match[5]}:00`;
}

/** A calendar day the reply gives as `2026-05-12`, or null without a valid one. */
function calendarDate(value: string): string | null {
  const match = DAY.exec(value);
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * The names the shipment gives its origin and destination stations, by their
 * codes ("LIM": "LIMA", "CUZ": "Urbano Cusco"), without the brand in front.
 */
function stations(shipment: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [codes, name] of [[['origen_iata', 'origen'], 'origen_descri'], [['destino_iata', 'destino'], 'destino_descri']] as const) {
    const label = text(shipment, name, 80).replace(/^urbano\s+/i, '');
    if (!label) continue;
    for (const code of codes) {
      const key = text(shipment, code, 8).toUpperCase();
      if (key && !names.has(key)) names.set(key, label);
    }
  }
  return names;
}

interface Scan { event: CarrierEvent; index: number }

/**
 * A movement as the page draws it: `detalle`, then the `sub_estado` under it,
 * such as a failed visit's reason. The `anotaciones`, which name the courier,
 * the vehicle and manifests, the `comentario`, the photos and the GPS point of
 * the visit are not kept. A movement with neither wording is left out.
 */
function scanOf(row: unknown, index: number, names: Map<string, string>): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Urbano returned an invalid scan');
  const code = cleanScalar(row.chk, 8).toUpperCase();
  const detail = urbanoWording(text(row, 'detalle'));
  const sub = urbanoWording(text(row, 'sub_estado'));
  const local = wallClock(text(row, 'auditoria', 32));
  const description = detail && sub && !detail.toLowerCase().includes(sub.toLowerCase()) ? `${detail}: ${sub}` : detail || sub;
  if (!description) return null;
  const location = names.get(text(row, 'agencia', 8).toUpperCase());
  const staged = urbanoStage(code, detail || sub);
  return { index, event: {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** The shipment's scans, newest first; the same scan once. */
function history(shipment: Record<string, unknown>): CarrierEvent[] {
  const rows = shipment.movimientos ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Urbano returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Urbano returned an oversized history');
  const names = stations(shipment);
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = scanOf(row, index, names);
    if (!scan) return;
    const { local_time: local, provider_code: code, description, location } = scan.event;
    const key = JSON.stringify([local, code, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  // The reply lists them newest first; scans at one clock keep that order, and
  // a day without a time comes before that day's clocks.
  return scans.sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || a.index - b.index)
    .map(({ event }) => event);
}

/** The parcel's weight in kilograms, when the reply gives a plausible one. */
function weight(shipment: Record<string, unknown>): number | null {
  const value = text(shipment, 'peso', 16);
  const kg = /^\d{1,4}(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return kg > 0 && kg < 5_000 ? kg : null;
}

/** The shipment's numbers, whole and in the form the adapter asks with. */
function identifiers(entry: Record<string, unknown>): string[] {
  return IDENTITY.map((key) => text(entry, key, 64)).filter(Boolean).map((value) => normalizeTrackingNumber(value));
}

function project(shipment: Record<string, unknown>): CarrierResult {
  const events = history(shipment);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const process = integer(shipment.id_proceso);
  const labelled = process === null ? undefined : urbanoProcessStage(process);
  // The page's label for a return or a wait for collection decides; a label
  // for collection never steps a delivered parcel back.
  const summary = labelled === 'ready_for_pickup' && scanned?.stage === 'delivered' ? undefined : labelled;
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const expected = stage === 'delivered' || stage === 'returned' ? null
    : calendarDate(text(shipment, 'fec_estimada', 16)) ?? calendarDate(text(shipment, 'fecha_estimada', 16));
  const kg = weight(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(kg !== null ? { weight_kg: kg } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of the tracking page's lookup, `POST /api/v1/trackingGlobal`: one
 * entry per number asked. A shipment has `error_sql` 0 or more and names the
 * number asked as its tracking code, guía or barcode. For a number it holds
 * nothing for, the entry is only `error_sql: -1` and the number, and the page
 * draws an empty card: the tracker does not say the shipment does not exist,
 * and it answers an empty or malformed number the same way, so that answer is
 * inconclusive.
 */
export function parseUrbano(payload: unknown, raw: string): CarrierResult {
  const number = normalizeUrbanoNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean' || !Array.isArray(payload.data)) {
    throw new SchemaError(PROVIDER, 'Urbano returned an invalid envelope');
  }
  if (!payload.success || (payload.code_error !== undefined && integer(payload.code_error) !== 0)) {
    throw new IndeterminateError(PROVIDER, 'Urbano did not complete the lookup');
  }
  if (payload.data.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'Urbano returned too many shipments');
  const shipments: Record<string, unknown>[] = [];
  let nothing: number | null = null;
  for (const entry of payload.data) {
    if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'Urbano returned an invalid shipment');
    const code = integer(entry.error_sql);
    if (code === null) throw new SchemaError(PROVIDER, 'Urbano returned a shipment without its lookup code');
    if (code >= 0) {
      const own = identifiers(entry);
      if (!own.length) throw new SchemaError(PROVIDER, 'Urbano returned a shipment without its number');
      if (own.includes(number)) shipments.push(entry);
    } else if (normalizeTrackingNumber(text(entry, 'guia_barra', 64)) === number) {
      nothing = code;
    }
  }
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Urbano returned several shipments under the number');
  if (shipments.length === 1) return project(shipments[0]!);
  if (nothing === -1) {
    throw new IndeterminateError(PROVIDER, 'Urbano\'s tracker shows nothing for the number', { reason: 'portal_not_found' });
  }
  if (nothing !== null) throw new IndeterminateError(PROVIDER, 'Urbano did not complete the lookup');
  throw new IndeterminateError(PROVIDER, 'Urbano answered for another shipment');
}
