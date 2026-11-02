import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { interrapidisimoStage } from './status.js';

export const PROVIDER = 'Inter Rapidísimo';
// A long history is a few kilobytes.
export const INTERRAPIDISIMO_MAX_BYTES = 256 * 1024;
const ZONE = 'America/Bogota';
// The home page's tracking field takes a guide of twelve or thirteen digits.
const NUMBER = /^\d{12,13}$/;
const SESSION = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const SCAN_CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/;
const ESTIMATE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/;
const MAX_ROWS = 200;

// The answers of the search and of the milestones, grouped as the tracker's script groups them.
const SEARCH_FOUND = new Set(['STE002', 'STE028']);
const SEARCH_MISSING = new Set(['STE006', 'STE024']);
const SEARCH_REFUSED_FORMAT = new Set(['STE007', 'STE022', 'STE023', 'STE035', 'STE036', 'STE037']);
// The search's own refusal of an ALTCHA proof of work, which the page solves when its check is on.
const SEARCH_CAPTCHA = 'STE033';
const SUMMARY_FOUND = 'STE001';
const MILESTONES_FOUND = new Set(['STE204', 'STE205', 'STE207', 'STE208', 'STE231']);
const MILESTONES_MISSING = new Set(['STE209', 'STE227', 'STE238']);

/** A guide number for Inter Rapidísimo's tracker; anything else is not one it issues. */
export function normalizeInterrapidisimoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Inter Rapidísimo guide numbers are twelve or thirteen digits');
  return number;
}

/** A field of the service's envelope, which its refusals write with a capital. */
function field(payload: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : payload[key[0]!.toUpperCase() + key.slice(1)];
}

/** Whether a reply is the service's own answer rather than a gateway's or a server's. */
export function isInterrapidisimoAnswer(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload) && typeof field(payload, 'operacionExitosa') === 'boolean' && typeof field(payload, 'mensaje') === 'string';
}

