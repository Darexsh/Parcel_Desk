import { DateTime } from 'luxon';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { canadaProvinceTimeZone, countryTimeZone, explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { canadaPostPackageStage, canadaPostScanStage, canadaPostStage, isKnownCanadaPostScan, RETURNED_TO_SENDER, SIGNATURE_CODE, statusForStage } from './status.js';

export function normalizeCanadaPostNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  // Mail arriving from abroad keeps the sending post's S10 number on Canada Post's tracker.
  if (!/^\d{11,24}$/.test(value) && !isValidS10TrackingNumber(value)) {
    throw new InvalidInputError('canada-post', 'Canada Post requires a parcel PIN, numeric reference or valid postal tracking number');
  }
  return value;
}

export function canadaPostLookupKind(number: string): 'pin' | 'dnc' | 'reference' {
  if (/^(?:\d{11,12}|\d{16}|[A-Z]{2}\d{9}[A-Z]{2})$/.test(number)) return 'pin';
  return /^\d{15}$/.test(number) ? 'dnc' : 'reference';
}

function sameNumber(value: unknown, requested: string): boolean {
  return typeof value === 'string' && value.trim().toUpperCase() === requested;
}

function checkError(item: JsonObject): void {
  if (!Object.hasOwn(item, 'error')) return;
  if (!isRecord(item.error) || typeof item.error.cd !== 'string' || !item.error.cd.trim()) throw new SchemaError('canada-post');
  // The same 004 envelope is used for unknown, not yet scanned and expired parcels.
  // It cannot distinguish a new reference from history that has been removed. The
  // reason marks that known code as an answer about the number, not an outage.
  throw new IndeterminateError('canada-post', 'Canada Post returned no usable parcel history',
    item.error.cd.trim() === '004' ? { reason: 'portal_not_found' } : {});
}

export function resolveCanadaPostPin(payload: unknown, requested: string, kind: 'dnc' | 'reference'): string {
  if (!Array.isArray(payload) || payload.length > 100 || !payload.every(isRecord)) throw new SchemaError('canada-post', 'Canada Post returned invalid alias results');
  if (!payload.length || payload.length > 1) throw new IndeterminateError('canada-post', 'Canada Post did not resolve one parcel for this reference');
  const item = payload[0]!;
  const bound = kind === 'dnc' ? sameNumber(item.dnc, requested)
    : sameNumber(item.refNbr1, requested) || sameNumber(item.refNbr2, requested);
  if (!bound) throw new SchemaError('canada-post', 'Canada Post returned another reference');
  checkError(item);
  if (typeof item.pin !== 'string') throw new SchemaError('canada-post', 'Canada Post omitted the parcel PIN');
  let pin: string;
  try { pin = normalizeCanadaPostNumber(item.pin.trim()); }
  catch (cause) { throw new SchemaError('canada-post', 'Canada Post returned an invalid parcel PIN', { cause }); }
  // Returned identities may trim/case-fold, but never gain stripped separators.
  if (!sameNumber(item.pin, pin) || canadaPostLookupKind(pin) !== 'pin') throw new SchemaError('canada-post', 'Canada Post returned an invalid parcel PIN');
  return pin;
}

function textField(item: JsonObject, key: string, limit: number): string {
  if (item[key] != null && typeof item[key] !== 'string') throw new SchemaError('canada-post', 'Canada Post returned an invalid text field');
  return clean(item[key], limit);
}

