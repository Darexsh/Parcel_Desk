import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { correosElSalvadorStage, summaryStage } from './status.js';

export const PROVIDER = 'Correos de El Salvador';
// A long history is a few kilobytes.
export const CORREOS_EL_SALVADOR_MAX_BYTES = 256 * 1024;

const MAX_SCANS = 500;
// "2026-02-10T19:53:22.723": a clock to the second, with up to seven digits of
// a second after it, and no zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?$/;

/**
 * Correos de El Salvador's tracker takes S10 item codes only: its own, ending
 * SV, and those of the posts that send mail to El Salvador. The code needs a
 * valid check digit.
 */
export function normalizeCorreosElSalvadorNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Correos de El Salvador tracks S10 item codes');
}

/**
 * Whether a 404 is the tracking service's own answer for a code it does not
 * know: an RFC 7807 problem titled "Not Found". A path the service has no
 * route for gets an empty 404, and one nginx does not pass on gets its HTML
 * page.
 */
export function isCorreosElSalvadorMissing(contentType: string, body: string): boolean {
  if (!/^application\/problem\+json\b/i.test(contentType.trim())) return false;
  let problem: unknown;
  try {
    problem = JSON.parse(body);
  } catch {
    return false;
  }
  return isRecord(problem) && problem.status === 404 && problem.title === 'Not Found';
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Correos de El Salvador returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's numeric `idEvento`, the IPS event type, kept for review. */
function code(row: Record<string, unknown>): string {
  const value = row.idEvento;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return value.trim();
  throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an invalid scan code');
}

/** A scan's `fecha` to the second, and the whole clock padded for sorting. */
function wallClock(value: string): { local: string; order: string } {
  const [, local = '', fraction = ''] = CLOCK.exec(value) ?? [];
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an invalid scan time');
  }
  return { local, order: `${local}.${fraction.padEnd(7, '0')}` };
}

interface Scan { event: CarrierEvent; order: string }

/** A scan's clock, office, wording and code; its reason and action are left out. */
function scanOf(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an invalid scan');
  const description = text(row, 'descripcion', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Correos de El Salvador returned a scan without wording');
  const clock = wallClock(text(row, 'fecha', 40));
  const location = text(row, 'oficina', 160);
  const provider = code(row);
  const staged = correosElSalvadorStage(description);
  const event: CarrierEvent = {
    local_time: clock.local,
    ...(location ? { location } : {}),
    description,
    ...(provider ? { provider_code: provider } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, order: clock.order };
}

/** The item's weight in kilograms, when the reply gives one. */
function weight(item: Record<string, unknown>): number | undefined {
  const value = item.peso;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an invalid weight');
  }
  return value > 0 ? value : undefined;
}

/**
 * The reply of the tracking service's `GET /api/v1/rastrear-paquete/{code}`
 * for an item it holds: the item under `envio`, a summary message and its
 * scans, newest first.
 */
export function parseCorreosElSalvador(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeCorreosElSalvadorNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an invalid reply');
  if (payload.failed === true) throw new IndeterminateError(PROVIDER, 'Correos de El Salvador’s tracking service reported a failure');
  const item = payload.envio;
  if (item === null || item === undefined) throw new IndeterminateError(PROVIDER, 'Correos de El Salvador returned no item for the code');
  if (!isRecord(item) || typeof item.numeroRastreo !== 'string') {
    throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an item without its code');
  }
  if (normalizeTrackingNumber(clean(item.numeroRastreo, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Correos de El Salvador answered for a different item');
  }

  const rows = payload.eventos ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an item with invalid scans');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Correos de El Salvador returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row) => {
    const scan = scanOf(row);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify([scan.order, scan.event.description, scan.event.location ?? '', scan.event.provider_code ?? '']);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  const message = text(payload, 'mensajeAmigable', 200);
  const destination = text(item, 'paisDestino', 80);
  const kilograms = weight(item);
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by clock, as the reply lists them; scans with the same clock keep the reply's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.order > left.order ? 1 : right.order < left.order ? -1 : 0);
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  // The summary message stages the item only when no scan does.
  const stage = (current?.stage as Stage | undefined) ?? summaryStage(message);
  const country = destination ? countryCode(destination) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(kilograms !== undefined ? { weight_kg: kilograms } : {}),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    events,
  };
}
