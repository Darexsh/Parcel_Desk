import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { toyouStage } from './status.js';

export const PROVIDER = 'toyou';
export const TOYOU_MAX_BYTES = 1_000_000;

/** The public form accepts an alphanumeric parcel id of thirteen to sixteen characters. */
export function normalizeToyouNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{13,16}$/.test(number)) throw new InvalidInputError(PROVIDER, 'toyou needs a thirteen to sixteen character parcel id');
  return number;
}

function wallClock(raw: unknown): string {
  if (typeof raw !== 'string' || !/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]), \d{4}, (?:[1-9]|1[0-2]):[0-5]\d:[0-5]\d (?:AM|PM)$/.test(raw)) {
    throw new SchemaError(PROVIDER, 'toyou returned an invalid event clock');
  }
  // UTC validates digits only. The API states no offset for this clock.
  const date = DateTime.fromFormat(raw, 'LLL d, yyyy, h:mm:ss a', { locale: 'en-US', zone: 'UTC' });
  if (!date.isValid || date.toFormat('LLL d, yyyy, h:mm:ss a') !== raw) throw new SchemaError(PROVIDER, 'toyou returned an invalid event day');
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The parcel API's structured negative carries the whole queried parcel id. */
function missing(payload: Record<string, unknown>, number: string): boolean {
  if (payload.status !== 'FAIL' || payload.payload !== null || !Array.isArray(payload.errors) || payload.errors.length !== 1) return false;
  const error: unknown = payload.errors[0];
  if (!isRecord(error) || error.code !== '102' || error.category !== 'REQUEST'
    || error.description !== 'No content found for given input' || !isRecord(error.errorIdentifiers)
    || !Array.isArray(error.errorIdentifiers.entry) || error.errorIdentifiers.entry.length !== 1) return false;
  const entry: unknown = error.errorIdentifiers.entry[0];
  return isRecord(entry) && entry.key === 'fields' && isRecord(entry.value)
    && typeof entry.value.parcelID === 'string' && normalizeTrackingNumber(entry.value.parcelID) === number;
}

/** Read only the whole-id customer history, excluding order capabilities and personal data. */
export function parseToyou(payload: unknown, raw: string): CarrierResult {
  const number = normalizeToyouNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'string' || !Array.isArray(payload.errors)) throw new SchemaError(PROVIDER, 'toyou returned an invalid tracking envelope');
  if (missing(payload, number)) throw new NotFoundError(PROVIDER);
  if (payload.status !== 'OK') throw new IndeterminateError(PROVIDER, 'toyou did not complete the parcel lookup');
  if (payload.errors.length) throw new SchemaError(PROVIDER, 'toyou returned conflicting tracking results');
  if (payload.payload == null || (Array.isArray(payload.payload) && !payload.payload.length)) throw new NoHistoryError(PROVIDER);
  if (!Array.isArray(payload.payload)) throw new SchemaError(PROVIDER, 'toyou returned an invalid parcel list');
  if (payload.payload.length !== 1) throw new IndeterminateError(PROVIDER, 'toyou returned several parcels');
  const parcel: unknown = payload.payload[0];
  if (!isRecord(parcel) || typeof parcel.parcelId !== 'string') throw new SchemaError(PROVIDER, 'toyou returned no parcel identity');
  if (normalizeTrackingNumber(parcel.parcelId) !== number) throw new IndeterminateError(PROVIDER, 'toyou answered for another parcel');
  if (!Array.isArray(parcel.customerDetails)) throw new SchemaError(PROVIDER, 'toyou returned invalid customer history');
  if (!parcel.customerDetails.length) throw new NoHistoryError(PROVIDER);
  if (parcel.customerDetails.length > 500) throw new SchemaError(PROVIDER, 'toyou returned too many events');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of parcel.customerDetails) {
    if (!isRecord(row) || typeof row.message !== 'string' || row.message.length > 2000) throw new SchemaError(PROVIDER, 'toyou returned an invalid event');
    const description = clean(row.message, 500);
    if (!description) throw new SchemaError(PROVIDER, 'toyou returned an unnamed event');
    const local = wallClock(row.dateAndTime), key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = toyouStage(description);
    events.push({ local_time: local, description, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
  }
  events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const current = events.find(event => event.stage);
  return {
    status: current?.stage ? languageStageStatus(current.stage as Stage) : 'unknown',
    ...(current?.stage ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: events[0]!.description!, last_update: null, last_update_local: events[0]!.local_time!,
    expected_delivery: null, events,
  };
}
