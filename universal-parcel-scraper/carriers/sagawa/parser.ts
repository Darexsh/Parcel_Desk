import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { sagawaState } from './status.js';

export const PROVIDER = 'Sagawa Express';
/** The widget's answer for a waybill it has no data for: unknown, not registered yet or past the inquiry period. */
const NO_DATA = 'E015020';
// The state sentence is generic. One that names a phone number keeps only its label.
const PHONE = /[0-9０-９][0-9０-９()（）‐－ー-]{7,}[0-9０-９]|TEL|ＴＥＬ|電話/i;

/** The waybill as the official app sends it: 10 or 12 digits, hyphens removed. */
export function normalizeSagawaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?:\d{10}|\d{12})$/.test(number)) throw new InvalidInputError(PROVIDER, 'Sagawa Express requires a 10- or 12-digit waybill number');
  return number;
}

/** The widget's current state, bound to the echoed waybill. It carries no scans, times or places. */
export function parseSagawaWidget(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSagawaNumber(raw);
  if (!isRecord(payload) || payload.code !== '200' || !isRecord(payload.baggageInfo)) {
    throw new SchemaError(PROVIDER, 'Sagawa Express returned an invalid widget reply');
  }
  const info = payload.baggageInfo;
  if (typeof info.trackingNo !== 'string' || info.trackingNo.length > 64 || normalizeTrackingNumber(info.trackingNo) !== number) {
    throw new SchemaError(PROVIDER, 'Sagawa Express returned a different waybill');
  }
  const code = info.state;
  const message = info.stateMassage;
  if (typeof code !== 'string' || !/^\d{4}$/.test(code) || typeof message !== 'string' || message.length > 1_000 || !clean(message)) {
    throw new SchemaError(PROVIDER, 'Sagawa Express returned an invalid state');
  }
  const text = clean(message, 300);
  const label = /^【[^【】]{1,40}】/.exec(text)?.[0];
  const shown = PHONE.test(message) ? label ?? null : text;
  const mapped = sagawaState(code);
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: code, last_status_text: shown, last_update: null, expected_delivery: null,
    timezone: 'Asia/Tokyo', summary_only: true, events: [] };
}

/** A 422 reply. Only the widget's no-data code says the waybill is unknown; other refusals prove nothing. */
export function sagawaRejection(payload: unknown): never {
  const errors = isRecord(payload) && payload.code === '422' ? payload.errors : undefined;
  if (!Array.isArray(errors) || !errors.length || errors.length > 20 || !errors.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Sagawa Express returned an invalid refusal');
  }
  if (errors.every(error => error.code === NO_DATA)) {
    throw new NotFoundError(PROVIDER, 'Sagawa Express has no data for this waybill: unknown, not registered yet or past the inquiry period');
  }
  throw new IndeterminateError(PROVIDER, 'Sagawa Express refused the widget request');
}
