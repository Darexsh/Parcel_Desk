import { DateTime } from 'luxon';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { firstOccurrence, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyBpostStatus } from './status.js';

/** Barcodes, postal S10 numbers, and bpost's `JJBE` licence plate, as on a registered letter or a parcel. */
export function normalizeBpostNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?:\d{18}|\d{24}|\d{30}|JJBE[A-Z]\d{18}(?:\d{4})?)$/.test(number) && !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError('bpost', 'bpost requires a parcel barcode or postal tracking number');
  }
  return number;
}

/** A two-letter country code, or '' for anything else. */
function countryCode(value: unknown): string {
  const code = clean(value, 8).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

const LANGUAGES = ['en', 'fr', 'nl', 'de'];

/** A field bpost gives per language, in the first of these languages it provides. */
function localized(field: unknown, maxLength: number, languages: readonly string[] = LANGUAGES): string {
  return isRecord(field) ? languages.map((language) => clean(field[language], maxLength)).find(Boolean) ?? '' : '';
}

// The steps for which bpost's tracker shows "Collected" at the delivery point
// instead of "Delivered to" the recipient's address.
const COLLECTED_STEPS = new Set(['PICKED_UP_IN_POST_OFFICE', 'PICKED_UP_IN_POST_POINT', 'PICKED_UP_IN_KARIBOO_POINT',
  'PICKED_UP_IN_PARCEL_LOCKER', 'PICKED_UP_IN_SHOP', 'PICKED_UP_IN_PICKUP_POINT_INTERNATIONAL']);

/**
 * The pickup point's name, then its street and number, then "postcode town",
 * in one language. The name alone when the street or town is missing. Its code
 * and opening hours are not read.
 */
function pickupPoint(point: unknown): string {
  if (!isRecord(point)) return '';
  const name = localized(point.name, 160);
  const language = LANGUAGES.find((code) => localized(point.street, 120, [code]) && localized(point.municipality, 80, [code]));
  if (!name || !language) return name;
  // A number or postcode reads the same in every language.
  const any = [language, ...LANGUAGES];
  const street = [localized(point.street, 120, [language]), localized(point.streetNumber, 16, any)].filter(Boolean).join(' ');
  const town = [localized(point.postcode, 16, any), localized(point.municipality, 80, [language])].filter(Boolean).join(' ');
  return [name, street, town].join('\n');
}

/**
 * The delivery time, on Brussels time. bpost gives it without an offset and its
 * own page prints it as it comes, so it is read only for a receiver in Belgium.
 */
function deliveredInBelgium(value: unknown): string {
  if (!isRecord(value)) return '';
  const day = clean(value.day, 16);
  const clock = clean(value.time, 16);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(clock)) return '';
  return zonedTime(`${day} ${clock}`, clock.length === 5 ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd HH:mm:ss', 'Europe/Brussels')?.iso ?? '';
}

/**
 * The locker brands bpost's tracker puts in place of a scan's `{{bboxRebrand}}`, by the item's
 * `bboxRebrandCategory`, in its English translations. An unknown brand reads as a parcel locker.
 */
const LOCKER_BRANDS: Readonly<Record<string, string>> = { parcelLocker: 'Parcel Locker', bbox: 'bbox locker' };

function lockerBrand(category: unknown): string {
  return typeof category === 'string' && Object.hasOwn(LOCKER_BRANDS, category) ? LOCKER_BRANDS[category]! : 'parcel locker';
}

/**
 * A scan's wall clock on Brussels time, or '' for one the change to summer time skips. bpost
 * dates its scans in Belgium on Belgian time: its reply also carries the item's creation as an
 * instant, and that is the pre-advice scan's clock read on Brussels time.
 */
function brusselsTime(local: string): string {
  const zoned = firstOccurrence(DateTime.fromISO(local, { zone: 'Europe/Brussels' }));
  return zoned.isValid && zoned.toISO({ includeOffset: false, suppressMilliseconds: true }) === local
    ? zoned.toISO({ suppressMilliseconds: true }) ?? '' : '';
}

export function parseBpost(payload: unknown, number: string): CarrierResult {
  const requested = normalizeBpostNumber(number);
  if (!isRecord(payload)) throw new SchemaError('bpost');
  // This is the explicit negative from the same anonymous batch request that
  // returns positive histories. The postcode-gated GET has different behavior.
  if (payload.error === 'NO_DATA_FOUND' && !Object.hasOwn(payload, 'items')) throw new NotFoundError('bpost');
  if (payload.error) throw new IndeterminateError('bpost', 'bpost returned an unrecognized lookup error');
  if (!Array.isArray(payload.items) || payload.items.length > 100 || !payload.items.every(isRecord)) throw new SchemaError('bpost');
  const matches = payload.items.filter((item) => item.itemCode === requested && item.searchCode === requested);
  if (matches.length !== 1) throw new SchemaError('bpost', 'bpost did not return one matching parcel barcode');
  const item = matches[0]!;
  if (!Array.isArray(item.events) || item.events.length > 500) throw new SchemaError('bpost');
  const returnDelivery = item.retourOrBackToSender === true && isRecord(item.activeStep)
    && item.activeStep.knownProcessStep === 'DELIVERED_TO_SENDER';
  const destination = isRecord(item.receiver) ? countryCode(item.receiver.countryCode) : '';
  // A national parcel, sent from Belgium to Belgium, is scanned in Belgium even where a scan
  // names no country. An international one can be scanned abroad, on another clock.
  const origin = countryCode(item.countryOfDepurture) || (isRecord(item.sender) ? countryCode(item.sender.countryCode) : '');
  const national = origin === 'BE' && destination === 'BE';
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const raw of item.events) {
    if (!isRecord(raw)) throw new SchemaError('bpost', 'bpost returned an incomplete scan');
    const key = isRecord(raw.key) && isRecord(raw.key.EN) ? raw.key.EN : null;
    const description = clean(key?.description, 500).replaceAll('{{bboxRebrand}}', lockerBrand(item.bboxRebrandCategory));
    const date = clean(raw.date, 32);
    const clock = clean(raw.time, 16);
    const text = [date, clock].filter(Boolean).join(' ');
    if (!description || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(clock)) {
      throw new SchemaError('bpost', 'bpost returned a scan without valid wording or clock');
    }
    // UTC validates calendar digits only; the public feed supplies no offset.
    // Preserve provider order across locations instead of comparing wall clocks.
    const parsed = DateTime.fromFormat(text, clock.length === 5 ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
    const local = parsed.isValid ? parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) : null;
    if (!local) throw new SchemaError('bpost', 'bpost returned an invalid scan date');
    const country = isRecord(raw.location) ? countryCode(raw.location.countryCode) : '';
    const location = isRecord(raw.location) ? [clean(raw.location.locationName, 160), clean(raw.location.countryCode, 2)]
      .filter(Boolean).join(', ') : '';
    // A scan that names no place at all, or a country alone, is bpost's own record, on Brussels time
    // wherever the parcel is. So is one of a parcel sent abroad in the destination country, unless
    // it is the partner's scan relayed under its office ("PTLISL Portugal PT"), on the partner's clock.
    const name = isRecord(raw.location) ? clean(raw.location.locationName, 160) : '';
    const partner = destination !== 'BE' && country === destination && !name.endsWith(` ${country}`);
    const time = country === 'BE' || !location || !name || (national && !country) || partner ? brusselsTime(local) : '';
    const dedup = `${local}\u0000${description}\u0000${location}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    const mapped = classifyBpostStatus(description);
    // The official widget distinguishes delivery to the sender from recipient
    // delivery. Do not let the host's wording fallback reinterpret a return.
    if (item.retourOrBackToSender === true && mapped?.stage === 'delivered' && !returnDelivery) {
      throw new IndeterminateError('bpost', 'bpost returned an ambiguous return-delivery milestone');
    }
    const stage = returnDelivery && mapped?.stage === 'delivered' ? 'returned' : mapped?.stage;
    events.push({ ...(time ? { time } : { local_time: local }), description, ...(location ? { location } : {}),
      ...(stage ? { stage } : {}), ...(item.retourOrBackToSender === true ? { provider_leg: 'return' } : {}) });
  }
  if (!events.length) throw new IndeterminateError('bpost', 'bpost returned no parcel history');
  const latest = events[0]!;
  const mapped = classifyBpostStatus(latest.description!);
  const current = returnDelivery && mapped?.stage === 'delivered' ? { status: 'exception' as const, stage: 'returned' as const } : mapped;
  // The delivery point is the pickup point itself, apart from the receiver: bpost's
  // tracker shows it with opening hours and directions from its own coordinates.
  // It stays once the parcel is collected there, never after a door delivery.
  const collected = current?.stage === 'delivered' && isRecord(item.activeStep)
    && typeof item.activeStep.knownProcessStep === 'string' && COLLECTED_STEPS.has(item.activeStep.knownProcessStep);
  const point = current?.stage === 'ready_for_pickup' || collected ? pickupPoint(item.deliveryPoint) : '';
  const deliveredAt = current?.status === 'delivered' && destination === 'BE' ? deliveredInBelgium(item.actualDeliveryTime) : '';
  // The sender's barcode is kept only when it is an S10 number other than the one searched.
  const senderBarcode = clean(item.senderBarcode, 32).toUpperCase();
  const international = senderBarcode !== requested && isValidS10TrackingNumber(senderBarcode) ? senderBarcode : '';
  const grams = item.weightInGrams;
  const dimensions = clean(item.dimensionsInCm, 100);
  const dimensionMatch = dimensions.match(/^(\d+(?:\.\d+)?)cm x (\d+(?:\.\d+)?)cm x (\d+(?:\.\d+)?)cm$/);
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(typeof grams === 'number' && Number.isFinite(grams) && grams > 0 ? { weight_kg: grams / 1000 } : {}),
    ...(dimensionMatch && dimensionMatch.slice(1).every((value) => Number(value) > 0)
      ? { dimensions_text: `${dimensionMatch.slice(1).join(' × ')} cm` } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(international ? { international_tracking_number: international } : {}),
    events: events.slice(0, 100) };
}
