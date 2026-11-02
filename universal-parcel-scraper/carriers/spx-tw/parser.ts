import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { spxTwStage } from './status.js';

export const PROVIDER = 'SPX Express Taiwan';
export const SPX_TW_MAX_BYTES = 1_000_000;
// TW, twelve digits and a final digit or letter.
const NUMBER = /^TW\d{12}[0-9A-Z]$/;
// The feed's answer for a parcel whose scans it no longer holds.
const NO_HISTORY = -1217;
const STATUS = /^[A-Za-z0-9_]{1,64}$/;
const READY = 'SP_Ready_Collection';
// The pickup store, in brackets at the end of the arrival line.
const STORE = /\[([^\]]{1,100})\]\s*$/;
// The bracketed name the feed puts after a delivery elsewhere.
const NAMED = /\s*\[[^\]]*\]\s*$/;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;

/** A number for SPX Taiwan's tracker; anything else is not one it issues. */
export function normalizeSpxTwNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SPX Express Taiwan numbers are TW, twelve digits and a final digit or letter');
  return number;
}

function projectRow(row: Record<string, unknown>): CarrierEvent {
  if (typeof row.status !== 'string' || !STATUS.test(row.status.trim())) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned an invalid status');
  const code = row.status.trim();
  if (typeof row.message !== 'string') throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned a scan without wording');
  const line = clean(row.message, 500);
  const description = code === 'Delivered' ? clean(line.replace(NAMED, ''), 500) : line;
  if (!description) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned a scan without wording');
  const clock = row.timestamp;
  const time = typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 1_000_000_000 && clock < 10_000_000_000
    ? epochSecondsTime(clock)?.iso : undefined;
  if (!time) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned an invalid scan time');
  const store = code === READY ? clean(STORE.exec(line)?.[1], 100) : '';
  const staged = spxTwStage(code, description);
  return {
    time, ...(store ? { location: store } : {}), description, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The legacy feed's reply for one number. The feed names no missing parcel:
 * an unknown number fails like any other lookup, so only a reply naming the
 * number asked counts. Shopee's gateway answers a refused request with an
 * action instead of a reply, and a checksum it rejects with empty data.
 */
export function parseSpxTw(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSpxTwNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned an invalid envelope');
  if (payload.retcode === undefined && (payload.action_type !== undefined || payload.redirect_to_error_page !== undefined)) {
    throw new ChallengeError(PROVIDER, "SPX Express Taiwan's gateway refused the lookup");
  }
  if (typeof payload.retcode !== 'number') throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned an invalid envelope');
  if (payload.retcode === NO_HISTORY) throw new NoHistoryError(PROVIDER);
  if (payload.retcode !== 0) throw new IndeterminateError(PROVIDER, 'SPX Express Taiwan did not complete the lookup');
  if (!isRecord(payload.data)) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned no tracking data');
  const data = payload.data;
  if (!Object.keys(data).length) throw new IndeterminateError(PROVIDER, 'SPX Express Taiwan returned an empty reply');
  if (typeof data.sls_tracking_number !== 'string') throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned a shipment without its number');
  if (normalizeTrackingNumber(clean(data.sls_tracking_number, 64)) !== number) throw new IndeterminateError(PROVIDER, 'SPX Express Taiwan answered for another shipment');
  const rows = data.tracking_list ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SPX Express Taiwan returned an invalid scan');
    const event = projectRow(row);
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time : undefined;
  // The store a parcel waits at is the place of its newest arrival there.
  const store = events.find((event) => event.provider_code === READY && event.location)?.location;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(store ? { pickup_point: store } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