function calendarDate(value: unknown): string | null {
  if (value != null && typeof value !== 'string') throw new SchemaError('canada-post', 'Canada Post returned an invalid date field');
  const raw = clean(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = DateTime.fromISO(raw, { zone: 'UTC' });
  return parsed.isValid ? parsed.toISODate() : null;
}

// Exchange scans other posts report through the postal union: mailed,
// processed and left in the originating country, arrived abroad, customs, and
// arrived at the delivery office in the destination country.
const EXCHANGE_SCANS = new Set(['4000', '4100', '4202', '4310', '4311', '4330', '4400', '4450', '4600']);

/**
 * The clock of a scan whose offset is not its own: one in another country, or
 * an exchange scan with no Canadian province. Canada Post labels them -05:00
 * or -04:00 with no regard to the place, and even varies the label within one
 * office: a Japanese posting at "12:33 -04:00" is 12:33 in Tokyo on Japan
 * Post's own page, a Korean one is on Korea Post's clock, a Montana delivery
 * office's "05:05 -05:00" is 05:05 MDT on USPS's page, and the Toronto
 * exchange office's "01:11 -05:00" fell in summer time (checked 2026-10-10).
 * Such a scan is read on its country's single clock; elsewhere it keeps
 * Canada Post's offset, the last guess: hours off, but the reply keeps its
 * instant. Null for a scan whose offset stands.
 */
function relayedClock(code: string, country: string, region: string): { zone: string | null } | null {
  const abroad = country !== '' && country !== 'CA';
  if (!abroad && (!EXCHANGE_SCANS.has(code) || (country === 'CA' && region))) return null;
  return { zone: abroad ? countryTimeZone(country) : null };
}

function eventClock(value: unknown, relayed: { zone: string | null } | null = null): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) throw new SchemaError('canada-post', 'Canada Post returned an invalid scan clock');
  const date = textField(value, 'date', 32);
  const time = textField(value, 'time', 32);
  const offset = textField(value, 'zoneOffset', 16);
  const raw = [date, time, offset].filter(Boolean).join(' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) {
    const local = `${date}T${time.length === 5 ? `${time}:00` : time}`;
    const placed = relayed?.zone ? isoTime(local, relayed.zone) : null;
    if (placed) return { time: placed.iso };
    if (/^(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/i.test(offset)) {
      const parsed = explicitOffsetTime(`${local}${offset}`);
      if (parsed) return { time: parsed.iso };
    } else if (!offset) {
      // UTC validates the calendar only; no timezone is attached to local digits.
      const parsed = DateTime.fromISO(local, { zone: 'UTC' });
      const valid = parsed.isValid ? parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) : null;
      if (valid) return { local_time: valid };
    }
  }
  return raw ? { provider_time_text: raw } : {};
}

interface Row {
  event: CarrierEvent;
  region: string;
  country: string;
}

/**
 * The zone of the office delivering the parcel: the province of its newest
 * out-for-delivery scan, when that scan's offset agrees with the province's
 * main clock. Several provinces span more than one zone.
 */
function deliveryZone(rows: readonly Row[]): string | null {
  const out = rows.find(row => row.event.stage === 'out_for_delivery');
  if (!out?.event.time || (out.country && out.country !== 'CA')) return null;
  const zone = canadaProvinceTimeZone(out.region);
  const shown = DateTime.fromISO(out.event.time, { setZone: true });
  return zone && shown.isValid && shown.offset === shown.setZone(zone).offset ? zone : null;
}

const WINDOW_CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * The window the tracking page shows on the expected day, as wall clocks.
 * "End of day" says no more than the day itself.
 */
function deliveryWindow(window: unknown, day: string, zone: string | null, after: number | null) {
  if (!zone || !isRecord(window) || window.dlvryWindowEOD === true) return null;
  const start = clean(window.dlvryWindowStartTime, 16);
  const end = clean(window.dlvryWindowEndTime, 16);
  if (!WINDOW_CLOCK.test(start) || !WINDOW_CLOCK.test(end)) return null;
  const from = isoTime(`${day}T${start}`, zone);
  const to = isoTime(`${day}T${end}`, zone);
  if (!from || !to || from.timestamp >= to.timestamp || (after !== null && to.timestamp < after)) return null;
  return { expected_delivery: to.iso, expected_delivery_from: from.iso };
}

