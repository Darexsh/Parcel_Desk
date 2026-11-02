import { DateTime } from 'luxon';
import { isCttExpressTrackingNumber } from '../../core/detection/cttExpress.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { calendarDay, explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyCttExpressStatus } from './status.js';

/** A reply that carries an error in place of the shipment. */
export class CttExpressErrorReply extends IndeterminateError {}

export function normalizeCttExpressNumber(raw: string): string {
  const number = raw.replace(/[\s.-]/g, '');
  if (!isCttExpressTrackingNumber(number)) throw new InvalidInputError('CTT Express', 'CTT Express requires a Spanish shipment or single-package tracking number');
  return number;
}

type ScanClock = { time?: string; local_time?: string; provider_time_text?: string; time_zone?: string; time_zone_basis?: string };

function scanClock(value: unknown): ScanClock {
  const raw = clean(value, 64);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(raw)) {
    const instant = explicitOffsetTime(raw);
    if (instant) return { time: instant.iso };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)) {
    const wall = DateTime.fromISO(raw, { zone: 'UTC' });
    if (wall.isValid) return { local_time: wall.toISO({ includeOffset: false, suppressMilliseconds: true }) };
  }
  return raw ? { provider_time_text: raw } : {};
}

/**
 * The delivery steps CTT Express relays from CTT Portugal on a parcel CTT Portugal delivers: out
 * for delivery, a failed attempt, the delivery and availability at a pickup point. CTT Express
 * dates them at Lisbon's wall clock with Madrid's offset: CTT Portugal's own rows of the same
 * scans, with its offsets, are an hour later to the second, in winter and in summer. Its own
 * scans before the hand-over keep the instant it gives.
 */
const PORTUGAL_LEG = new Set(['1500', '1600', '2100', '2310', '2900']);

function lisbonClock(clock: ScanClock): ScanClock {
  if (!clock.time) return clock;
  const local = DateTime.fromISO(clock.time).setZone('Europe/Madrid').toISO({ includeOffset: false, suppressMilliseconds: true });
  const time = local ? isoTime(local, 'Europe/Lisbon') : null;
  return local && time ? { local_time: local, time: time.iso, time_zone: 'Europe/Lisbon', time_zone_basis: 'carrier' } : clock;
}

