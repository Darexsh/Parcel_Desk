import { DateTime } from 'luxon';
import { isJntCargoTrackingNumber } from '../../core/detection/jntCargo.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { jntCargoStage } from './status.js';

export const JNT_CARGO_PROVIDER = 'j-and-t-cargo';
export const JNT_CARGO_ENDPOINT = 'https://office.jtcargo.co.id/official/waybill/trackingCustomerByWaybillNo';
export const JNT_CARGO_MAX_BYTES = 2_000_000;
const MAX_SCANS = 500;

export function normalizeJntCargoNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!isJntCargoTrackingNumber(number)) throw new InvalidInputError(JNT_CARGO_PROVIDER, 'J&T Cargo requires a supported master or piece waybill');
  return number;
}

function invalid(message = 'J&T Cargo returned an invalid tracking reply'): never {
  throw new SchemaError(JNT_CARGO_PROVIDER, message);
}

function optionalText(value: unknown, limit: number): string {
  if (value != null && typeof value !== 'string') invalid('J&T Cargo returned an invalid scan field');
  return clean(value, limit);
}

/** UTC validates the calendar only: Indonesia has three zones, and the feed establishes none. */
function localClock(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) {
    invalid('J&T Cargo returned an invalid scan clock');
  }
  const local = value.replace(' ', 'T');
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.year < 2000) invalid('J&T Cargo returned an invalid scan clock');
  return local;
}

function project(row: unknown, number: string): CarrierEvent {
  if (!isRecord(row) || row.billCode !== number) invalid('J&T Cargo returned a scan of a different waybill');
  const code = typeof row.code === 'number' && Number.isInteger(row.code) && row.code >= 0 && row.code <= 999999
    ? String(row.code) : typeof row.code === 'string' && /^\d{1,6}$/.test(row.code) ? row.code : invalid('J&T Cargo returned an invalid scan code');
  // These are the feed's fixed labels. The customer sentence, remarks, staff
  // and proof fields contain personal details and are never projected.
  const description = optionalText(row.status, 100) || optionalText(row.scanTypeName, 100);
  if (!description) invalid('J&T Cargo returned an empty scan label');
  const location = [optionalText(row.scanNetworkCity, 100), optionalText(row.scanNetworkProvince, 100)].filter(Boolean).join(', ');
  const mapped = jntCargoStage(code);
  const wording = mapped ? undefined : classifyWording(description, 'pending');
  return { description, local_time: localClock(row.scanTime), provider_code: code,
    ...(location ? { location } : {}),
    stage: mapped ?? wording!.stage, stage_source: mapped ? 'carrier_map' : wording!.source };
}

/** Parse exactly the requested master or piece, never an aggregate of related waybills. */
export function parseJntCargo(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeJntCargoNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.code !== 'number' || !Number.isInteger(payload.code)
    || typeof payload.succ !== 'boolean' || typeof payload.fail !== 'boolean') invalid();
  // The official client treats these as expired/refused account authentication.
  // A future gate must not be reported as a missing shipment.
  if ([148013016, 148013017].includes(payload.code)) throw new ChallengeError(JNT_CARGO_PROVIDER, 'J&T Cargo refused tracking authentication');
  if (payload.code !== 1 || !payload.succ || payload.fail) throw new IndeterminateError(JNT_CARGO_PROVIDER, 'J&T Cargo could not complete the tracking request');
  if (!Array.isArray(payload.data)) invalid();
  if (!payload.data.length) throw new IndeterminateError(JNT_CARGO_PROVIDER, 'J&T Cargo returned no identity-bound history');
  if (payload.data.length !== 1) invalid('J&T Cargo returned several waybills');
  const bill: unknown = payload.data[0];
  if (!isRecord(bill) || bill.keyword !== number) invalid('J&T Cargo returned a different waybill');
  // Unknown numbers return a success envelope with the query echoed and null
  // shipment fields. That placeholder does not establish absence or ownership,
  // but its reason tells J&T Cargo's answer from an outage.
  if (bill.details === null || Array.isArray(bill.details) && !bill.details.length) {
    throw new IndeterminateError(JNT_CARGO_PROVIDER, 'J&T Cargo returned the waybill without shipment history',
      bill.details === null ? { reason: 'portal_not_found' } : {});
  }
  if (!Array.isArray(bill.details)) invalid();
  if (bill.details.length > MAX_SCANS) invalid('J&T Cargo returned excessive tracking history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const scan of bill.details) {
    const event = project(scan, number);
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  // The public client displays this newest-first order. Local clocks cannot
  // safely reorder scans between facilities in different Indonesian zones.
  const latest = events[0]!;
  const stage = latest.stage_source === 'none' ? undefined : latest.stage as Stage | undefined;
  const service = optionalText(bill.expressTypeName, 80);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    ...(service ? { service_name: service } : {}), ...(events.length > 100 ? { history_truncated: true } : {}),
    events: events.slice(0, 100) };
}

export function parseJntCargoJson(text: string, number: string): CarrierResult {
  if (text.length > JNT_CARGO_MAX_BYTES || new TextEncoder().encode(text).length > JNT_CARGO_MAX_BYTES) invalid('J&T Cargo returned excessive tracking data');
  const body = text.replace(/^\uFEFF/, '').trim();
  if (/^</.test(body) && /<title>\s*Just a moment|cf-chl-|challenge-platform|cf-turnstile|captcha|access denied|captcha-delivery\.com/i.test(body)
    || /^access denied\b/i.test(body)) {
    throw new ChallengeError(JNT_CARGO_PROVIDER);
  }
  if (!body) throw new IndeterminateError(JNT_CARGO_PROVIDER, 'J&T Cargo returned an empty reply');
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { invalid('J&T Cargo returned invalid tracking JSON'); }
  return parseJntCargo(payload, number);
}
