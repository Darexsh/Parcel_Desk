import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap } from './status.js';

export const PROVIDER = 'Day & Ross';
export const API = 'https://ece.dayrossgroup.com';
export const MAX_BYTES = 2_000_000;

export function normalizeDayRossNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{4,40}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER, 'Day & Ross requires a shipment number');
  return number;
}

/** Search accepts shipper references too; only the carrier's whole identifiers bind a match. */
export function dayRossOrder(payload: unknown, raw: string): Record<string, unknown> | null {
  const number = normalizeDayRossNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.orderItems) || payload.orderItems.length > 100
    || !Number.isSafeInteger(payload.total) || Number(payload.total) < 0 || payload.orderItems.some(row => !isRecord(row))) {
    throw new SchemaError(PROVIDER, 'Day & Ross returned an invalid shipment search');
  }
  if (!payload.orderItems.length && payload.total === 0) return null;
  const matches = payload.orderItems.filter(isRecord).filter(row => row.shipmentNumber === number || row.probillNumber === number);
  if (matches.length !== 1 || payload.total !== 1) throw new IndeterminateError(PROVIDER, 'Day & Ross matched an ambiguous or different shipment');
  const order = matches[0]!;
  const validOrderId = typeof order.orderId === 'number' ? Number.isSafeInteger(order.orderId) && order.orderId > 0
    : typeof order.orderId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(order.orderId);
  if (!validOrderId || (order.probillNumber != null
    && (typeof order.probillNumber !== 'string' || !/^[A-Z0-9]{4,40}$/.test(order.probillNumber)))) {
    throw new SchemaError(PROVIDER, 'Day & Ross returned no shipment identity');
  }
  return order;
}

function localClock(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { zone: 'utc' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

export function parseDayRoss(payload: unknown, raw: string, order: Record<string, unknown>): CarrierResult {
  const number = normalizeDayRossNumber(raw);
  if (!isRecord(payload) || payload.orderId !== order.orderId || payload.probillNumber !== order.probillNumber
    || (payload.shipmentNumber !== number && payload.probillNumber !== number)) {
    throw new SchemaError(PROVIDER, 'Day & Ross returned a different shipment');
  }
  if (!Array.isArray(payload.tracking) || payload.tracking.length > 500) throw new SchemaError(PROVIDER, 'Day & Ross returned invalid tracking days');
  const events: CarrierEvent[] = [];
  for (const day of payload.tracking) {
    if (!isRecord(day) || !Array.isArray(day.touchPoints) || day.touchPoints.length > 1000) throw new SchemaError(PROVIDER, 'Day & Ross returned invalid tracking scans');
    for (const row of day.touchPoints) {
      if (!isRecord(row) || typeof row.status !== 'string' || !row.status.trim() || typeof row.statusCode !== 'string'
        || (row.city != null && typeof row.city !== 'string')) throw new SchemaError(PROVIDER, 'Day & Ross returned an invalid scan');
      // These rows locate the vehicle, not a shipment milestone.
      if (row.statusCode === 'POSITION') continue;
      const local = localClock(row.time);
      if (!local) throw new SchemaError(PROVIDER, 'Day & Ross returned an invalid local scan clock');
      const stage = statusMap.stage(row.statusCode, '');
      events.push({ description: clean(row.status, 1000), provider_code: row.statusCode.slice(0, 100), local_time: local,
        ...(row.city ? { location: clean(row.city, 300) } : {}), ...(stage ? { stage, stage_source: 'carrier' } : {}) });
      if (events.length > 2000) throw new SchemaError(PROVIDER, 'Day & Ross returned too many scans');
    }
  }
  // Facility clocks carry no offset; preserve the service's sequence across facilities.
  events.reverse();
  const current = events.find(event => event.stage);
  const stage: Stage | undefined = payload.status === 'Delivered' ? 'delivered' : current?.stage as Stage | undefined;
  if (!events.length) throw new NoHistoryError(PROVIDER);
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage,
    current_stage_source: stage ? 'carrier' : undefined, events: events.slice(0, 100),
    last_status_text: events[0]!.description, last_update: null, last_update_local: events[0]!.local_time,
    ...(events.length > 100 ? { history_truncated: true } : {}),
    ...(typeof payload.serviceLevelDescription === 'string' && payload.serviceLevelDescription.trim()
      ? { service_name: clean(payload.serviceLevelDescription, 200) } : {}) };
}
