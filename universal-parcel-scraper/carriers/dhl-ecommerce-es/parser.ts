import { isCttExpressTrackingNumber } from '../../core/detection/cttExpress.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dhlEcommerceEsStatus, dhlEcommerceEsSummaryStage, statusForStage } from './status.js';

const PROVIDER = 'DHL eCommerce Iberia';
const MAX_SCANS = 1_000;
const MAX_EVENTS = 100;
/** Stages that end a parcel's journey; a later notice does not undo them. */
const FINAL: readonly Stage[] = ['delivered', 'returned'];
/** A later delivery round or failed attempt shows the journey had not ended. */
const ROUND: readonly Stage[] = ['out_for_delivery', 'failed_attempt'];
/** The registration scan is filed under head office, which is not a place. */
const HEAD_OFFICE = new Set(['central', 'center', 'centro']);

/**
 * The numbers the Iberian portal answers: its own ten and twelve digits, the
 * short alias of an inbound parcel, S10 items, DHL licence plates and the
 * twenty-two digits of the CTT Express label.
 */
export function normalizeDhlEcommerceEsNumber(raw: string): string {
  const number = raw.trim().toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?:\d{10}|\d{12}|\d{22}|[A-Z]{2}\d{7}0|[A-Z]{2}\d{9}[A-Z]{2}|JJD[A-Z0-9]{8,30}|JVGL[A-Z0-9]{8,30}|3S[A-Z0-9]{9,18})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'DHL eCommerce Iberia tracking requires a shipment number or a DHL parcel barcode');
  }
  return number;
}

/** The portal shows the weight in kilos, as a string. */
function weightKg(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const weight = /^\d{1,6}(?:[.,]\d{1,3})?$/.test(text) ? Number(text.replace(',', '.')) : NaN;
  return weight > 0 && weight <= 100_000 ? weight : undefined;
}

/** Scans carry the depot's wall clock and no offset. */
function scanClock(date: unknown, time: unknown): { local_time?: string } {
  const day = typeof date === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date) : null;
  const clock = typeof time === 'string' ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  const iso = day && calendarDay(Number(day[3]), Number(day[2]), Number(day[1]));
  return iso && clock && Number(clock[1]) < 24 && Number(clock[2]) < 60 ? { local_time: `${iso}T${clock[1]}:${clock[2]}:00` } : {};
}

/**
 * The ServicePoint's name, then its street and "postcode town", as the page's
 * ServicePoint card shows them. The name alone when the street or town is missing.
 */
function servicePoint(raw: unknown): string {
  const point = isRecord(raw) ? raw : {};
  const name = clean(point.Name, 120);
  const street = clean(point.Address, 120);
  const town = clean(point.Location, 80);
  if (!name || !street || !town) return name;
  return [name, street, [clean(point.ZipCode, 16), town].filter(Boolean).join(' ')].join('\n');
}

function code(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Z0-9]{1,12}$/.test(value)) throw new SchemaError(PROVIDER, 'DHL eCommerce Iberia returned an invalid scan code');
  return value;
}

export function parseDhlEcommerceEs(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDhlEcommerceEsNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'DHL eCommerce Iberia returned an invalid tracking response');
  // The portal echoes the number it looked up. A different one is another shipment.
  if (typeof payload.ExpeditionNumber !== 'string' || payload.ExpeditionNumber.toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce Iberia did not return the requested shipment');
  }
  if (!Array.isArray(payload.Tracking) || payload.Tracking.length > MAX_SCANS) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce Iberia returned invalid tracking events');
  }
  // The feed is newest first. Local clocks of two countries are never sorted.
  const events: (CarrierEvent & { stage?: Stage; local_time?: string })[] = [];
  for (const row of payload.Tracking) {
    const wording = isRecord(row) ? clean(row.Description, 200) : '';
    if (!isRecord(row) || !wording) throw new SchemaError(PROVIDER, 'DHL eCommerce Iberia returned an invalid parcel scan');
    // The registration scan has no code of its own, only its DOC solution.
    const scanCode = code(row.Code) ?? (row.SolutionCode === 'DOC' ? 'DOC' : undefined);
    const town = clean(row.Town, 80);
    const location = HEAD_OFFICE.has(town.toLowerCase()) ? '' : town;
    const { movement, stage } = dhlEcommerceEsStatus(scanCode, wording);
    events.push({ ...(scanCode ? { provider_code: scanCode } : {}),
      description: movement && location ? `${wording} ${location}` : wording,
      ...(location ? { location } : {}), ...scanClock(row.Date, row.Time),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Iberia returned no parcel history');
  const latest = events[0]!;
  const final = events.findIndex((event) => event.stage && FINAL.includes(event.stage));
  const reopened = events.slice(0, Math.max(final, 0)).some((event) => event.stage && ROUND.includes(event.stage));
  const current = final >= 0 && !reopened ? events[final]! : latest;
  const stage = current.stage ?? dhlEcommerceEsSummaryStage(payload.Status);
  const weight = weightKg(payload.Weight);
  // The ServicePoint is where the parcel waits while it is ready there, and where it was
  // collected when the shipment says it was delivered there and the recipient picked it up.
  const collected = stage === 'delivered' && current.provider_code === 'RS' && payload.DeliveredInServicePoint === true;
  const point = stage === 'ready_for_pickup' || collected ? servicePoint(payload.ServicePoint) : '';
  // CTT Express delivers DHL's consumer parcels in Spain under its own label code.
  const partner = typeof payload.ShippingCode === 'string' ? payload.ShippingCode.trim() : '';
  return {
    status: stage ? statusForStage(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description ?? null,
    last_update: null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(weight !== undefined ? { weight_kg: weight } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(isCttExpressTrackingNumber(partner) && partner !== number
      ? { delivery_carrier: 'ctt-express', delivery_tracking_number: partner } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
