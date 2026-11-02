import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError,
  TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { oldDominionStatus } from './status.js';

const PROVIDER = 'Old Dominion';
export const OLD_DOMINION_ORIGIN = 'https://www.odfl.com';
/** The trace page; the older `trace-track-ltl-freight/trace.html` address redirects here. */
export const OLD_DOMINION_TRACE_PATH = '/us/en/tools/trace-track-ltl-freight.html';
export const OLD_DOMINION_API = 'https://api.odfl.com/tracking/v3.0/shipment.track';
const MAX_EVENTS = 500;
const POUNDS_TO_KG = 0.453_592_37;
/** The trace page refuses any run of this sequence as a placeholder. */
const SEQUENCE = '0123456789012345789';
const ROBOT = /couldn.t confirm you.re not a robot/i;
/** Statuses at the shipper's or the consignee's own site: their city is the customer's. */
const CUSTOMER_SITE = new Set(['PICKUP COMPLETED', 'ARRIVED AT CONSIGNEE', 'DELIVERED', 'DELIVERY CONFIRMED']);
/** Statuses whose city is an Old Dominion service center. */
const SERVICE_CENTER = new Set(['PICKUP REQUESTED', 'IN TRANSIT', 'OUT FOR DELIVERY']);

/**
 * A PRO as the trace page accepts it: 9 to 11 digits, not one repeated digit
 * and not a run of its placeholder sequence. The page's address loader also
 * drops any PRO containing 123456789 and then sends no request at all.
 * Truckload PROs (600 once the leading zeros are dropped) are left out: the
 * page shows their history only after delivery and otherwise refers to
 * Truckload Services.
 */
export function normalizeOldDominionNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{9,11}$/.test(number) || /^(\d)\1+$/.test(number) || SEQUENCE.includes(number) || number.includes('123456789')) {
    throw new InvalidInputError(PROVIDER, 'Old Dominion requires a 9 to 11 digit PRO number');
  }
  if (oldDominionPro(number).startsWith('600')) {
    throw new InvalidInputError(PROVIDER, 'Old Dominion Truckload Services PRO numbers are not supported');
  }
  return number;
}

/** The reference the trace page sends: the PRO without its leading zeros. */
export function oldDominionPro(number: string): string {
  return number.replace(/^0+/, '');
}

export function oldDominionTraceUrl(raw: string): string {
  return `${OLD_DOMINION_ORIGIN}${OLD_DOMINION_TRACE_PATH}?proNumbers=${normalizeOldDominionNumber(raw)}`;
}

/** The tracking service's reply as the browser received it. */
export interface OldDominionReply {
  status: number;
  contentType: string;
  retryAfter: string | null;
  body: string;
}

function robot(value: unknown): boolean {
  return isRecord(value) && value.ok === false && Array.isArray(value.errors)
    && value.errors.some(error => isRecord(error) && ROBOT.test(clean(error.message, 200)));
}

function comparable(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** A PRO the service names, as a number or a string of digits, without its leading zeros. */
function namedPro(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^\d{1,11}$/.test(value) ? oldDominionPro(value) : null;
}

/** Each scan carries its own UTC offset; a clock without one is not guessed. */
function scanTime(value: unknown) {
  const raw = clean(value, 64);
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(raw);
  // Luxon accepts out-of-range offsets, so bound them first.
  if (!match || Number(match[1] ?? 0) > 14 || Number(match[2] ?? 0) > 59) return null;
  return explicitOffsetTime(raw);
}

/** A delivery estimate: a calendar day without a clock. */
function etaDay(value: unknown): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(value, 16));
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * A confirmed delivery appointment, which the trace page shows as "Appointment
 * Scheduled": the start's day and its window, or a single time when the start
 * is midnight, which the page drops, or equals the end. Both ends are wall
 * clocks without an offset, so the appointment stays local text: the window
 * `YYYY-MM-DD HH:mm–HH:mm` when it lies within that day and starts before it
 * ends, else that day alone. The pickup window, which can end before it
 * starts, is never read.
 */
function deliveryWindow(details: unknown): string | null {
  if (!isRecord(details) || clean(details.deliveryAppointmentStatus, 40) !== 'Appointment Set/Confirmed') return null;
  const ends = [details.deliveryAptBeginTime, details.deliveryAptEndTime]
    .map(value => /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):[0-5]\d$/.exec(clean(value, 32)));
  const days = ends.map(match => match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null);
  const clocks = ends.map(match => match ? `${match[4]}:${match[5]}` : '');
  if (!days[0]) return null;
  return days[0] === days[1] && clocks[0] !== '00:00' && clocks[0]! < clocks[1]! ? `${days[0]} ${clocks[0]}–${clocks[1]}` : days[0];
}

interface Scan { event: CarrierEvent; timestamp: number; key: string }

function scan(raw: unknown): Scan {
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Old Dominion returned an invalid shipment status');
  const status = clean(raw.status, 80);
  const time = scanTime(raw.dateTime);
  if (!status || !time) throw new SchemaError(PROVIDER, 'Old Dominion returned an invalid shipment status');
  const key = comparable(status);
  // A customer's site is named by its status alone; a service center's
  // movement names the center ("Arrived at CITY, ST (ABC)").
  const description = CUSTOMER_SITE.has(key) ? status : clean(raw.statusDesc, 200) || clean(raw.desc, 200) || status;
  const city = clean(raw.city, 80);
  const state = clean(raw.state, 8);
  const location = SERVICE_CENTER.has(key) && city && /^[A-Z]{2}$/.test(state) ? `${city}, ${state}` : '';
  const mapped = oldDominionStatus(status);
  return { key, timestamp: time.timestamp, event: { time: time.iso, ...(location ? { location } : {}), description,
    provider_code: status, ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) } };
}