/** The service's envelope: whether it succeeded and the code it answered with. */
function envelope(payload: unknown): { ok: boolean; code: string; result: unknown } {
  if (!isInterrapidisimoAnswer(payload)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned an invalid envelope');
  return { ok: field(payload, 'operacionExitosa') as boolean, code: clean(field(payload, 'mensaje'), 16).toUpperCase(),
    result: field(payload, 'resultado') };
}

/**
 * The search's reply for one guide: the session the page opens its result with,
 * which the summary and the milestones are asked under. The tracker's own
 * "no results" codes are the only missing guide.
 */
export function interrapidisimoSession(payload: unknown): string {
  const { ok, code, result } = envelope(payload);
  if (ok && SEARCH_FOUND.has(code)) {
    const session = isRecord(result) && typeof result.guid === 'string' ? result.guid : '';
    if (!SESSION.test(session)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned a search without its session');
    return session;
  }
  if (ok) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned an unexpected search answer');
  if (SEARCH_MISSING.has(code)) throw new NotFoundError(PROVIDER);
  if (code === SEARCH_CAPTCHA) throw new ChallengeError(PROVIDER, 'Inter Rapidísimo asked for its ALTCHA check');
  // The number is checked before the search, so a format refusal is a changed request.
  if (SEARCH_REFUSED_FORMAT.has(code)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo refused the search request');
  throw new IndeterminateError(PROVIDER, 'Inter Rapidísimo did not complete the search');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Inter Rapidísimo returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The summary's guide for the number asked; the search opened the session for that number alone. */
function summaryGuide(payload: unknown, number: string): Record<string, unknown> {
  const { ok, code, result } = envelope(payload);
  if (!ok || code !== SUMMARY_FOUND) throw new IndeterminateError(PROVIDER, 'Inter Rapidísimo did not return the guide it found');
  if (!isRecord(result) || !Array.isArray(result.guias)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned an invalid summary');
  const guides = result.guias.map((guide) => {
    if (!isRecord(guide) || (typeof guide.numeroGuia !== 'string' && typeof guide.numeroGuia !== 'number')) {
      throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned a guide without its number');
    }
    return guide;
  });
  const guide = guides.find((entry) => normalizeTrackingNumber(String(entry.numeroGuia)) === number);
  if (!guide) {
    if (guides.length) throw new IndeterminateError(PROVIDER, 'Inter Rapidísimo answered for another guide');
    throw new IndeterminateError(PROVIDER, 'Inter Rapidísimo did not return the guide it found');
  }
  return guide;
}

/** The milestone rows, or null when the service has none for the guide. */
function milestoneRows(payload: unknown): Record<string, unknown>[] | null {
  const { ok, code, result } = envelope(payload);
  if (!ok) {
    if (MILESTONES_MISSING.has(code)) return null;
    throw new IndeterminateError(PROVIDER, 'Inter Rapidísimo did not return the milestones');
  }
  if (!MILESTONES_FOUND.has(code) || !isRecord(result)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned invalid milestones');
  const rows = result.tracking ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned invalid milestones');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned an oversized history');
  return rows.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned an invalid milestone');
    return row;
  });
}

/** A warehouse the milestones name, as "CITY, DEPARTMENT". */
function warehouse(result: unknown, side: 'Origen' | 'Destino'): string {
  if (!isRecord(result)) return '';
  return [text(result, `ciudadBodega${side}`, 80), text(result, `deptoBodega${side}`, 80)].filter(Boolean).join(', ');
}

/**
 * A milestone's clock: `MM/dd/yyyy HH:mm:ss` on Colombia's clock. Inter
 * Rapidísimo's network is within Colombia, which keeps one zone all year.
 */
function scanTime(value: string): string {
  const [, month, day, year, clock] = SCAN_CLOCK.exec(value) ?? [];
  const placed = clock ? zonedTime(value, 'MM/dd/yyyy HH:mm:ss', ZONE) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!placed?.iso.startsWith(`${year}-${month}-${day}T${clock}`)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned an invalid milestone time');
  return placed.iso;
}

/**
 * Inter Rapidísimo's tracker for one guide, from its two replies: the summary
 * of `ResultadoConsulta/ConsultarGuias`, which names the guide, and the
 * milestones of `EstadoTracking/ObtenerEstadoTracking`, oldest first. The
 * milestones name no place; the warehouse ones take the warehouse the reply
 * names for that end of the journey.
 */
export function parseInterrapidisimo(summary: unknown, milestones: unknown, raw: string): CarrierResult {
  const number = normalizeInterrapidisimoNumber(raw);
  const guide = summaryGuide(summary, number);
  if (typeof guide.preenvio !== 'boolean') throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned an invalid summary');
  const rows = milestoneRows(milestones);
  const result = isRecord(milestones) ? field(milestones, 'resultado') : undefined;
  const places: Readonly<Record<string, string>> = {
    [normalizeStatusWording('En bodega de origen')]: warehouse(result, 'Origen'),
    [normalizeStatusWording('En bodega de destino')]: warehouse(result, 'Destino'),
  };

  const seen = new Set<string>();
  const scans = (rows ?? []).map((row, index) => {
    if (typeof row.etapa !== 'number' || !Number.isInteger(row.etapa)) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned a milestone without its step');
    return { row, step: row.etapa, index };
  }).sort((left, right) => left.step - right.step || left.index - right.index).flatMap(({ row }) => {
    const description = text(row, 'nombreEtapa', 200);
    const clock = text(row, 'fechaEtapa', 32);
    if (!description) throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned a milestone without its name');
    // A milestone without a date is one still to come.
    if (!clock) return [];
    const time = scanTime(clock);
    const key = JSON.stringify([time, description]);
    if (seen.has(key)) return [];
    seen.add(key);
    const location = places[normalizeStatusWording(description)];
    const staged = interrapidisimoStage(description);
    const event: CarrierEvent = {
      time,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return [event];
  });

  if (!scans.length) {
    // A guide made ahead of handover has no milestones; the page reads it as not started.
    if (guide.preenvio) {
      return { status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map', last_status_text: 'Por iniciar',
        last_update: null, expected_delivery: null, summary_only: true, events: [] };
    }
    throw new NoHistoryError(PROVIDER);
  }
  const events = scans.reverse();
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time! : null;
  // The estimate is the last day of the delivery window; one already past the newest milestone is stale.
  const estimated = ESTIMATE.exec(text(guide, 'fechaEstimadaEntrega', 32))?.[1];
  const expected = estimated && stage !== 'delivered' && stage !== 'returned' && estimated >= newest.time!.slice(0, 10) ? estimated : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: expected,
    ...(delivered ? { delivered_at: delivered } : {}),
    events,
  };
}
