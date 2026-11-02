import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { CHECKSUMS } from '../../core/detection/checksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { russianPostStage } from './status.js';

export const PROVIDER = 'Russian Post';

/** GS1-filtered domestic barcodes and postal S10 items, including incoming mail. */
export function russianPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if ((/^\d{14}$/.test(number) && CHECKSUMS.gs1(number)) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Russian Post requires a domestic barcode or postal S10 item with a valid check digit');
}

function text(value: unknown, max = 320): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new SchemaError(PROVIDER, 'Russian Post returned invalid scan text');
  return clean(value, max);
}

/** The anonymous detailed read returns one whole trackingItem and its real scan history. */
export function parseRussianPost(payload: unknown, raw: string): CarrierResult {
  const number = russianPostNumber(raw);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0]) || !isRecord(payload[0].trackingItem)) {
    throw new SchemaError(PROVIDER, 'Russian Post returned an invalid tracking envelope');
  }
  const item = payload[0].trackingItem;
  if (typeof item.barcode !== 'string' || item.barcode.length > 64) throw new SchemaError(PROVIDER, 'Russian Post returned no item identity');
  if (normalizeTrackingNumber(item.barcode) !== number) throw new IndeterminateError(PROVIDER, 'Russian Post answered for another item');
  const rows = item.trackingHistoryItemList;
  if (!Array.isArray(rows) || rows.length > 1000) throw new SchemaError(PROVIDER, 'Russian Post returned an invalid history');
  // Unknown barcodes receive an echoed IN_PROGRESS shell with no operations.
  // Neither that default nor an empty array is evidence of a shipment or absence.
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let returnLeg = false;
  const history: unknown[] = rows;
  for (const row of [...history].reverse()) {
    if (!isRecord(row) || typeof row.operationType !== 'number' || typeof row.operationAttr !== 'number'
      || !Number.isInteger(row.operationType) || !Number.isInteger(row.operationAttr)
      || row.operationType < 0 || row.operationType > 9999 || row.operationAttr < 0 || row.operationAttr > 9999) {
      throw new SchemaError(PROVIDER, 'Russian Post returned an invalid operation code');
    }
    if (row.operationType === 3) returnLeg = true;
    const code = `${row.operationType}.${row.operationAttr}`;
    const description = text(row.humanStatus || row.humanOperationStatus);
    const time = typeof row.date === 'string' ? row.date : '';
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(time) || !explicitOffsetTime(time)) {
      throw new SchemaError(PROVIDER, 'Russian Post returned an invalid scan timestamp');
    }
    const city = row.cityName == null || row.cityName === '' ? '' : text(row.cityName, 160);
    const country = row.countryName == null || row.countryName === '' ? '' : text(row.countryName, 80);
    const location = [city, country].filter(Boolean).join(', ');
    const staged = russianPostStage(code, description, returnLeg || (row === history[0] && item.isReturned === true));
    const event: CarrierEvent = { time, description, provider_code: code, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  // The carrier supplies newest first, including its sequence for equal times.
  events.reverse();
  const newest = events[0]!;
  const destination = typeof item.destinationCountryName === 'string' ? countryCode(item.destinationCountryName) : null;
  return { status: newest.stage ? languageStageStatus(newest.stage as Stage) : 'unknown',
    ...(newest.stage ? { current_stage: newest.stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!, last_update: newest.time, expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 || (Array.isArray(item.hiddenHistoryList) && item.hiddenHistoryList.length > 0) ? { history_truncated: true } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(newest.stage === 'delivered' ? { delivered_at: newest.time } : {}) };
}
