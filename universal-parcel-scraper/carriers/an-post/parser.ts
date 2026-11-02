import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ATTEMPT_DELIVERED, ATTEMPT_MADE, anPostPostOffice, anPostScanStage, anPostSummaryStage, type AnPostStage } from './status.js';

export const AN_POST = 'An Post';
const MAX_ITEMS = 50;
const MAX_SCANS = 500;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const ZONE = 'Europe/Dublin';
/**
 * An outbound item's codes as it leaves Ireland (5) and as the destination's
 * delivery partner relays its scans (40, 49, 67, 68), in whole minutes.
 */
const ABROAD = new Set([5, 40, 49, 67, 68]);

/** The item's identity and current status from GetItemSummary or GetCustItemSummary. Names and references are never kept. */
export interface AnPostSummary {
  number: string;
  /** The sender's reference the item was found by, when it was not asked by its own number. */
  reference?: string;
  /** The current status as the website shows it: the summary's own, else a delivery attempt worded from its reason. */
  status: string;
  /** The summary's own status wording, empty when it gave none. */
  reported: string;
  date: string | null;
}

const S10 = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
// The sender's reference from the postage label, as the website takes it: letters and digits, at most 35.
const REFERENCE = /^(?=[A-Z]*\d)[A-Z\d]{6,35}$/;

/**
 * S10 numbers with a valid check digit, An Post's own items and those other
 * posts send to Ireland, or a sender's reference. An S10 number that fails its
 * check digit is refused rather than asked as a reference.
 */
export function normalizeAnPostNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (S10.test(number) ? !isValidS10TrackingNumber(number) : !REFERENCE.test(number)) {
    throw new InvalidInputError(AN_POST, 'An Post requires an S10 postal tracking number or a sender reference');
  }
  return number;
}

/** Whether the number is an item's own S10 number rather than a sender's reference. */
export function isAnPostItemNumber(number: string): boolean {
  return S10.test(number);
}

function invalid(message = 'An Post returned an invalid tracking response'): never {
  throw new SchemaError(AN_POST, message);
}

/** An offset-less wall clock, validated without giving it a zone. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) invalid('An Post returned an invalid scan clock');
  return match[0];
}

/** An Post's own wall clock on Irish time, unless the clocks skip it. */
function irishTime(local: string): string | undefined {
  const placed = isoTime(local, ZONE);
  return placed?.iso.startsWith(local) ? placed.iso : undefined;
}

function text(value: unknown, max: number): string {
  if (value == null) return '';
  if (typeof value !== 'string') invalid();
  return clean(value, max);
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * The website's wording for a delivery attempt (trace code 16, or a summary
 * without a status), whose reason says whether the item was delivered. The
 * website takes any reason containing DELIVERED; a negated one ("NOT
 * DELIVERED", "UNDELIVERED") stays an attempt here. The reason itself is
 * never shown: it can say where or to whom the item was handed.
 */
function attemptOutcome(reason: string): string | null {
  if (!reason) return null;
  const delivered = /\bDELIVERED\b/i.test(reason)
    && !/\b(?:NOT|NON|NEVER|CANNOT|CAN'?T|COULDN'?T|UNABLE|FAILED)\b(?:[\s-]+\w+){0,3}?[\s-]+DELIVERED\b/i.test(reason);
  return delivered ? ATTEMPT_DELIVERED : ATTEMPT_MADE;
}

export function parseAnPostSummary(payload: unknown, raw: string): AnPostSummary {
  const number = normalizeAnPostNumber(raw);
  const items = isRecord(payload) && isRecord(payload.getItemSummaryResponse)
    ? payload.getItemSummaryResponse.GetItemSummaryResult : undefined;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) invalid();
  // Unknown and expired items both get the empty list.
  if (!items.length) throw new NotFoundError(AN_POST, 'An Post has no current record of the item');
  const identities = items.map(item => (isRecord(item) && typeof item.anPostNo === 'string'
    ? item.anPostNo.toUpperCase().replace(/\s+/g, '') : invalid()));
  if (identities.some(identity => identity !== number)) invalid('An Post returned a different item');
  if (items.length !== 1) throw new IndeterminateError(AN_POST, 'An Post returned several items for the number');
  return summaryOf(items[0] as Record<string, unknown>, number);
}

/**
 * The item a sender's reference opens, from GetCustItemSummary, which the
 * website asks when GetItemSummary knows no item by that number. Each item
 * repeats the reference as `senderNo`; its own S10 number asks the history.
 */
export function parseAnPostReference(payload: unknown, raw: string): AnPostSummary {
  const reference = normalizeAnPostNumber(raw);
  const items = isRecord(payload) && isRecord(payload.getCustItemSummaryResponse)
    ? payload.getCustItemSummaryResponse.GetCustItemSummaryResult : undefined;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) invalid();
  if (!items.length) throw new NotFoundError(AN_POST, 'An Post has no current record of the item');
  const references = items.map(item => (isRecord(item) && typeof item.senderNo === 'string'
    ? normalizeTrackingNumber(item.senderNo) : invalid()));
  if (references.some(value => value !== reference)) invalid('An Post returned a different item');
  if (items.length !== 1) throw new IndeterminateError(AN_POST, 'An Post returned several items for the reference');
  const item = items[0] as Record<string, unknown>;
  const number = typeof item.anPostNo === 'string' ? normalizeTrackingNumber(item.anPostNo) : '';
  if (!isValidS10TrackingNumber(number)) invalid('An Post returned an invalid item number');
  return { ...summaryOf(item, number), reference };
}

