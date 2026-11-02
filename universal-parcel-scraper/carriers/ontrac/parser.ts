import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyOntracStatus } from './status.js';

const TRACKING_NUMBER = /^(?:[CD]\d{14}|L[AIEHNX]\d{8}|1LS[A-Z0-9]{12,14})$/;

export function normalizeOntracNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!TRACKING_NUMBER.test(number)) {
    throw new InvalidInputError('OnTrac', 'OnTrac requires an OnTrac or LaserShip tracking number');
  }
  return number;
}

/** A shipper's own reference, which OnTrac's tracker resolves to the parcel's number. */
const SHIPPER_REFERENCE = /^AD\d{9}$/;

/** What OnTrac's tracker is asked for: its own tracking number, or a shipper's AD reference. */
export function normalizeOntracRequest(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  return SHIPPER_REFERENCE.test(number) ? number : normalizeOntracNumber(number);
}

function unresolvedWallTime(value: unknown): string | null {
  const raw = clean(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(raw)) return null;
  // UTC validates the digits only; no timezone is assigned to this wall clock.
  const parsed = DateTime.fromISO(raw, { zone: 'UTC' });
  return parsed.isValid ? parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) : null;
}

export function parseOntrac(payload: unknown, number: string): CarrierResult {
  const requested = normalizeOntracRequest(number);
  if (!isRecord(payload) || !Array.isArray(payload.Packages) || payload.Packages.length > 100) {
    throw new SchemaError('OnTrac');
  }
  // A shipper's reference is not repeated in the reply: it must name one parcel, by OnTrac's own number.
  const reference = SHIPPER_REFERENCE.test(requested);
  if (reference && payload.Packages.length > 1) throw new IndeterminateError('OnTrac', 'OnTrac returned several parcels for this reference');
  const matches = payload.Packages.filter(isRecord).filter((item) => reference || clean(item.Tracking, 64).toUpperCase() === requested);
  if (matches.length !== 1) throw new SchemaError('OnTrac', 'OnTrac did not return one matching shipment');
  const item = matches[0]!;
  const canonical = reference ? clean(item.Tracking, 64).toUpperCase() : requested;
  if (reference && !TRACKING_NUMBER.test(canonical)) throw new SchemaError('OnTrac', 'OnTrac returned a parcel without its own tracking number');
  if (!Array.isArray(item.Events) || item.Events.length > 500) throw new SchemaError('OnTrac');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  item.Events.forEach((raw) => {
    if (!isRecord(raw)) throw new SchemaError('OnTrac', 'OnTrac returned an incomplete scan row');
    const code = clean(raw.EventCode, 32);
    const description = clean(raw.EventShortDescription, 500);
    if (!description) throw new SchemaError('OnTrac', 'OnTrac returned a scan with no description');
    const time = explicitOffsetTime(raw.ZonedEventDateTime) ?? explicitOffsetTime(raw.UtcEventDateTime);
    const local = time ? null : unresolvedWallTime(raw.ZonedEventDateTime) ?? unresolvedWallTime(raw.UtcEventDateTime);
    const location = [clean(raw.City, 100), clean(raw.State, 80)].filter(Boolean).join(', ');
    const clockText = clean(raw.ZonedEventDateTime, 64) || clean(raw.UtcEventDateTime, 64);
    const clock = time?.iso ?? local ?? clockText;
    const key = `${clock}\u0000${code}\u0000${description}\u0000${location}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mapped = classifyOntracStatus(code);
    events.push({ description, ...(time ? { time: time.iso } : {}), ...(local ? { local_time: local } : {}),
      ...(!time && !local && clockText ? { provider_time_text: clockText } : {}),
      ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}), ...(mapped ? { stage: mapped.stage } : {}) });
  });
  if (!events.length) throw new IndeterminateError('OnTrac', 'OnTrac returned no tracking scans');
  // The endpoint sends newest first, including scans whose clocks lack offsets.
  const latest = events[0]!;
  const mapped = classifyOntracStatus(latest.provider_code ?? '');
  const estimate = explicitOffsetTime(item.UtcExpectedDeliveryDateTime);
  const weight = typeof item.Weight === 'number' && Number.isFinite(item.Weight) && item.Weight > 0 ? item.Weight : null;
  const units = clean(item.WeightUnits, 16).toLowerCase();
  const weightKg = weight !== null ? (units === 'lbs' || units === 'lb' ? weight * 0.45359237 : units === 'kg' ? weight : null) : null;
  // Length, width and height in the unit OnTrac names; a missing or zero side drops all three.
  const sides = [item.Length, item.Width, item.Height];
  const sideUnits = clean(item.DimensionUnits, 16).toLowerCase();
  const dimensions = ['in', 'cm'].includes(sideUnits)
    && sides.every(side => typeof side === 'number' && Number.isFinite(side) && side > 0 && side < 10_000)
    ? `${sides.join(' × ')} ${sideUnits}` : null;
  return {
    status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: mapped?.status === 'delivered' ? null : estimate?.iso ?? null,
    ...(mapped?.status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(weightKg !== null ? { weight_kg: weightKg } : {}), ...(dimensions ? { dimensions_text: dimensions } : {}),
    ...(canonical !== requested ? { canonical_tracking_number: canonical } : {}),
    events: events.slice(0, 100),
  };
}
