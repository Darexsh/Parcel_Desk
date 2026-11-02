import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { velocesStage } from './status.js';

export const PROVIDER = 'Veloces';
// A reply is the whole shipment record, under twenty kilobytes for a dozen statuses.
export const VELOCES_MAX_BYTES = 512 * 1024;
// A guide is V and ten digits; the reply's tracking_guide_number holds the digits.
const NUMBER = /^V\d{10}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const DELIVERED = '4';
// Warehouse statuses the tracker lists once per delivery attempt (13 is Bodega Destino).
const ONCE_PER_ATTEMPT: ReadonlySet<string> = new Set(['12', '13']);

/** A guide for Veloces' tracker, in capitals; anything else is not one it issues. */
export function normalizeVelocesNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Veloces guides are V and ten digits');
  return number;
}

/** A status id, which the lookup sends as a number. */
function statusId(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, 'Veloces returned an invalid status id');
  return String(value);
}

/** A status: its id and name, as the tracker shows them. */
function statusOf(value: unknown): { code: string; name: string } {
  if (!isRecord(value) || typeof value.name !== 'string') throw new SchemaError(PROVIDER, 'Veloces returned an invalid status');
  const name = clean(value.name, 120);
  if (!name) throw new SchemaError(PROVIDER, 'Veloces returned a status without its name');
  return { code: statusId(value.id), name };
}

/** The reason the courier picked for a status, from Veloces' own list; its free-text remarks are never read. */
function reasonOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (!isRecord(value) || typeof value.name !== 'string') throw new SchemaError(PROVIDER, 'Veloces returned an invalid status reason');
  return clean(value.name, 120).replace(/[\s.]+$/, '');
}

/** The delivery attempt a status belongs to; none before the first. */
function attemptOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, 'Veloces returned an invalid delivery attempt');
  return value;
}

interface Row {
  readonly event: CarrierEvent & { time: string; description: string; provider_code: string };
  readonly timestamp: number;
  readonly attempt: number;
  readonly index: number;
}

/**
 * One status of the history: its id, name, reason and clock. `created_at` is an
 * instant in UTC, which the tracker shows in the visitor's own zone. The user,
 * driver, remarks and coordinates on the row are never read.
 */
function rowOf(value: unknown, index: number): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Veloces returned an invalid history row');
  const { code, name } = statusOf(value.shipment_status);
  if (value.shipment_status_id !== undefined && value.shipment_status_id !== null && statusId(value.shipment_status_id) !== code) {
    throw new SchemaError(PROVIDER, 'Veloces returned a history row with two statuses');
  }
  const clock = typeof value.created_at === 'string' ? explicitOffsetTime(value.created_at) : null;
  if (!clock) throw new SchemaError(PROVIDER, 'Veloces returned a history row without an offset clock');
  const reason = reasonOf(value.shipment_return_reason);
  const description = reason ? `${name}: ${reason}` : name;
  const staged = velocesStage(code, name);
  return {
    event: { time: clock.iso, description, provider_code: code, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
    timestamp: clock.timestamp,
    attempt: attemptOf(value.shipment_try),
    index,
  };
}

/**
 * The reply of the tracker's `GET /veloces/shipments/{guide}/tracking`: the
 * shipment record with its current status and its history, oldest first. The
 * record must be the guide asked. The origin, destination, driver, proof of
 * delivery, payment and collection details in it are never read.
 */
export function parseVeloces(payload: unknown, raw: string): CarrierResult {
  const number = normalizeVelocesNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Veloces returned an unexpected reply');
  if (payload.error_code === 404) throw new NotFoundError(PROVIDER);
  if (typeof payload.tracking_number !== 'string') throw new SchemaError(PROVIDER, 'Veloces returned a shipment without its guide');
  if (clean(payload.tracking_number, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Veloces answered for another shipment');
  const summary = payload.shipment_status === null || payload.shipment_status === undefined ? null : statusOf(payload.shipment_status);
  const history = payload.shipment_status_history ?? [];
  if (!Array.isArray(history) || history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Veloces returned an invalid history');

  const seen = new Set<string>();
  const rows = (history as unknown[]).map(rowOf).filter((row) => {
    // The tracker shows a warehouse status once per attempt, the first time it was logged.
    const key = ONCE_PER_ATTEMPT.has(row.event.provider_code) ? `${row.attempt}|${row.event.provider_code}`
      : `${row.event.time}|${row.event.provider_code}|${row.event.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  // Newest first; of two rows on one clock, the later in the reply is newer.
  }).sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);

  const newest = rows[0];
  if (!newest && !summary) throw new NoHistoryError(PROVIDER);
  const summaryStage = summary ? velocesStage(summary.code, summary.name) : null;
  const scanned = rows.find((row) => row.event.stage)?.event;
  const stage = (summaryStage?.stage ?? scanned?.stage) as Stage | undefined;
  const source = summaryStage?.source ?? scanned?.stage_source;
  // The newest row says more than the summary's name when it is the same status, as a reason.
  const text = newest && (!summary || newest.event.provider_code === summary.code) ? newest.event.description : summary!.name;
  const delivered = stage === 'delivered' ? rows.find((row) => row.event.provider_code === DELIVERED) : undefined;
  const events = rows.map((row) => row.event);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: text,
    ...(events.length ? {} : { provider_code: summary!.code, summary_only: true }),
    last_update: newest?.event.time ?? null,
    ...(delivered ? { delivered_at: delivered.event.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
