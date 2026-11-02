import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { yurticiScanStage, yurticiSummaryStage } from './status.js';

export const PROVIDER = 'Yurtiçi Kargo';
export const YURTICI_MAX_BYTES = 256_000;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/**
 * What the tracker's field takes: a twelve-digit shipment code or a
 * sixteen-digit international AWB code, digits only.
 */
export function normalizeYurticiNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^(?:\d{12}|\d{16})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Yurtiçi Kargo shipment codes are twelve digits and AWB codes sixteen');
  }
  return number;
}

/** The tracker's notice for a code it does not know, in English and in Turkish. */
const NOT_FOUND = new Set([
  'No record found. Please try with a different tracking code.',
  'Sorguladığınız gönderi koduyla bir kargo bulunamadı.Lütfen gönderi kodunu kontrol ederek tekrar deneyiniz.',
]);

/** The carrier's notice, or undefined when the reply carries none. */
function notice(payload: Record<string, unknown>): string | undefined {
  if (payload.ErrorMessage === undefined) return undefined;
  return clean(payload.ErrorMessage, 300);
}

/** The shipment id the search answers with, as a string of digits. */
function shipmentId(value: unknown): string {
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) && value > 0 ? String(value) : '') : cleanScalar(value, 20);
  return /^\d{1,16}$/.test(text) ? text : '';
}

/** A shipment id as the twelve-digit code it is printed as. */
const printed = (id: string) => id.padStart(12, '0');

export interface YurticiSearch {
  /** The id the tracker asks for the shipment's details. */
  readonly id: string;
}

/**
 * The search the tracker runs first: the shipment's id, or the tracker's
 * notice for a code it does not know. A domestic shipment's id is its code.
 * An international shipment is read from its AWB record, which the adapter
 * does not read.
 */
