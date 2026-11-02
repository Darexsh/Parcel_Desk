import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult, type CarrierStatus } from '../../core/result/index.js';
import { classifyWording } from '../../core/status/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isSpxPhFacilityCode, spxPhStage } from './status.js';

const PROVIDER = 'SPX Express Philippines';
export function normalizeSpxPhNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^(?:SPX|SPE)?PH\d{10,16}[A-Z]?$/.test(number)) throw new InvalidInputError(PROVIDER, 'SPX Philippines requires a Philippine tracking number');
  return number;
}
export function parseSpxPh(payload: unknown, raw: string, legacy = false): CarrierResult {
  const number = normalizeSpxPhNumber(raw);
  if (!isRecord(payload) || typeof payload.retcode !== 'number') throw new SchemaError(PROVIDER);
  if (payload.retcode !== 0) throw new IndeterminateError(PROVIDER, 'SPX Philippines could not return tracking details');
  if (!isRecord(payload.data)) throw new SchemaError(PROVIDER);
  const data = payload.data;
  if (!Object.keys(data).length) throw new IndeterminateError(PROVIDER, 'SPX Philippines returned no tracking history');
  const order = isRecord(data.order_info) ? data.order_info : {};
  const tracking = isRecord(data.sls_tracking_info) ? data.sls_tracking_info : {};
  const aliases = (legacy ? [data.sls_tracking_number] : [order.spx_tn, order.sls_tn, tracking.sls_tn])
    .filter((identity): identity is string => typeof identity === 'string' && Boolean(identity.trim()))
    .map(normalizeTrackingNumber);
  // Marketplace replies identify their shipment in the tracking object;
  // standalone orders also carry the order's references.
  // A queried alias must still match one of these carrier-supplied identities.
  if (!aliases.includes(number)) throw new SchemaError(PROVIDER, 'SPX Philippines returned a different shipment');
  // Parent/child freight orders require package-level aggregation; one child's
  // delivery does not complete the parent. This adapter handles single parcels.
  if (Array.isArray(data.children) && data.children.length) throw new IndeterminateError(PROVIDER, 'SPX freight orders require package-level tracking');
  const rawEvents = legacy ? data.tracking_list : tracking.records;
  if (!Array.isArray(rawEvents) || rawEvents.length > 1000) throw new SchemaError(PROVIDER);
  if (!rawEvents.length) throw new IndeterminateError(PROVIDER, 'SPX Philippines returned no tracking history');
  const events: CarrierEvent[] = rawEvents.flatMap(row => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SPX Philippines returned an invalid scan');
    for (const field of ['spx_tn', 'sls_tracking_number']) {
      if (row[field] !== undefined && (typeof row[field] !== 'string' || !aliases.includes(normalizeTrackingNumber(row[field])))) throw new SchemaError(PROVIDER, 'SPX Philippines returned mixed shipment history');
    }
    // The public frontend explicitly omits hidden modern records.
    if (!legacy && row.display_flag === 0) return [];
    const description = clean(legacy ? row.message : row.description, 1000);
    if (!description) throw new SchemaError(PROVIDER, 'SPX Philippines returned an empty scan');
    const clock = legacy ? row.timestamp : row.actual_time;
    const time = typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 1_000_000_000 && clock < 10_000_000_000 ? epochSecondsTime(clock)?.iso : undefined;
    // Modern rows carry a tracking code, legacy rows a status name.
    const rawCode = clean(legacy ? row.status : row.tracking_code, 64);
    const code = /^[A-Za-z0-9_]{1,64}$/.test(rawCode) ? rawCode : '';
    const own = code ? spxPhStage(code, legacy) : undefined;
    const mapped = own ? { stage: own, source: 'carrier_map' } : classifyWording(description, 'pending');
    const place = !legacy && isSpxPhFacilityCode(code) && isRecord(row.current_location) ? row.current_location : null;
    const location = clean(row.location, 200) || (place ? clean(place.location_name, 200) : '');
    const point = place ? eventPoint(place.lat, place.lng) : null;
    return [{ description, ...(time ? { time } : cleanScalar(clock, 64) ? { provider_time_text: cleanScalar(clock, 64) } : {}),
      ...(location ? { location } : {}), ...(point ? { point } : {}), ...(code ? { provider_code: code } : {}),
      ...(mapped.source !== 'none' ? { stage: mapped.stage, stage_source: mapped.source } : {}) }];
  });
  if (!events.length) throw new IndeterminateError(PROVIDER, 'SPX Philippines returned no visible tracking history');
  // A partial-clock comparator is not transitive and can move unresolved rows
  // across the provider's current-first sequence. Only fully dated history
  // can be reordered chronologically.
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const unique = events.filter((row, index) => events.findIndex(other => JSON.stringify(other) === JSON.stringify(row)) === index);
  const latest = unique[0]!;
  const status: CarrierStatus = latest.stage === 'delivered' ? 'delivered' : latest.stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['returned', 'exception', 'failed_attempt'].includes(latest.stage ?? '') ? 'exception'
      : ['registered', 'pending'].includes(latest.stage ?? '') ? 'pending' : latest.stage ? 'in_transit' : 'unknown';
  return { status, ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}), timezone: 'Asia/Manila', events: unique.slice(0, 100) };
}