function summaryOf(item: Record<string, unknown>, number: string): AnPostSummary {
  // receiverName and geisDeliveryName name people; senderNo is the sender's
  // reference, read only to bind a lookup by it. None of them is kept.
  const date = text(item.date, 32);
  const reported = text(item.status, 300);
  const status = reported || attemptOutcome(text(item.reason, 300)) || '';
  return { number, status, reported, date: date ? wallClock(date) : null };
}

interface Current {
  stage?: AnPostStage;
  text: string;
  local: string;
  /** The post office the status says the item waits in. */
  office?: string;
}

interface Scan extends Current {
  event: CarrierEvent;
  code: number;
  /** The scan's own wording, empty for a delivery attempt worded from its reason. */
  activity: string;
}

/**
 * The service lists scans newest first and the summary repeats the newest
 * scan's wording and clock, but the two come from separate requests, so either
 * may be a scan ahead of the other. The scan the summary names (by clock and
 * wording, else by clock) is current when it is later than the first listed
 * scan; at the same clock, often the same minute for relayed scans, the
 * service's order decides. A summary at a clock no scan has, later than the
 * first listed scan, is current itself. Otherwise the first listed scan is.
 */
function currentState(scans: readonly Scan[], summary: AnPostSummary): Current {
  const first = scans[0]!;
  const date = summary.date;
  if (!date) return first;
  const atClock = scans.filter(({ local }) => local === date);
  const named = atClock.find(({ activity, text }) => !summary.reported || same(activity, summary.reported)
    || same(text, summary.reported)) ?? atClock[0];
  if (named) return date > first.local ? named : first;
  if (summary.status && date > first.local) {
    return { stage: anPostSummaryStage(summary.status), text: summary.status, local: date, office: anPostPostOffice(52, summary.status) };
  }
  return first;
}

/**
 * The post office the item waits in, or was collected from: a delivery right
 * after a post office scan is the collection there. A summary ahead of the
 * history is no listed scan, so the scan right before it is the first listed.
 */
function pickupPoint(scans: readonly Scan[], current: Current): string | undefined {
  if (current.office) return current.office;
  if (current.stage?.stage !== 'delivered') return undefined;
  return scans[scans.indexOf(current as Scan) + 1]?.office;
}

/** The history is bound by its request, which names the summary's item. */
export function parseAnPostEvents(payload: unknown, summary: AnPostSummary): CarrierResult {
  const rows = isRecord(payload) && isRecord(payload.getEventsResponse) ? payload.getEventsResponse.GetEventsResult : undefined;
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) invalid();
  // The summary repeats the newest scan, so a bound item has one; a request
  // An Post did not understand gets the same empty list.
  if (!rows.length) throw new IndeterminateError(AN_POST, 'An Post returned the item without its history');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || !Number.isInteger(row.traceCode)) invalid();
    const code = row.traceCode as number;
    if (code < 0 || code > 9999) invalid();
    const activity = text(row.activity, 300);
    // The website words a delivery attempt from its reason alone, whatever its activity.
    const description = (code === 16 ? attemptOutcome(text(row.reason, 300)) : null) ?? activity;
    if (!description) invalid('An Post returned an empty scan');
    const local = wallClock(row.date);
    const office = anPostPostOffice(code, description);
    const location = text(row.location, 200) || office;
    const stage = anPostScanStage(code, description);
    const event: CarrierEvent = { description, local_time: local,
      ...(location ? { location } : {}), provider_code: String(code),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
    // Repeated scans at different clocks are separate; only exact copies go.
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ event, code, activity, stage, text: description, local, ...(office ? { office } : {}) });
  }
  // The scans until an outbound item's dispatch abroad, or before the partner's
  // first relayed scan, are An Post's own, on Irish time. Later ones may keep
  // the destination's clock, so they keep their wall clocks.
  let abroad = -1;
  scans.forEach(({ code }, index) => { if (ABROAD.has(code)) abroad = index; });
  scans.forEach((scan, index) => {
    const time = abroad < 0 || index > abroad || (index === abroad && scan.code === 5) ? irishTime(scan.local) : undefined;
    if (time) scan.event = { time, ...scan.event };
  });
  // Provider order is kept: relayed partner scans may keep another country's
  // clock, so the wall clocks do not reorder them.
  const current = currentState(scans, summary);
  const pickup = pickupPoint(scans, current);
  // A summary ahead of the history is no listed scan, so it keeps its wall clock.
  const time = scans.includes(current as Scan) ? (current as Scan).event.time : undefined;
  return { status: current.stage ? languageStageStatus(current.stage.stage) : 'unknown',
    ...(current.stage ? { current_stage: current.stage.stage, current_stage_source: current.stage.source } : {}),
    last_status_text: current.text, last_update: time ?? null, last_update_local: current.local,
    ...(pickup ? { pickup_point: pickup } : {}), expected_delivery: null,
    ...(summary.reference ? { canonical_tracking_number: summary.number } : {}), events: scans.slice(0, 100).map(({ event }) => event) };
}