function shipment(payload: Record<string, unknown>, pro: string, number: string): CarrierResult {
  const infos = payload.traceInfo;
  if (!Array.isArray(infos) || infos.length !== 1 || !isRecord(infos[0])) {
    throw new SchemaError(PROVIDER, 'Old Dominion did not return the requested shipment');
  }
  const info = infos[0];
  if (namedPro(info.proNumber) !== pro) throw new SchemaError(PROVIDER, 'Old Dominion returned a different shipment');
  const details = info.trackTraceDetail;
  if (!Array.isArray(details) || details.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Old Dominion returned an invalid history');
  if (!details.length) throw new IndeterminateError(PROVIDER, 'Old Dominion returned the shipment without a history');
  // Newest first; the sort is stable, so equal clocks keep the service's order.
  const scans = details.map(scan);
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.timestamp - a.timestamp);
  const latest = scans[0]!;
  const current = oldDominionStatus(latest.key);
  const delivered = current?.stage === 'delivered';
  // "Delivery Confirmed" follows the handover once the paperwork is in.
  const handover = delivered ? scans.find(item => item.key === 'DELIVERED') ?? latest : undefined;
  const weight = typeof info.weight === 'number' && Number.isFinite(info.weight) && info.weight > 0 && info.weight < 1_000_000
    ? Math.round(info.weight * POUNDS_TO_KG * 1000) / 1000 : null;
  // Shipper and consignee names and addresses, the signer, bill of lading and
  // purchase order numbers and the pickup appointment are never read.
  return {
    status: current?.status ?? 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.event.description ?? null,
    last_update: latest.event.time ?? null,
    expected_delivery: delivered ? null : deliveryWindow(info.deliveryDetails) ?? etaDay(info.updatedEta) ?? etaDay(info.standardEta),
    delivered_at: handover?.event.time ?? null,
    ...(weight !== null ? { weight_kg: weight } : {}),
    events: scans.slice(0, 100).map(item => item.event),
    tracking_url: oldDominionTraceUrl(number),
    tracking_source: 'structured-web-response',
  };
}

/** The failure an HTTP status states whatever the body says, if it states one. */
function httpFailure(reply: OldDominionReply, empty: boolean): Error | null {
  // A missing, refused or reused page verification fails with an empty 500.
  if (reply.status === 500 && empty) return new ChallengeError(PROVIDER, 'Old Dominion rejected the page verification');
  if (reply.status === 429) {
    const retry = reply.retryAfter?.trim() ?? '';
    return new RateLimitedError(PROVIDER, /^\d{1,6}$/.test(retry) ? Number(retry) * 1000 : undefined);
  }
  if ([401, 403].includes(reply.status)) return new ChallengeError(PROVIDER);
  // A missing route says nothing about the shipment.
  if ([404, 410].includes(reply.status)) return new TransportError(PROVIDER, 'Old Dominion tracking endpoint is unavailable', { status: reply.status });
  return reply.status >= 500 ? new UpstreamHttpError(PROVIDER, reply.status) : null;
}

/**
 * The tracking service streams one JSON line per requested PRO. The line
 * repeats the reference it answers, and a shipment names its PRO again.
 */
export function parseOldDominionReply(reply: OldDominionReply, raw: string): CarrierResult {
  const number = normalizeOldDominionNumber(raw);
  const pro = oldDominionPro(number);
  const text = reply.body.trim();
  const failure = httpFailure(reply, !text);
  if (failure) throw failure;
  // An HTML page in place of the stream is the edge's, even with HTTP 200.
  if (/html/i.test(reply.contentType) || text.startsWith('<')) throw new ChallengeError(PROVIDER);
  if (reply.status !== 200 && reply.status !== 422) throw new UpstreamHttpError(PROVIDER, reply.status);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new SchemaError(PROVIDER, 'Old Dominion returned an unexpected number of answers');
  let line: unknown;
  try { line = JSON.parse(lines[0]!) as unknown; } catch { throw new SchemaError(PROVIDER, 'Old Dominion returned invalid tracking data'); }
  // A failed reCAPTCHA assessment answers 422 with this envelope.
  if (robot(line)) throw new ChallengeError(PROVIDER, 'Old Dominion could not verify the browser');
  if (reply.status !== 200) throw new UpstreamHttpError(PROVIDER, reply.status);
  const payload = isRecord(line) ? line.body : undefined;
  if (!isRecord(payload) || payload.referenceType !== 'PRO' || typeof payload.ok !== 'boolean'
    || namedPro(cleanScalar(payload.referenceNumber, 16)) !== pro) {
    throw new SchemaError(PROVIDER, 'Old Dominion did not answer for the requested PRO');
  }
  if (payload.ok) return shipment(payload, pro, number);
  if (robot(payload)) throw new ChallengeError(PROVIDER, 'Old Dominion could not verify the browser');
  const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
  if (errors.some(error => cleanScalar(error.errorCode, 8) === '404' && error.message === 'shipment_not_found')) {
    throw new NotFoundError(PROVIDER);
  }
  throw new IndeterminateError(PROVIDER, 'Old Dominion did not complete the lookup');
}
