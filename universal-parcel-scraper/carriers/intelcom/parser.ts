import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { DateTime } from 'luxon';
import { epochMillisTime, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar, textFromHtml } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { intelcomCodeStage } from './status.js';

const PROVIDER = 'Intelcom / Dragonfly';
// Clients the tracking page names as "Package from …". It names no other
// client code, so neither does the adapter.
const SHOWN_CLIENTS: Readonly<Record<string, string>> = {
  AMAZON: 'AMAZON', BKDEPOT: 'Book Depot', BROWNS: 'BROWNS', CANTIRE: 'Canadian Tire', DYNAMITE: 'DYNAMITE',
  GTIGER: 'Giant Tiger', INDITEX: 'INDITEX', JARJAFL: 'Jarja Floral', JEANCOUTU: 'Jean Coutu', LATULIPPE: 'LATULIPPE',
  NSPRSO: 'Nespresso', PINKCH: 'TBMBM', QCLS: 'Québec Loisirs', REPCLR: 'Replicolor', SIMONS: 'SIMONS',
  WALMART: 'WALMART', WOOFPACK: 'Woof Pack',
};

export function normalizeIntelcomNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Intelcom requires an alphanumeric tracking number');
  return number;
}

function scanTime(value: unknown) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000
      ? epochMillisTime(value) : null;
  }
  const clock = clean(value, 64);
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](\d{2}):?(\d{2}))$/i.exec(clock);
  if (!match) return null;
  // Luxon normalizes malformed offsets, so establish their bounds first.
  if (match[1] !== undefined && (Number(match[1]) > 14 || Number(match[2]) > 59
    || (Number(match[1]) === 14 && Number(match[2]) !== 0))) return null;
  return explicitOffsetTime(clock);
}

function scan(raw: unknown): CarrierEvent {
  if (!isRecord(raw) || cleanScalar(raw.status) === '' || !/^-?\d+(?:\.\d+)?$/.test(cleanScalar(raw.step))) {
    throw new SchemaError(PROVIDER, 'Intelcom returned an invalid status');
  }
  const labels = isRecord(raw.labels) ? raw.labels : {};
  const nested = isRecord(labels.shortLabel) ? labels.shortLabel : {};
  const direct = isRecord(raw.shortLabel) ? raw.shortLabel : {};
  // Public labels can contain recipient-address template tokens. Keep the
  // short milestone wording; never expand them using the address object.
  const description = textFromHtml((clean(nested.en) || clean(direct.en)).replace(/\{[^}]+\}/g, '')).trim();
  if (!description) throw new SchemaError(PROVIDER, 'Intelcom returned no English milestone label');
  const code = cleanScalar(raw.statusCode) || cleanScalar(raw.status);
  // The delivered flag also marks a return collected from the customer.
  const stage = intelcomCodeStage(code) ?? (raw.isDelivered === true && raw.task_type !== 'last_mile_pickup' ? 'delivered' : undefined);
  const mapped = stage ? { stage, source: 'carrier_map' } : classifyWording(description, 'pending');
  const time = scanTime(raw.timestamp);
  return { description, provider_code: code, ...(time ? { time: time.iso } : { provider_time_text: cleanScalar(raw.timestamp) || undefined }),
    ...(mapped.source !== 'none' ? { stage: mapped.stage, stage_source: mapped.source } : {}) };
}

/**
 * The estimate the tracking page shows: a time window once a driver has the
 * parcel, otherwise a day. It shows none for pickups, problems or deliveries,
 * nor once the window has passed.
 */
function estimate(result: JsonObject, latest: JsonObject, after: number | null): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const type = latest.etaType;
  if (latest.showEta !== true || (type !== 'time' && type !== 'period') || latest.isDelivered === true
    || latest.task_type === 'last_mile_pickup' || !(Number(cleanScalar(latest.step)) > 0) || !isRecord(result.public_eta)) return {};
  const from = typeof result.public_eta.from === 'string' ? explicitOffsetTime(result.public_eta.from) : null;
  const to = typeof result.public_eta.to === 'string' ? explicitOffsetTime(result.public_eta.to) : null;
  const end = to ?? from;
  if (!end || (from && to && to.timestamp < from.timestamp) || (after !== null && end.timestamp < after)) return {};
  if (type === 'time') return { expected_delivery: end.iso, ...(from && to && from.timestamp !== to.timestamp ? { expected_delivery_from: from.iso } : {}) };
  // A day is taken in the timezone of the service's own estimate.
  const clock = typeof result.eta === 'string' && explicitOffsetTime(result.eta) ? DateTime.fromISO(clean(result.eta, 64), { setZone: true }) : null;
  if (!clock?.isValid) return {};
  const day = (time: { timestamp: number }) => DateTime.fromMillis(time.timestamp, { zone: clock.zone }).toISODate();
  const last = day(end); const first = from ? day(from) : null;
  return last ? { expected_delivery: last, ...(first && first !== last ? { expected_delivery_from: first } : {}) } : {};
}

export function parseIntelcom(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeIntelcomNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.success !== 'boolean' || !isRecord(payload.data)) throw new SchemaError(PROVIDER, 'Intelcom returned an invalid envelope');
  if (!payload.success) {
    if (payload.data.code === 'not_found' && payload.data.result === null) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Intelcom did not complete the lookup');
  }
  const result = payload.data.result;
  if (!isRecord(result) || clean(result.tracking_id) !== number) throw new SchemaError(PROVIDER, 'Intelcom returned a different shipment');
  const latest = scan(result.last_status);
  const latestRaw = result.last_status as JsonObject;
  const history = result.status_list ?? [];
  if (!Array.isArray(history) || history.length > 1000) throw new SchemaError(PROVIDER, 'Intelcom returned an invalid history');
  const events = history.map(scan);
  if (!events.length && !latest.time) throw new IndeterminateError(PROVIDER, 'Intelcom returned no dated shipment activity');
  // A return collected from the customer goes to the client, which is then its recipient, not its sender:
  // null drops the client an earlier check named.
  const collected = [latestRaw, ...(history as unknown[])].some(row => isRecord(row) && row.task_type === 'last_mile_pickup');
  const client = typeof result.client_code === 'string' && Object.hasOwn(SHOWN_CLIENTS, result.client_code) ? SHOWN_CLIENTS[result.client_code] : undefined;
  const output: CarrierResult = { status: latest.stage ? languageStageStatus(latest.stage as Stage) : 'unknown',
    last_status_text: latest.description!, last_update: latest.time ?? null,
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    ...(latest.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...estimate(result, latestRaw, latest.time ? Date.parse(latest.time) : null),
    ...(collected ? { sender_name: null } : client ? { sender_name: client } : {}),
    ...(events.length ? { events: events.slice(0, 100) } : { summary_only: true, events: [] }) };
  return output;
}
