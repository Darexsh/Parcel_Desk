import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { taqbinHkStage } from './status.js';

export const PROVIDER = 'TA-Q-BIN Hong Kong';
export const TAQBIN_HK_MAX_BYTES = 256 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The official homepage routes these numeric prefixes to its separate PMS
// e-commerce tracker: https://www.yamatohk.com.hk/
const ECOMMERCE = /^(?:1848|2162|276[56]|9729|[34]|9009|901[0-4]|6213|0171)\d+/;

/** Only the verified waybill service; this layout alone establishes no carrier ownership. */
export function taqbinHkWaybill(raw: string): string | null {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  return /^\d{12}$/.test(number) && !ECOMMERCE.test(number) ? number : null;
}

function text(row: Record<string, unknown>, key: string, maxLength: number, required = false): string {
  const value = row[key];
  if (!required && (value === undefined || value === null)) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TA-Q-BIN Hong Kong returned an invalid ${key}`);
  const cleaned = clean(value, maxLength);
  if (required && !cleaned) throw new SchemaError(PROVIDER, `TA-Q-BIN Hong Kong returned an empty ${key}`);
  return cleaned;
}

/**
 * The single-waybill POST returns an ASP.NET `d` string containing its scans,
 * without an identifier echo. Retrieval binds it to the whole requested
 * waybill and the Hong Kong service, rather than a group-wide Yamato lookup.
 * The clock has no offset; its original minute or second precision stays.
 * Reasons and operator names are not read because they can identify people.
 */
export function parseTaqbinHkWaybill(payload: unknown): CarrierResult {
  if (!isRecord(payload) || typeof payload.d !== 'string') throw new SchemaError(PROVIDER, 'TA-Q-BIN Hong Kong returned an invalid waybill reply');
  let rows: unknown;
  try { rows = JSON.parse(payload.d); }
  catch { throw new SchemaError(PROVIDER, 'TA-Q-BIN Hong Kong returned invalid waybill scans'); }
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TA-Q-BIN Hong Kong returned an invalid scan list');
  // This service also forgets old records and does not cover every e-commerce parcel.
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'TA-Q-BIN Hong Kong has no history in its waybill service');

  let total: number | undefined;
  const scans: { event: CarrierEvent; at: number; index: number }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TA-Q-BIN Hong Kong returned an invalid scan');
    const count = row.noofrecords;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < rows.length || (total !== undefined && total !== count)) {
      throw new SchemaError(PROVIDER, 'TA-Q-BIN Hong Kong returned an invalid history count');
    }
    total = count;
    const date = text(row, 'createddatecaption', 40, true);
    const clock = text(row, 'createdtimecaption', 40, true);
    const local = `${date}T${clock}`;
    const parsed = DateTime.fromISO(local, { zone: 'UTC' });
    const format = clock.length === 5 ? "yyyy-MM-dd'T'HH:mm" : "yyyy-MM-dd'T'HH:mm:ss";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(clock)
      || !parsed.isValid || parsed.toFormat(format) !== local) throw new SchemaError(PROVIDER, 'TA-Q-BIN Hong Kong returned an invalid scan clock');
    const description = text(row, 'status', 300, true);
    const location = text(row, 'location', 120);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = taqbinHkStage(description);
    scans.push({ at: parsed.toMillis(), index: scans.length, event: {
      local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  scans.sort((left, right) => right.at - left.at || left.index - right.index);
  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const staged = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time!, expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(total! > rows.length || events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
