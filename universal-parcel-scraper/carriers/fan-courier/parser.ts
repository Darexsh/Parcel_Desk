import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fanCourierStage } from './status.js';

export const PROVIDER = 'FAN Courier';

const MAX_EVENTS = 500;
// The tracker's answer for an AWB it does not know, in English and in Romanian.
const ABSENT = new Set(['the awb was not found', 'awb-ul nu a fost gasit']);

/** A thirteen-digit AWB, the only length FAN Courier's documentation, clients and tracker show. */
export function normalizeFanCourierNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{13}$/.test(number)) throw new InvalidInputError(PROVIDER, 'FAN Courier requires a thirteen-digit AWB number');
  return number;
}

/** A scan's wall clock. The reply gives no offset, so the clock stays local. */
function clock(raw: unknown): { local_time?: string; provider_time_text?: string } {
  if (raw != null && typeof raw !== 'string') throw new SchemaError(PROVIDER, 'FAN Courier returned an invalid scan clock');
  const text = clean(raw, 32);
  const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
  return parsed?.isValid ? { local_time: parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) }
    : text ? { provider_time_text: text } : {};
}

/**
 * The tracker's reply for one AWB: its events, oldest first, each with its
 * code, wording, town and wall clock. The contents, weight, dimensions, the
 * payment date, the related AWBs and the masked name of whoever signed are
 * never read.
 */
export function parseFanCourier(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFanCourierNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (payload.awbNumber == null) {
    // An unknown AWB comes back without one, the requested number in `content`
    // and the page's message.
    const message = clean(payload.message, 200).toLowerCase().replace(/\.$/, '');
    if (!ABSENT.has(message)) throw new IndeterminateError(PROVIDER, 'FAN Courier did not return the AWB');
    if (returnedTrackingNumber(payload.content, true) !== number) {
      throw new SchemaError(PROVIDER, 'FAN Courier answered for a different number');
    }
    throw new NotFoundError(PROVIDER);
  }
  if (typeof payload.awbNumber !== 'string' && typeof payload.awbNumber !== 'number') throw new SchemaError(PROVIDER);
  if (returnedTrackingNumber(payload.awbNumber, true) !== number) {
    throw new SchemaError(PROVIDER, 'FAN Courier answered for a different AWB');
  }
  const rows = payload.events;
  if (!Array.isArray(rows) || rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'FAN Courier returned invalid events');
  // The tracker shows an error for an AWB without events: it proves neither a parcel on its way nor absence.
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'FAN Courier returned no events for the AWB');
  const scans = rows.map(row => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'FAN Courier returned an invalid event');
    const code = cleanScalar(row.id, 16);
    const description = clean(row.name, 300);
    if (!/^[A-Z]{1,3}\d{1,4}$/.test(code) || !description) {
      throw new SchemaError(PROVIDER, 'FAN Courier returned an event without its code or wording');
    }
    return { code, description, location: clean(row.location, 100), time: clock(row.date) };
  });
  // The tracker hides what follows the last delivery, as the page does.
  const delivered = scans.map(scan => scan.code).lastIndexOf('S2');
  const kept = delivered === -1 ? scans : scans.slice(0, delivered + 1);
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // Newest first; equal clocks keep the reply's order.
  for (const scan of kept.reverse()) {
    const stage = fanCourierStage(scan.code);
    const event: CarrierEvent = { description: scan.description, provider_code: scan.code, ...scan.time,
      ...(scan.location ? { location: scan.location } : {}), ...(stage ? { stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!;
  const stage = fanCourierStage(latest.provider_code!);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage } : {}),
    last_status_text: latest.description ?? null, last_update: null, last_update_local: latest.local_time ?? null,
    events };
}
