import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isStoReturnScan, STO_RETURN_LEG, STO_RETURN_STARTED, stoScan } from './status.js';

export const STO_PROVIDER = 'STO Express';
const ZONE = 'Asia/Shanghai';
const MAX_SCANS = 500;

/** Current waybills have fifteen digits; twelve- and thirteen-digit ones are older. */
export function normalizeStoNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^(?:\d{12,13}|\d{15})$/.test(number)) {
    throw new InvalidInputError(STO_PROVIDER, 'STO requires a 12-, 13- or 15-digit waybill number');
  }
  return number;
}

/**
 * The scanning facility and its province and city, as the places lookup reads
 * Chinese towns ("广东广州转运中心, 广东省广州市"). Facility names alone abbreviate both.
 */
function scanLocation(scan: Record<string, unknown>): string {
  const province = clean(scan.opOrgProvinceName, 50);
  const city = clean(scan.opOrgCityName, 50);
  const region = province && city && city !== province ? `${province}${city}` : city || province;
  return [clean(scan.opOrgName, 100), region].filter(Boolean).join(', ');
}

/** A scan's weight in kilograms; a scan that did not weigh the parcel has 0.0 or none. */
function scanWeight(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : clean(value, 20);
  const weight = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  return weight > 0 && weight <= 100_000 ? weight : undefined;
}

/** The getExternalTrace reply: an envelope around the requested waybill's scans, newest first. */
export function parseSto(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeStoNumber(trackingNumber);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') {
    throw new SchemaError(STO_PROVIDER, 'STO returned an invalid response envelope');
  }
  if (!payload.success) {
    const code = clean(payload.errorCode, 64);
    // The page's request signature was missing or refused: the constant may have changed.
    if (['VERIFY_MISSING', 'VERIFY_FAIL'].includes(code)) {
      throw new ChallengeError(STO_PROVIDER, 'STO refused the request signature');
    }
    throw new IndeterminateError(STO_PROVIDER, /^[A-Z][A-Z0-9_]*$/.test(code)
      ? `STO returned the error ${code}` : 'STO returned an inconclusive error');
  }
  if (!Array.isArray(payload.data) || payload.data.length > MAX_SCANS) {
    throw new SchemaError(STO_PROVIDER, 'STO returned an invalid scan list');
  }
  // Unknown and expired waybills both answer an empty list.
  if (!payload.data.length) throw new NotFoundError(STO_PROVIDER);
  const scans: unknown[] = payload.data;
  if (scans.some(scan => !isRecord(scan) || clean(scan.waybillNo, 64) !== number)) {
    throw new SchemaError(STO_PROVIDER, 'STO returned a different or mixed shipment identity');
  }

  const events: CarrierEvent[] = [];
  let returning = false;
  let weight: number | undefined;
  // Read oldest first, so that a return scan puts the later delivery-side scans on the way back.
  for (const scan of [...scans as Record<string, unknown>[]].reverse()) {
    const type = clean(scan.scanType, 32);
    if (!type) throw new SchemaError(STO_PROVIDER, 'STO returned a scan without a type');
    const mapped = stoScan(type);
    // A scan type naming a return (退回, 退件) starts the trip back to the sender.
    const returnScan = isStoReturnScan(type);
    if (returnScan) returning = true;
    const stage = returnScan ? 'exception' : returning && mapped?.stage === 'delivered' ? 'returned' : mapped?.stage;
    // Only scan types, facility places and weights are projected. STO's memo text
    // names couriers and stations with their phones, pickup addresses and signers.
    const next = type === '发件' ? clean(scan.nextOrgName, 100) : '';
    const description = returnScan ? STO_RETURN_STARTED
      : (returning && mapped ? STO_RETURN_LEG[mapped.stage] : undefined)
        ?? (mapped && next ? `${mapped.wording} for ${next}` : mapped?.wording ?? type);
    const location = scanLocation(scan);
    // Scales along the network weigh the parcel; the newest reading is kept.
    weight = scanWeight(scan.weight) ?? weight;
    // Domestic scan clocks are China wall clocks; an unreadable one stays as text.
    const clock = clean(scan.opTime, 64);
    const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(clock) ? zonedTime(clock, 'yyyy-MM-dd HH:mm:ss', ZONE) : null;
    events.push({ ...(parsed ? { time: parsed.iso } : clock ? { provider_time_text: clock } : {}),
      description, provider_code: type, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}), ...(returning ? { provider_leg: 'return' } : {}) });
  }
  // Back to STO's newest-first order. An exact repeat of a scan is dropped.
  const seen = new Set<string>();
  const unique = events.reverse().filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 100);
  const latest = unique[0]!;
  const status = latest.stage === 'returned' || latest.stage === 'exception' ? 'exception'
    : stoScan(latest.provider_code!)?.status ?? 'unknown';
  return {
    status,
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description,
    last_update: latest.time ?? null,
    ...(latest.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    expected_delivery: null,
    ...(weight === undefined ? {} : { weight_kg: weight }),
    timezone: ZONE,
    events: unique,
  };
}
