import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { ecmsExpressStage } from './status.js';

export const PROVIDER = 'ECMS Express';
export const ECMS_MAX_BYTES = 1_000_000;

export function normalizeEcmsExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?:EC|ES|AP|AX)(?:[A-Z]{3}\d{11}|[A-Z]{4}\d{10}|[A-Z]{5}\d{9})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'ECMS Express requires a supported sixteen-character parcel reference');
  }
  return number;
}

export function isEcmsVerificationFailure(payload: unknown): boolean {
  return isRecord(payload) && payload.status === 500 && payload.message === 'verify failure';
}

function text(row: Record<string, unknown>, field: string, max = 300): string {
  const value = row[field];
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, 'ECMS returned an invalid scan field');
  return clean(value, max);
}

function identity(row: Record<string, unknown>, number: string): void {
  if (typeof row.trackingId !== 'string' || row.trackingId.trim().toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'ECMS answered for another parcel');
  }
}

function scan(row: unknown, number: string): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ECMS returned an invalid scan');
  identity(row, number);
  const code = text(row, 'eventCode', 40), description = text(row, 'eventDescription') || text(row, 'customDescription');
  if (!code || !description) throw new SchemaError(PROVIDER, 'ECMS returned no scan status');
  const clock = row.operatorTime;
  if (typeof clock !== 'number' || !Number.isSafeInteger(clock) || clock < 946684800000 || clock > 4102444800000) {
    throw new SchemaError(PROVIDER, 'ECMS returned an invalid scan clock');
  }
  // The portal renders UTC components of this value as the facility's wall clock.
  const local = new Date(clock).toISOString().slice(0, 19);
  const offset = row.timeZone;
  if (offset != null && (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > 14 || !Number.isInteger(offset * 60))) {
    throw new SchemaError(PROVIDER, 'ECMS returned an invalid scan offset');
  }
  // Zero is also used for unzoned partner scans. Preserve nonzero stated offsets,
  // including fixed standard offsets in summer, without replacing them with DST.
  const minutes = typeof offset === 'number' ? Math.abs(offset * 60) : 0;
  const time = typeof offset === 'number' && offset !== 0
    ? `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : undefined;
  const location = [...new Set(['cityEnName', 'provinceEnName', 'countryEnName'].map(key => text(row, key, 100)).filter(Boolean))].join(', ');
  const classified = ecmsExpressStage(code, description);
  return { local_time: local, ...(time ? { time } : {}), description, provider_code: code,
    ...(location ? { location } : {}), ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
}

export function parseEcmsExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEcmsExpressNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'number') throw new SchemaError(PROVIDER, 'ECMS returned an invalid envelope');
  if (payload.status === 429) throw new RateLimitedError(PROVIDER);
  if (isEcmsVerificationFailure(payload) || payload.status === 401 || payload.status === 403) throw new ChallengeError(PROVIDER, 'ECMS refused verification');
  if (payload.status !== 200) throw new IndeterminateError(PROVIDER, 'ECMS could not answer the lookup');
  if (!Array.isArray(payload.orderInfo) || !Array.isArray(payload.orderNumber)) throw new SchemaError(PROVIDER, 'ECMS returned an invalid shipment list');
  if (!payload.orderInfo.length && !payload.orderNumber.length) throw new NotFoundError(PROVIDER);
  if (payload.orderNumber.length !== 1 || typeof payload.orderNumber[0] !== 'string' || payload.orderNumber[0].trim().toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'ECMS did not confirm the requested parcel');
  }
  if (payload.orderInfo.length !== 1 || !isRecord(payload.orderInfo[0])) throw new SchemaError(PROVIDER, 'ECMS returned no unique shipment');
  const shipment = payload.orderInfo[0];
  if (!isRecord(shipment.baseInfo)) throw new SchemaError(PROVIDER, 'ECMS returned no shipment summary');
  identity(shipment.baseInfo, number);
  if (!Array.isArray(shipment.infoList) || shipment.infoList.length > 500) throw new SchemaError(PROVIDER, 'ECMS returned an invalid history');
  if (!shipment.infoList.length) throw new NoHistoryError(PROVIDER);
  const events = shipment.infoList.map(row => scan(row, number));
  const newest = scan(shipment.baseInfo, number);
  const classified = ecmsExpressStage(newest.provider_code!, newest.description!);
  const destination = text(shipment, 'consigneeCountry', 80).toUpperCase();
  const partner = isRecord(shipment.vendorConfig) && typeof shipment.vendorConfig.name === 'string'
    ? carrierIdFromPartner(shipment.vendorConfig.name) : undefined;
  const references = partner ? [...new Set(shipment.infoList.flatMap(row => {
    if (!isRecord(row) || typeof row.source !== 'string' || !row.source.startsWith('dc_')
      || carrierIdFromPartner(row.source.replace(/^dc_(?:PN_)?/, '')) !== partner
      || typeof row.orderCode !== 'string' || !/^[A-Z0-9]{4,40}$/.test(row.orderCode) || row.orderCode === number) return [];
    return [row.orderCode];
  }))] : [];
  return { status: classified ? languageStageStatus(classified.stage) : 'unknown',
    ...(classified ? { current_stage: classified.stage, current_stage_source: classified.source } : {}),
    provider_code: newest.provider_code!, last_status_text: newest.description!, last_update: newest.time ?? null,
    last_update_local: newest.local_time!, expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    ...(partner && partner !== 'ecms-express' ? { delivery_carrier: partner,
      ...(references.length === 1 ? { delivery_tracking_number: references[0]! } : {}) } : {}) };
}
