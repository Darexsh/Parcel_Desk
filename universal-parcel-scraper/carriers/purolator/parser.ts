import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyPurolatorStatus } from './status.js';

export function normalizePurolatorNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?:[0-6]\d{11}|(?!BYS)[A-Z]{3}\d{9})$/.test(number)) throw new InvalidInputError('Purolator', 'Purolator requires a Purolator tracking PIN');
  return number;
}

// The calendar day Purolator expects to deliver on. It is kept while the
// parcel is still on its way and dropped once it is earlier than the newest
// scan's day, delivered, returned or waiting at a counter.
function estimatedDay(value: unknown, stage: string | undefined, latest: CarrierEvent): string | null {
  const day = clean(value, 16);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !DateTime.fromISO(day, { zone: 'UTC' }).isValid) return null;
  if (stage && ['delivered', 'returned', 'ready_for_pickup'].includes(stage)) return null;
  const clock = latest.local_time ?? latest.time;
  const latestDay = typeof clock === 'string' ? clock.slice(0, 10) : '';
  return latestDay && day < latestDay ? null : day;
}

export function parsePurolator(payload: unknown, number: string): CarrierResult {
  const requested = normalizePurolatorNumber(number);
  if (!isRecord(payload) || !Array.isArray(payload.searchResult) || payload.searchResult.length !== 1 || !isRecord(payload.searchResult[0])
    || !Array.isArray(payload.shipment) || payload.shipment.length > 100) throw new SchemaError('Purolator');
  const search = payload.searchResult[0];
  if (search.trackingId !== requested || search.sequenceId !== 1) throw new SchemaError('Purolator', 'Purolator returned a different search');
  // CONFLICT also occurs for an unknown-looking PIN. It is never a clean negative.
  // NOT FOUND covers numbers Purolator never issued and PINs whose history it no
  // longer keeps. The reason marks it as an answer about the number, not an outage.
  if (search.status !== 'FOUND') throw new IndeterminateError('Purolator', 'Purolator did not return a unique matching shipment',
    search.status === 'NOT FOUND' && search.shipmentIndex === -1 && !payload.shipment.length ? { reason: 'portal_not_found' } : {});
  if (search.type !== 'PIN' || !Number.isInteger(search.shipmentIndex) || !Number.isInteger(search.packageIndex)
    || (search.shipmentIndex as number) < 0 || (search.packageIndex as number) < 0) throw new SchemaError('Purolator');
  const shipment: unknown = payload.shipment[search.shipmentIndex as number];
  if (!isRecord(shipment) || !Array.isArray(shipment.package) || shipment.package.length > 100 || !shipment.package.every(isRecord)) throw new SchemaError('Purolator');
  const item = shipment.package[search.packageIndex as number];
  if (!item || item.pin !== requested || shipment.package.filter((candidate) => candidate.pin === requested).length !== 1) {
    throw new SchemaError('Purolator', 'Purolator did not return one matching package');
  }
  if (!Array.isArray(item.events) || item.events.length > 500) throw new SchemaError('Purolator');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const raw of item.events) {
    if (!isRecord(raw)) throw new SchemaError('Purolator', 'Purolator returned an incomplete scan row');
    const description = clean(raw.description, 500);
    const code = clean(raw.code, 64);
    if (!description || !code) throw new SchemaError('Purolator', 'Purolator returned a scan without wording or code');
    const rawTime = clean(raw.dateTime, 64);
    const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(rawTime)
      ? explicitOffsetTime(rawTime) : null;
    // The cross-country endpoint sends local wall clocks with no zone. UTC
    // validates the digits only; it is not assigned to the event.
    const wall = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawTime)
      ? DateTime.fromFormat(rawTime, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
    const local = wall?.isValid ? wall.toISO({ includeOffset: false, suppressMilliseconds: true }) : null;
    const location = isRecord(raw.location) ? [clean(raw.location.city, 100), clean(raw.location.provinceState, 32), clean(raw.location.countryCode, 2)].filter(Boolean).join(', ') : '';
    const key = `${instant?.iso ?? local ?? rawTime}\u0000${code}\u0000${description}\u0000${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = classifyPurolatorStatus(code);
    events.push({ description, provider_code: code, ...(location ? { location } : {}),
      ...(instant ? { time: instant.iso } : local ? { local_time: local } : rawTime ? { provider_time_text: rawTime } : {}),
      ...(mapped ? { stage: mapped.stage } : {}) });
  }
  if (!events.length) throw new IndeterminateError('Purolator', 'Purolator returned no tracking scans');
  // Request eventSortOrder=d and preserve that order, including unresolved clocks.
  const latest = events[0]!;
  const mapped = classifyPurolatorStatus(latest.provider_code ?? '');
  // Shipment weight describes the entire shipment; do not attach it to one
  // piece of a multi-package shipment.
  const measured = shipment.pieceTotalCount === 1 && shipment.package.length === 1 && isRecord(shipment.details) && isRecord(shipment.details.weight)
    ? shipment.details.weight : null;
  const weight = measured && typeof measured.value === 'number' && Number.isFinite(measured.value) && measured.value > 0 ? measured.value : null;
  const unit = measured ? clean(measured.unit, 8).toUpperCase() : '';
  const weightKg = weight !== null ? unit === 'LB' ? weight * 0.45359237 : unit === 'KG' ? weight : null : null;
  const destination = isRecord(shipment.details) ? clean(shipment.details.receiverCountryCode, 8) : '';
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: estimatedDay(item.estimatedDeliveryDate, mapped?.stage, latest),
    ...(mapped?.status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    ...(weightKg !== null ? { weight_kg: weightKg } : {}), events: events.slice(0, 100) };
}