export function parseYurticiSearch(payload: unknown, raw: string): YurticiSearch {
  const number = normalizeYurticiNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  const message = notice(payload);
  if (message !== undefined) {
    if (NOT_FOUND.has(message)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Yurtiçi Kargo could not complete the search');
  }
  if (payload.IsAbroad === true) {
    throw new IndeterminateError(PROVIDER, 'Yurtiçi Kargo tracks this shipment through its international record', { reason: 'international_shipment' });
  }
  const id = shipmentId(payload.DocId);
  if (!id || payload.IsAbroad !== false) throw new SchemaError(PROVIDER, 'Yurtiçi Kargo returned a search result without a shipment');
  if (number.length === 12 && printed(id) !== number) throw new SchemaError(PROVIDER, 'Yurtiçi Kargo did not identify the requested shipment');
  return { id };
}

const MONTHS = new Map<string, number>([
  ...['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  ...['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'],
].map((name, index) => [name, (index % 12) + 1]));
const month = (name: string) => MONTHS.get(name.toLocaleLowerCase('tr-TR')) ?? MONTHS.get(name.toLowerCase());

// "Monday, October 5, 2026 10:30 AM" in English; "5 Ekim 2026 Pazartesi 10:30" in Turkish.
const ENGLISH_DATE = /^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?$/i;
const TURKISH_DATE = /^(\d{1,2})\s+(\p{L}+)\s+(\d{4})(?:\s+\p{L}+)?(?:\s+(\d{1,2}):(\d{2}))?$/u;

/** A day, or a day and a wall clock, as the tracker writes them in either language. */
function writtenDate(value: unknown): { day: string; clock?: string } | null {
  const text = clean(value, 64);
  let year: number, monthNumber: number | undefined, dayNumber: number, hour: string | undefined, minute: string | undefined;
  const english = ENGLISH_DATE.exec(text);
  const turkish = english ? null : TURKISH_DATE.exec(text);
  if (english) {
    [year, monthNumber, dayNumber] = [Number(english[3]), month(english[1]!), Number(english[2])];
    if (english[4] !== undefined) {
      const twelve = Number(english[4]);
      if (twelve < 1 || twelve > 12) return null;
      hour = String((twelve % 12) + (english[6]!.toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0');
      minute = english[5];
    }
  } else if (turkish) {
    [year, monthNumber, dayNumber] = [Number(turkish[3]), month(turkish[2]!), Number(turkish[1])];
    hour = turkish[4]?.padStart(2, '0');
    minute = turkish[5];
  } else return null;
  const day = monthNumber ? calendarDay(year, monthNumber, dayNumber) : null;
  if (!day) return null;
  if (hour === undefined) return { day };
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  return { day, clock: `${day}T${hour}:${minute}:00` };
}

/** A `yyyyMMddHHmmss` stamp of the summary as a wall clock. */
function stamp(value: unknown): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(clean(value, 14));
  if (!match) return null;
  const day = calendarDay(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!day || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

/** A unit's "City - County"; a transfer between units has an empty one. */
function place(value: unknown): string {
  const text = clean(value, 120);
  return /^[\s-]*$/.test(text) ? '' : text;
}

interface Scan {
  readonly event: CarrierEvent;
  readonly local: string | null;
}

/** The first movement's wording, which the summary's shipment date stands for. */
const ISSUED = 'The transport document was issued.';

/**
 * The movements the tracker lists for a parcel on its way, oldest first by
 * their order number. Each names its unit's city and county, and the unit's
 * own name, which the adapter does not read. A reason, such as why a
 * delivery failed, is appended in brackets; a delivery's reason is never
 * read, as it could name who took the parcel.
 */
function movementsOf(payload: unknown): Scan[] {
  if (isRecord(payload)) {
    const message = notice(payload);
    if (message !== undefined) throw new IndeterminateError(PROVIDER, 'Yurtiçi Kargo could not list the movements');
  }
  if (!Array.isArray(payload) || payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Yurtiçi Kargo returned an invalid movement list');
  const rows = payload.map((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Yurtiçi Kargo returned an invalid movement');
    const order = Number.isSafeInteger(row.OrderNo) ? row.OrderNo as number : null;
    return { row, order, index };
  });
  // The list comes in its order numbers; without them it keeps the order it came in.
  if (rows.every(({ order }) => order !== null)) rows.sort((left, right) => left.order! - right.order! || left.index - right.index);
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const { row } of rows) {
    const wording = clean(row.Description, 200);
    if (!wording) throw new SchemaError(PROVIDER, 'Yurtiçi Kargo returned a movement without wording');
    const stage = yurticiScanStage(wording);
    const reason = stage === 'delivered' ? '' : clean(row.DetailDescription, 160).replace(/[()]/g, '');
    const description = reason && reason !== wording ? `${wording} (${reason})` : wording;
    const written = writtenDate(row.EventDate);
    const text = clean(row.EventDate, 64);
    if (!written && !text) throw new SchemaError(PROVIDER, 'Yurtiçi Kargo returned a movement without a date');
    const location = place(row.Title);
    // A movement dated by its day alone keeps that day.
    const local = written?.clock ?? written?.day ?? null;
    const event: CarrierEvent = { ...(local ? { local_time: local } : { provider_time_text: text }), description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ event, local });
  }
  return scans.reverse();
}

const cityCounty = (city: unknown, county: unknown) => [clean(city, 60), clean(county, 60)].filter(Boolean).join(' - ');

/** Stages before the parcel reaches its recipient, while an estimate still means something. */
const MOVING = new Set<Stage>(['registered', 'accepted', 'in_transit', 'out_for_delivery']);

/**
 * The shipment's details, with its movements when the tracker lists them.
 * The tracker stops listing movements once a parcel is delivered or returned;
 * the details then give the shipment date and the final status, and the
 * answer is a summary.
 */
export function parseYurtici(detail: unknown, movements: unknown, raw: string, search: YurticiSearch): CarrierResult {
  const number = normalizeYurticiNumber(raw);
  if (!isRecord(detail)) throw new SchemaError(PROVIDER);
  const message = notice(detail);
  if (message !== undefined) {
    // The search knows the code, but the tracker no longer holds its record.
    if (NOT_FOUND.has(message)) {
      throw new IndeterminateError(PROVIDER, 'Yurtiçi Kargo no longer holds this shipment', { reason: 'history_expired' });
    }
    throw new IndeterminateError(PROVIDER, 'Yurtiçi Kargo could not read the shipment');
  }
  if (shipmentId(detail.Id) !== search.id) throw new SchemaError(PROVIDER, 'Yurtiçi Kargo answered for a different shipment');
  const summary = clean(detail.ShipmentStatus, 80);
  if (!summary || typeof detail.IsDelivered !== 'boolean') throw new SchemaError(PROVIDER, 'Yurtiçi Kargo returned a shipment without a status');
  const delivered = detail.IsDelivered;

  const listed = movements === undefined ? [] : movementsOf(movements);
  const scans = [...listed];
  if (!scans.length) {
    const issued = stamp(detail.Title);
    const departure = cityCounty(detail.DepartureCityName, detail.DepartureCountyName);
    if (issued) scans.push({ local: issued, event: { local_time: issued, description: ISSUED,
      ...(departure ? { location: departure } : {}), stage: 'accepted', stage_source: 'carrier_map' } });
  }

  // A delivered or returned parcel: the summary says which, else whether it was turned back.
  const summaryStage = yurticiSummaryStage(summary);
  const final: Stage | undefined = delivered
    ? (summaryStage === 'delivered' || summaryStage === 'returned' ? summaryStage
      : detail.RejectStatus === '0' ? 'delivered' : detail.RejectStatus === '2' ? 'returned' : undefined)
    : undefined;
  if (delivered && !listed.length) {
    const closed = stamp(detail.LastProcessDate);
    const destination = cityCounty(detail.DeliveryCityName, detail.DeliveryCountyName);
    if (closed) scans.unshift({ local: closed, event: { local_time: closed, description: summary,
      ...(destination ? { location: destination } : {}), ...(final ? { stage: final, stage_source: 'carrier_map' } : {}) } });
  }

  const events = scans.map(({ event }) => event);
  // The summary settles a delivery, a return and a return that has not reached the sender; otherwise the newest movement does.
  // A finished parcel whose summary settles neither keeps no stage rather than an earlier one.
  const settled = final ?? (!delivered && summaryStage === 'exception' ? summaryStage : undefined);
  const stage = settled ?? (delivered ? undefined : events.find(event => event.stage)?.stage as Stage | undefined);
  if (!events.length && !stage) throw new IndeterminateError(PROVIDER, 'Yurtiçi Kargo returned a shipment without dates or a known status');

  const newest = scans.find(({ local }) => local)?.local ?? null;
  const estimate = writtenDate(detail.EstimatedDeliveryDate)?.day;
  const expected = stage && MOVING.has(stage) && estimate && (!newest || estimate >= newest.slice(0, 10)) ? estimate : null;
  // A parcel the recipient collects from the delivery branch.
  const branch = stage === 'delivered' && detail.IsAddressDelivery === false ? clean(detail.DeliveryUnitName, 80) : '';
  const service = clean(detail.ProductName, 80);
  const canonical = number.length === 16 ? printed(search.id) : '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: settled ? summary : events[0]?.description ?? summary,
    ...(listed.length ? {} : { summary_only: true }),
    last_update: null,
    last_update_local: newest,
    expected_delivery: expected,
    ...(service ? { service_name: service } : {}),
    ...(branch ? { pickup_point: branch } : {}),
    ...(canonical && canonical !== number ? { canonical_tracking_number: canonical } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