export function parseCttExpress(payload: unknown, number: string): CarrierResult {
  const requested = normalizeCttExpressNumber(number);
  if (!isRecord(payload)) throw new SchemaError('CTT Express');
  // An upstream Invalid token reply can precede successful anonymous retrieval.
  // No error signature has established a reliable parcel-negative response.
  if (payload.error != null) throw new CttExpressErrorReply('CTT Express', 'CTT Express returned an inconclusive tracking response');
  const data = payload.data;
  if (!isRecord(data) || data.shipping_code !== requested || !isRecord(data.shipping_history)) {
    throw new SchemaError('CTT Express', 'CTT Express returned a different or incomplete shipment');
  }
  const history = data.shipping_history;
  if (!Array.isArray(history.events) || history.events.length > 500) throw new SchemaError('CTT Express');
  if (!history.events.length) throw new IndeterminateError('CTT Express', 'CTT Express returned no tracking scans');
  // The public response contains one package's history. Shipment completion
  // cannot be inferred from one delivered package of a multi-piece shipment.
  if (data.item_count !== 1) throw new IndeterminateError('CTT Express', 'CTT Express did not return a single-piece shipment');
  // Official label specification: 22 shipment digits + 3 parcel-counter digits.
  const packageCode = requested.length === 25 ? requested : `${requested}001`;
  if (history.item_code !== packageCode) throw new SchemaError('CTT Express', 'CTT Express returned a different package');
  // A parcel that entered from another postal network keeps its first number.
  // CTT Portugal tracks its own numbers, which also name its leg of the parcel.
  const prime = clean(data.prime_shipping_code, 32);
  const postal = isValidS10TrackingNumber(prime);
  const portugal = postal && prime.endsWith('PT');
  const events: CarrierEvent[] = [];
  const rows: unknown[] = history.events;
  // Preserve duplicates until their chronological leg is known so an earlier
  // return start is not lost.
  for (const row of rows) {
    // Customer service cases (a new date or address) are not scans and carry
    // the recipient's contact details.
    if (isRecord(row) && row.type === 'MANAGEMENTS' && clean(row.source, 64) === 'CASE_V1') continue;
    if (!isRecord(row) || row.type !== 'STATUS' || !['ITEM_STATUS_V2', 'ITEM_STATUS_CHANGE_V1'].includes(clean(row.source, 64))) {
      throw new SchemaError('CTT Express', 'CTT Express returned an unsupported scan source');
    }
    const code = clean(row.code, 16);
    const description = clean(row.description, 500);
    if (!/^\d{4}$/.test(code) || !description) throw new SchemaError('CTT Express', 'CTT Express returned an incomplete scan');
    const clock = portugal && PORTUGAL_LEG.has(code) ? lisbonClock(scanClock(row.event_date)) : scanClock(row.event_date);
    const mapped = classifyCttExpressStatus(code);
    events.push({ provider_code: code, description, ...clock, ...(mapped ? { stage: mapped.stage } : {}) });
  }
  if (!events.length) throw new IndeterminateError('CTT Express', 'CTT Express returned no tracking scans');
  // The feed lists scans oldest first unless its clocks say otherwise; newest provider positions win equal-clock ties.
  if (listsNewestFirst(events) !== true) events.reverse();
  // An unresolved newest scan must not yield to an older instant.
  if (events.every((event) => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  // 2500 explicitly starts delivery back to the sender. Apply that evidence
  // chronologically, using the provider's order whenever a clock is unresolved.
  // Movement on that leg remains movement; only completed delivery is returned.
  let returning = false;
  for (const event of [...events].reverse()) {
    if (event.provider_code === '2500') returning = true;
    if (!returning) continue;
    event.provider_leg = 'return';
    if (event.stage === 'delivered') event.stage = 'returned';
  }
  const seen = new Set<string>();
  const unique = events.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const latest = unique[0]!;
  const mapped = classifyCttExpressStatus(latest.provider_code ?? '');
  const returned = latest.stage === 'returned';
  // A rescheduled delivery day replaces the committed one.
  const rescheduled = clean(data.new_delivery_date, 32);
  const eta = rescheduled || clean(data.committed_delivery_datetime, 32);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eta);
  const validEta = date && calendarDay(Number(date[1]), Number(date[2]), Number(date[3]));
  const latestDay = latest.time ? DateTime.fromISO(latest.time, { setZone: true }).toISODate()
    : typeof latest.local_time === 'string' ? latest.local_time.slice(0, 10) : null;
  const heldForDocuments = history.events.some((row) => isRecord(row) && isRecord(row.detail) && row.detail.incident_type_code === '21_INCT');
  const active = mapped && ['pending', 'in_transit', 'out_for_delivery'].includes(mapped.status) && mapped.stage !== 'ready_for_pickup';
  // The widget uses the committed date as a calendar estimate. Old estimates
  // persist after incidents/returns; do not present those as a current promise.
  const expected = active && latest.provider_leg !== 'return' && !heldForDocuments && validEta && latestDay && validEta >= latestDay ? validEta : null;
  // The weight measured in the network, else the one the sender declared.
  const weight = [data.final_weight, data.declared_weight]
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000);
  return { status: returned ? 'exception' : mapped?.status ?? 'unknown', ...(latest.stage ? { current_stage: latest.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: expected, ...(mapped?.status === 'delivered' && !returned && latest.time ? { delivered_at: latest.time } : {}),
    ...(weight !== undefined ? { weight_kg: weight } : {}),
    ...(postal ? { international_tracking_number: prime } : {}),
    ...(portugal ? { delivery_carrier: 'ctt', delivery_tracking_number: prime } : {}),
    events: unique.slice(0, 100) };
}
