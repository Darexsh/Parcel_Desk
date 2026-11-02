import { DateTime } from 'luxon';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pocztaPolskaPartnerClock, type PocztaPolskaPartnerClock } from './clock.js';
import { isPocztaPolskaSystemOffice } from './identity.js';
import { classifyPocztaPolskaStatus, settlesPocztaPolskaDuty, startsPocztaPolskaReturn } from './status.js';

export function normalizePocztaPolskaNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/\s/g, '');
  if (!/^(?:\d{18,20}|PX\d{10})$/.test(number) && !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError('poczta-polska', 'Poczta Polska requires a parcel barcode or valid postal tracking number');
  }
  // Eighteen digits are the barcode's SSCC without its GS1 application identifier 00, which the
  // label prints apart. The service knows the parcel only under the whole barcode.
  if (number.length === 18) return `00${number}`;
  if (number.length !== 19) return number;
  // The official widget appends the GS1 check digit to a 19-digit reference
  // before submitting it. The JSON service itself does not resolve that alias.
  const sum = [...number].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 1 : 3), 0);
  return `${number}${(10 - sum % 10) % 10}`;
}

// Poczta Polska's own offices carry an office type. Its platform for senders'
// item data, "Elektroniczny Nadawca", carries none but is Poczta Polska's own
// system in Poland. Scans relayed from partners abroad carry none and keep the
// sending country's wall clock; an office code alone could be a foreign postcode.
function polishOffice(office: unknown): boolean {
  return isRecord(office) && (clean(office.officeType, 40) !== ''
    || clean(office.name, 160).toLowerCase() === 'elektroniczny nadawca');
}

// A Polish office dates its scans on Polish time. A wall clock the zone skips
// or repeats stays local.
function zoneTime(local: string, zone: string): string | null {
  const parsed = firstOccurrence(DateTime.fromISO(local, { zone }));
  if (!parsed.isValid || parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) !== local
    || parsed.getPossibleOffsets().length !== 1) return null;
  return parsed.toISO({ suppressMilliseconds: true });
}

function eventClock(value: unknown, polish: boolean, partner: PocztaPolskaPartnerClock | null): Record<string, string> {
  if (value != null && typeof value !== 'string') throw new SchemaError('poczta-polska', 'Poczta Polska returned an invalid clock field');
  const raw = clean(value, 64);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i.test(raw)) {
    const parsed = explicitOffsetTime(raw);
    if (parsed) return { time: parsed.iso };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)) {
    // UTC validates the calendar only. It is never attached to local digits.
    const parsed = DateTime.fromISO(raw, { zone: 'UTC' });
    const local = parsed.isValid ? parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) : null;
    const time = local && polish ? zoneTime(local, 'Europe/Warsaw') : null;
    if (time) return { time };
    const relayed = local && !polish && partner ? zoneTime(local, partner.zone) : null;
    if (local && relayed) return { local_time: local, time: relayed, time_zone: partner!.zone, time_zone_basis: partner!.basis };
    if (local) return { local_time: local };
  }
  return raw ? { provider_time_text: raw } : {};
}

export function parsePocztaPolska(payload: unknown, number: string): CarrierResult {
  const requested = normalizePocztaPolskaNumber(number);
  if (!isRecord(payload) || !Number.isInteger(payload.mailStatus) || typeof payload.number !== 'string'
    || payload.number.trim().toUpperCase() !== requested) throw new SchemaError('poczta-polska', 'Poczta Polska returned an invalid parcel envelope');
  if (payload.mailStatus === -1 && !Object.hasOwn(payload, 'mailInfo')) throw new NotFoundError('poczta-polska');
  if (payload.mailStatus !== 0) throw new IndeterminateError('poczta-polska', 'Poczta Polska returned an ambiguous or incomplete parcel result');
  const item = payload.mailInfo;
  // Unregistered letter post is answered with its mail type alone: there is no history to read.
  if (isRecord(item) && item.typeOfMailCode === 'UNREGISTERED_MAIL_TYPE' && !Object.hasOwn(item, 'events')) {
    throw new IndeterminateError('poczta-polska', 'Poczta Polska keeps no history for unregistered mail');
  }
  if (!isRecord(item) || typeof item.number !== 'string' || item.number.trim().toUpperCase() !== requested
    || !Array.isArray(item.events) || item.events.length > 500) throw new SchemaError('poczta-polska');
  if (item.components != null && (!Array.isArray(item.components) || item.components.length > 100
    || !item.components.every(component => typeof component === 'string' && component.trim().length > 0 && component.length <= 80))) {
    throw new SchemaError('poczta-polska', 'Poczta Polska returned an invalid component list');
  }
  if (item.typeOfMailCode === 'PPL' || (Array.isArray(item.components) && item.components.length > 0)) {
    throw new IndeterminateError('poczta-polska', 'Poczta Polska grouped consignments require parcel-level history');
  }
  // Source rows run oldest first. A return scan turns the rest of the trip
  // around: movement stays movement, and a final delivery is the sender's.
  let returning = false;
  const partner = pocztaPolskaPartnerClock(requested, item.recipientCountryCode);
  const projected = item.events.map((raw): CarrierEvent => {
    if (!isRecord(raw)) throw new SchemaError('poczta-polska');
    if (raw.canceled === true) throw new IndeterminateError('poczta-polska', 'Poczta Polska returned an invalidated scan');
    const description = clean(raw.name, 500);
    const code = clean(raw.code, 40);
    if (!description || !code) throw new SchemaError('poczta-polska', 'Poczta Polska returned an incomplete scan');
    const office = isRecord(raw.postOffice) ? clean(raw.postOffice.name, 160) : '';
    const location = isPocztaPolskaSystemOffice(office) ? '' : office;
    const mapped = classifyPocztaPolskaStatus(code);
    if (startsPocztaPolskaReturn(code, isRecord(raw.state) ? clean(raw.state.code, 16) : '')) returning = true;
    const stage = returning && mapped?.stage === 'delivered' ? 'returned' : mapped?.stage;
    return { ...eventClock(raw.time, polishOffice(raw.postOffice), partner), description, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage } : {}), ...(returning ? { provider_leg: 'return' } : {}) };
  });
  if (!projected.length) throw new IndeterminateError('poczta-polska', 'Poczta Polska returned no parcel history');
  // The widget's last source row is current, so the provider's order stands even
  // when every scan is dated: the clocks never reorder it.
  projected.reverse();
  const seen = new Set<string>();
  const events = projected.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const latest = events.find(event => !settlesPocztaPolskaDuty(event.provider_code!)) ?? events[0]!;
  const current = latest.stage === 'returned' ? { status: 'exception' as const, stage: 'returned' }
    : classifyPocztaPolskaStatus(latest.provider_code!);
  const weight = item.weight;
  const country = item.recipientCountryCode;
  const service = clean(item.typeOfMailName, 80);
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}), expected_delivery: null,
    // The office holding the item names where it waits; its address stays out.
    ...(current?.stage === 'ready_for_pickup' && latest.location ? { pickup_point: latest.location } : {}),
    // Only a scan at a Polish office has an instant to date the delivery.
    ...(current?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(service ? { service_name: service } : {}),
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? { weight_kg: weight } : {}),
    ...(typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(number.toUpperCase().replace(/\s/g, '') !== requested ? { canonical_tracking_number: requested } : {}),
    events: events.slice(0, 100) };
}