function returnStarted(text: string): boolean {
  if (/\b(?:will|may|might|would)\b.*\breturn(?:ed)?\b/i.test(text)) return false;
  return /\b(?:being returned|returning|en\s?route|in transit)\b.*\bsender\b|\breturned to (?:the )?sender\b/i.test(text);
}

export function parseCanadaPostTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeCanadaPostNumber(trackingNumber);
  if (!isRecord(payload) || !sameNumber(payload.pin, number)) throw new SchemaError('canada-post', 'Canada Post returned another parcel or an invalid detail response');
  checkError(payload);
  const summary = textField(payload, 'status', 64);
  for (const flag of ['returnedToSender', 'returnPinIndicator', 'delivered']) {
    if (payload[flag] != null && typeof payload[flag] !== 'boolean') throw new SchemaError('canada-post', 'Canada Post returned an invalid parcel flag');
  }
  if (!Array.isArray(payload.events) || payload.events.length > 500) throw new SchemaError('canada-post', 'Canada Post returned invalid parcel history');
  if (!payload.events.length) throw new IndeterminateError('canada-post', 'Canada Post returned empty parcel history');
  const rows = payload.events.map(raw => {
    if (!isRecord(raw)) throw new SchemaError('canada-post', 'Canada Post returned an invalid scan');
    const code = textField(raw, 'cd', 40);
    const description = textField(raw, 'descEn', 500);
    const type = textField(raw, 'type', 64);
    if (!code || !/^[A-Za-z0-9_-]+$/.test(code) || !description) throw new SchemaError('canada-post', 'Canada Post returned an incomplete scan');
    if (raw.locationAddr != null && !isRecord(raw.locationAddr)) throw new SchemaError('canada-post', 'Canada Post returned an invalid scan location');
    const region = isRecord(raw.locationAddr) ? textField(raw.locationAddr, 'regionCd', 40) : '';
    const country = isRecord(raw.locationAddr) ? textField(raw.locationAddr, 'countryCd', 8).toUpperCase() : '';
    const location = isRecord(raw.locationAddr)
      ? [textField(raw.locationAddr, 'city', 160), region].filter(Boolean).join(', ') : '';
    // The signature row can come without its type.
    const signature = type === 'Signature' || code === SIGNATURE_CODE;
    const stage = signature ? null : canadaPostScanStage(code, description) ?? canadaPostStage(description);
    const relayed = relayedClock(code, country, region);
    const clock = eventClock(raw.datetime, relayed);
    const event: CarrierEvent = { ...clock, description: stage === 'delivered' ? 'Delivered' : description,
      provider_code: code, ...(stage ? { stage } : {}), ...(location ? { location } : {}) };
    return { event, type, signature, region, country, sourceDate: isRecord(raw.datetime) ? calendarDate(raw.datetime.date) : null,
      returnCue: returnStarted(description) || type === 'RtsLabelProc', guessed: relayed?.zone === null && 'time' in clock };
  });
  // Native detail history is newest first. Compare instants only when every
  // row resolves, and none only by a guess; an unresolved latest row must not
  // fall behind old scans, nor a guessed one behind a scan placed abroad.
  if (rows.every(row => row.event.time && !row.guessed)) rows.sort((a, b) => Date.parse(b.event.time!) - Date.parse(a.event.time!));
  let returning = false;
  for (const row of [...rows].reverse()) {
    if (row.returnCue) returning = true;
    if (returning) {
      row.event.provider_leg = 'return';
      if (row.event.stage === 'delivered') { row.event.stage = 'returned'; row.event.description = RETURNED_TO_SENDER; }
    }
  }
  const latest = rows[0]!;
  const explicitReturn = latest.event.provider_leg === 'return';
  const currentReturn = explicitReturn || payload.returnedToSender === true;
  const summaryStage = canadaPostPackageStage(summary);
  const delivery = rows.find(row => row.event.stage === (currentReturn ? 'returned' : 'delivered'));
  const matchingDelivery = delivery?.event.time && latest.event.time === delivery.event.time
    && (latest === delivery || latest.signature) ? delivery : undefined;
  let current: Stage | null = (latest.event.stage as Stage | undefined) ?? summaryStage;
  let snapshot: 'delivery' | 'return' | null = null;
  if (currentReturn && !explicitReturn) {
    // A summary flag can announce a return before a return scan exists. Its
    // timing cannot relabel an old outbound delivery as sender completion.
    current = 'exception';
    snapshot = 'return';
  } else if (summaryStage === 'delivered' && !currentReturn) {
    current = 'delivered';
    snapshot = matchingDelivery ? null : 'delivery';
  } else if (currentReturn && !latest.event.stage) {
    current = matchingDelivery ? 'returned' : summaryStage === 'delivered' ? null : summaryStage;
  }
  const seen = new Set<string>();
  const events = rows.map(row => row.event).filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (snapshot === 'delivery') events.unshift({ description: 'Delivered', stage: 'delivered', summary_snapshot: true });
  if (snapshot === 'return') events.unshift({ description: 'Return to sender', stage: 'exception', provider_leg: 'return', summary_snapshot: true });
  const estimate = payload.expectedDlvryDateTime;
  if (estimate != null && !isRecord(estimate)) throw new SchemaError('canada-post', 'Canada Post returned an invalid delivery estimate');
  const revised = isRecord(estimate) ? calendarDate(estimate.revisedDate) : null;
  const standard = isRecord(estimate) ? calendarDate(estimate.dlvryDate) : null;
  const actualDay = calendarDate(payload.actualDlvryDate);
  const actualEventDay = delivery?.event.time?.slice(0, 10);
  const deliveredAt = current === 'delivered' && matchingDelivery && (!actualDay || actualDay === actualEventDay) ? matchingDelivery.event.time : null;
  const candidate = isRecord(estimate) && clean(estimate.revisedDate, 64) ? revised : standard;
  const expected = !currentReturn && current !== 'delivered' && current !== 'returned' && current !== 'exception' && current !== 'failed_attempt'
    && summary !== 'FullProgressAlert' && summary !== 'InTransitAlert' && isKnownCanadaPostScan(latest.event.provider_code!)
    && candidate && latest.sourceDate && candidate >= latest.sourceDate ? candidate : null;
  // The tracking page shows a window only while the parcel is accepted, moving or out for delivery.
  const window = expected && (summaryStage === 'accepted' || summaryStage === 'in_transit' || summaryStage === 'out_for_delivery')
    ? deliveryWindow(payload.expectedDlvryWindow, expected, deliveryZone(rows), latest.event.time ? Date.parse(latest.event.time) : null)
    : null;
  // The tracking page labels this "Sender": the business account that shipped the parcel.
  const sender = typeof payload.custNm === 'string' && !payload.custNm.includes('*') ? clean(payload.custNm, 160) : '';
  // The page's "Service type", in English.
  const service = clean(payload.productNmEn, 80);
  return { status: current ? statusForStage(current) : 'unknown', ...(current ? { current_stage: current } : {}),
    last_status_text: snapshot === 'return' ? 'Return to sender' : current === 'delivered' ? 'Delivered'
      : current === 'returned' ? RETURNED_TO_SENDER : latest.event.description,
    last_update: snapshot ? null : latest.event.time ?? null,
    ...(!snapshot && latest.event.local_time ? { last_update_local: latest.event.local_time } : {}),
    expected_delivery: window?.expected_delivery ?? expected,
    ...(window ? { expected_delivery_from: window.expected_delivery_from } : {}), ...(deliveredAt ? { delivered_at: deliveredAt } : {}), ...(sender ? { sender_name: sender } : {}),
    ...(service ? { service_name: service } : {}), events: events.slice(0, 100) };
}
