import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { israelPostStage } from './status.js';

export const PROVIDER = 'Israel Post';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** Postal S10 items, including imports, and Israel Post's domestic courier identifiers. */
export function normalizeIsraelPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number) || /^\d{11}IL$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Israel Post requires an S10 item or domestic courier number');
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new SchemaError(PROVIDER, 'Israel Post returned invalid scan text');
  }
  return clean(value, 500);
}

/** The native guest read returns an identity and Maslul, newest first. */
export function parseIsraelPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeIsraelPostNumber(raw);
  if (!isRecord(payload) || typeof payload.ItemCode !== 'string' || !/^[A-Z0-9]{13}$/i.test(payload.ItemCode)) {
    throw new SchemaError(PROVIDER, 'Israel Post returned no item identity');
  }
  if (payload.ItemCode.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Israel Post answered for another item');
  const rows = payload.Maslul;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Israel Post returned an invalid history');
  // The service echoes unknown identifiers with a default category. That shell
  // establishes neither a shipment nor definite absence from the postal network.
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !Number.isInteger(row.CategoryCode) || ((row.CategoryCode as number) < 0 || (row.CategoryCode as number) > 9999)) {
      throw new SchemaError(PROVIDER, 'Israel Post returned an invalid event category');
    }
    const written = row.StatusDate;
    if (typeof written !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(written)) {
      throw new SchemaError(PROVIDER, 'Israel Post returned an event without its day');
    }
    const date = DateTime.fromFormat(written, 'dd/MM/yyyy', { zone: 'UTC' });
    if (!date.isValid) throw new SchemaError(PROVIDER, 'Israel Post returned an invalid event day');
    const code = String(row.CategoryCode);
    const description = text(row.Status);
    const event: CarrierEvent = { local_time: date.toISODate(), description, provider_code: code };
    const stage = israelPostStage(code);
    if (stage) Object.assign(event, { stage, stage_source: 'carrier_map' });
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Preserve the server's order within a day; there is no time of day to infer.
  events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  const newest = events[0]!;
  const stage = israelPostStage(newest.provider_code!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, events: events.slice(0, MAX_EVENTS),
    // The carrier warns that registered-item tracking covers its domestic leg.
    // Let enabled providers supplement the history, including foreign scans.
    history_truncated: true,
  };
}
