import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { safexpressStage } from './status.js';

export const PROVIDER = 'Safexpress';
const MAX_DETAILS = 1_000;
const MAX_EVENTS = 100;
const LABELS = new Set(['BOOKED', 'IN-TRANSIT', 'ARRIVED AT DESTINATION', 'OUT FOR DELIVERY', 'DELIVERED',
  'UN-DELIVERED', 'RE-BOOKED', 'TRANSACTION CLOSED']);

export function normalizeSafexpressNumber(raw: string): string {
  const number = raw.replace(/[\s-]/g, '');
  // These are the waybill lengths accepted by the official tracking form.
  if (!/^(?:\d{8,9}|\d{12}|\d{15})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Safexpress requires an eight-, nine-, twelve- or fifteen-digit waybill');
  }
  return number;
}

function identity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return normalizeSafexpressNumber(value); } catch { return null; }
}

type Clock = { time?: string; local_time?: string; order: number };

function clock(value: unknown, code: string): Clock | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) throw new SchemaError(PROVIDER, 'Safexpress returned an invalid scan clock');
  const raw = value.trim().replace(' ', 'T');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(raw);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
    || (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59))) {
    throw new SchemaError(PROVIDER, 'Safexpress returned an invalid scan clock');
  }
  if (match[7]) {
    const explicit = explicitOffsetTime(raw);
    if (!explicit) throw new SchemaError(PROVIDER, 'Safexpress returned an invalid scan clock');
    return { time: explicit.iso, order: explicit.timestamp };
  }
  // Booking midnight and delivery's end-of-day marker represent calendar days.
  // The delivery description names that same day without a delivery clock.
  const dayOnly = !match[4] || (code === 'BOOKED' && raw.endsWith('T00:00:00'))
    || (code === 'DELIVERED' && raw.endsWith('T23:59:59'));
  const local = dayOnly ? raw.slice(0, 10) : raw;
  const ordering = local.length === 10 ? `${local}T${code === 'DELIVERED' ? '23:59:59' : '00:00:00'}` : local;
  // The national network's clock is only used for ordering; the emitted clock keeps its provenance.
  return { local_time: local, order: Date.parse(`${ordering}+05:30`) };
}

function status(value: unknown): { label: string; code?: string } {
  if (typeof value !== 'string' || !value.trim()) throw new SchemaError(PROVIDER, 'Safexpress returned a scan without a status');
  const label = value.trim().toUpperCase();
  // Status is an enumeration. Unknown free-form values must not expose recipient text.
  return LABELS.has(label) ? { label, code: label } : { label: 'Tracking update' };
}

/** Only the tracker's facility templates may supply a place; delivery wording stays private. */
function facility(value: unknown, code: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > 140) return undefined;
  const prefix = code === 'BOOKED' ? 'Waybill Generated at ' : ['IN-TRANSIT', 'ARRIVED AT DESTINATION'].includes(code ?? '')
    ? 'Consignment Arrived at ' : null;
  if (!prefix || !value.startsWith(prefix)) return undefined;
  const name = value.slice(prefix.length).trim();
  return /^[A-Z][A-Z .&()-]{1,79}$/.test(name) ? name : undefined;
}

function count(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) throw new SchemaError(PROVIDER, 'Safexpress returned invalid package counts');
  return Number(value);
}

type Scan = { event: CarrierEvent; order: number; clock: string; code?: string; detail: boolean };

export function parseSafexpress(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeSafexpressNumber(rawNumber);
  if (!isRecord(payload) || payload.status !== 'Ok' || !isRecord(payload.data) || !Array.isArray(payload.data.tracking)
    || payload.data.tracking.length !== 1 || !isRecord(payload.data.tracking[0])) throw new SchemaError(PROVIDER);
  const item = payload.data.tracking[0];
  if (item.trackBy !== 'WB' || identity(item.wayblNo) !== number) {
    throw new SchemaError(PROVIDER, 'Safexpress did not return the requested waybill');
  }
  if (!Array.isArray(item.status) || item.status.length > 100 || !Array.isArray(item.details) || item.details.length > MAX_DETAILS) {
    throw new SchemaError(PROVIDER);
  }
  // The same empty reply serves unknown identifiers and failed/expired histories.
  if (!item.status.length && !item.details.length) throw new IndeterminateError(PROVIDER, 'Safexpress returned no tracking history');
  const total = count(item.ttlPkgs), delivered = count(item.dlvryPkgs);
  const partialDelivery = total !== null && delivered !== null && total > 0 && delivered < total;
  const scans: Scan[] = [];
  const add = (row: Record<string, unknown>, detail: boolean) => {
    const parsedStatus = status(row.status);
    const at = clock(detail ? row.eventDate : row.trackDate, parsedStatus.code ?? '');
    const isPartial = partialDelivery && parsedStatus.code === 'DELIVERED';
    const label = isPartial ? 'Partially delivered' : parsedStatus.label;
    const stage = safexpressStage(label);
    const location = detail ? facility(row.eventDesc, parsedStatus.code) : undefined;
    const event: CarrierEvent = { description: label, ...(at?.time ? { time: at.time } : {}),
      ...(at?.local_time ? { local_time: at.local_time } : {}), ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
      ...(!isPartial && parsedStatus.code ? { provider_code: parsedStatus.code } : {}),
      ...(!detail ? { summary_snapshot: true } : {}) };
    scans.push({ event, order: at?.order ?? Number.NEGATIVE_INFINITY, clock: at?.time ?? at?.local_time ?? '',
      code: parsedStatus.code, detail });
  };
  for (const row of item.details) {
    if (!isRecord(row) || identity(row.wayblNo) !== number) throw new SchemaError(PROVIDER, 'Safexpress returned a scan for another waybill');
    add(row, true);
  }
  for (const row of item.status) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER);
    const before = scans.length;
    add(row, false);
    const added = scans[before]!;
    if (added.clock && scans.slice(0, before).some(scan => scan.clock === added.clock && scan.code === added.code)) scans.pop();
  }
  const seen = new Set<string>();
  const unique = scans.filter((scan, index) => {
    const key = JSON.stringify([scan.clock || index, scan.event.description, scan.event.location]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => b.order - a.order || Number(b.detail) - Number(a.detail));
  const latest = unique[0];
  if (!latest) throw new IndeterminateError(PROVIDER, 'Safexpress returned no tracking history');
  const stage = safexpressStage(latest.event.description ?? '');
  const timedDetails = unique.filter(scan => scan.detail && scan.clock);
  const summaryOnly = timedDetails.length === 0;
  const incomplete = unique.length > MAX_EVENTS || unique.some(scan => scan.event.description === 'Partially delivered'
    || !scan.code || (scan.detail && !scan.clock));
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.event.description!, last_update: latest.event.time ?? null,
    ...(latest.event.local_time ? { last_update_local: latest.event.local_time } : {}),
    expected_delivery: null, timezone: 'Asia/Kolkata',
    ...(stage === 'delivered' ? { delivered_at: latest.event.time ?? latest.event.local_time ?? null } : {}),
    ...(summaryOnly ? { summary_only: true } : {}), ...(incomplete ? { history_truncated: true } : {}),
    events: unique.slice(0, MAX_EVENTS).map(scan => scan.event) };
}
