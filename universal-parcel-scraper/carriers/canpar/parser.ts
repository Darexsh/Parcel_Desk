import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { canparStatus } from './status.js';

/** What a number is to Canpar's tracker, which asks for each kind in its own way. */
export type CanparNumberKind = 'barcode' | 'short' | 'tag' | 'notice';

export interface CanparNumber { number: string; kind: CanparNumberKind }

// The shapes Canpar's FAQ gives: a parcel barcode is one of eight letters and
// 21 digits, or 8 to 20 in a shorter form; a pickup tag is P and 9 digits, a
// return label R and 8; a delivery notice left at the door is W and 8 or 9.
const SHAPES: readonly (readonly [CanparNumberKind, RegExp])[] = [
  ['barcode', /^[CDKLSUXZ]\d{21}$/],
  ['short', /^[CDKLSUXZ]\d{8,20}$/],
  ['tag', /^(?:P\d{9}|R\d{8})$/],
  ['notice', /^W\d{8,9}$/],
];
const BARCODE = /^[CDKLSUXZ]\d{8,21}$/;

export function canparNumber(raw: string): CanparNumber {
  const number = normalizeTrackingNumber(raw);
  const kind = SHAPES.find(([, shape]) => shape.test(number))?.[0];
  if (!kind) throw new InvalidInputError('Canpar', 'Canpar requires a parcel barcode, a pickup or return tag, or a delivery notice number');
  return { number, kind };
}

export function normalizeCanparNumber(raw: string): string {
  return canparNumber(raw).number;
}

/**
 * Whether a package Canpar lists is the one asked for. A barcode or a tag comes
 * back as asked. A short barcode can come back whole, with the sender's
 * eight-digit shipper number after its letter as Canpar's page inserts it. A
 * delivery notice lists the parcels it was left for under their own barcodes.
 */
function answers(barcode: unknown, { number, kind }: CanparNumber): barcode is string {
  if (typeof barcode !== 'string') return false;
  if (barcode === number) return true;
  if (kind === 'short') {
    return BARCODE.test(barcode) && barcode.length === number.length + 8
      && barcode.startsWith(number[0]!) && barcode.endsWith(number.slice(1));
  }
  return kind === 'notice' && BARCODE.test(barcode);
}

function clock(raw: unknown): { local_time?: string; provider_time_text?: string } {
  if (raw != null && typeof raw !== 'string') throw new SchemaError('Canpar', 'Canpar returned an invalid scan clock field');
  const text = clean(raw, 64);
  const parsed = /^\d{8} (?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(text)
    ? DateTime.fromFormat(text, 'yyyyMMdd HHmmss', { zone: 'UTC' }) : null;
  // The public client displays these digits as local clocks and ignores
  // time_shift. That field does not consistently describe a UTC offset.
  return parsed?.isValid ? { local_time: parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) }
    : text ? { provider_time_text: text } : {};
}

// Canpar's expected delivery day, kept while the parcel is on its way and
// dropped once a newer day's scan arrives or it is delivered or returned.
function estimatedDay(value: unknown, stage: string | undefined, latest: CarrierEvent): string | null {
  const day = DateTime.fromFormat(clean(value, 16), 'yyyyMMdd', { zone: 'UTC' });
  if (!day.isValid || (stage && ['delivered', 'returned', 'ready_for_pickup'].includes(stage))) return null;
  const iso = day.toISODate();
  const clock = latest.local_time;
  return typeof clock === 'string' && iso < clock.slice(0, 10) ? null : iso;
}

export function parseCanpar(payload: unknown, rawNumber: string): CarrierResult {
  const asked = canparNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError('Canpar');
  if (payload.error != null) {
    // Canpar's page answers this by asking for the shipper number or the
    // destination postal code, as several senders' parcels share the short form.
    if (asked.kind === 'short' && typeof payload.error === 'string' && payload.error.split('|')[0]!.trim() === 'Shipper num required') {
      throw new InputRequiredError('Canpar', 'postcode', 'Canpar finds this short barcode only with its destination postal code');
    }
    throw new IndeterminateError('Canpar', 'Canpar returned an inconclusive tracking response');
  }
  const packages = Array.isArray(payload.result) ? payload.result
    : isRecord(payload.result) ? payload.result.packages : null;
  if (!Array.isArray(packages) || packages.length > 25 || !packages.every(isRecord)) throw new SchemaError('Canpar');
  if (!packages.length) throw new IndeterminateError('Canpar', 'Canpar returned no parcel history', { reason: 'portal_not_found' });
  if (asked.kind === 'notice' && packages.length > 1 && packages.every(item => answers(item.barcode, asked))) {
    throw new IndeterminateError('Canpar', 'Canpar lists several parcels under the delivery notice', { reason: 'several_parcels' });
  }
  const item = packages[0]!;
  const barcode = item.barcode;
  if (packages.length !== 1 || !answers(barcode, asked)) {
    throw new SchemaError('Canpar', 'Canpar did not identify one matching parcel');
  }
  if (!Array.isArray(item.events) || item.events.length > 500) throw new SchemaError('Canpar');
  // Unknown barcodes can return an identity-shaped empty package. Its status
  // and delivered flag establish neither a registered parcel nor absence. Canpar
  // answered, so the reason tells it from an outage.
  if (!item.events.length) throw new IndeterminateError('Canpar', 'Canpar returned no parcel history', { reason: 'portal_not_found' });
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // The official widget displays this newest-first sequence without sorting.
  // Preserve equal-clock positions and cross-region local clocks.
  for (const row of item.events) {
    if (!isRecord(row)) throw new SchemaError('Canpar', 'Canpar returned an incomplete scan');
    const code = clean(row.code, 16);
    const description = clean(row.code_description_en, 500);
    if (!code || !description) throw new SchemaError('Canpar', 'Canpar returned a scan without status or wording');
    const mapped = canparStatus(code);
    const address = isRecord(row.address) ? row.address : null;
    const location = address ? [clean(address.city, 100), clean(address.province, 20)].filter(Boolean).join(', ') : '';
    const event: CarrierEvent = { description, provider_code: code, ...clock(row.local_date_time),
      ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!;
  const mapped = canparStatus(latest.provider_code!);
  const service = clean(item.service_description_en, 80);
  // RTN describes a completed return scan, not an instruction to relabel
  // every later scan. Native histories can resume movement and delivery.
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time ?? null,
    expected_delivery: estimatedDay(item.estimated_delivery_date, mapped?.stage, latest),
    ...(service ? { service_name: service } : {}), ...(barcode !== asked.number ? { canonical_tracking_number: barcode } : {}),
    events: events.slice(0, 100) };
}
