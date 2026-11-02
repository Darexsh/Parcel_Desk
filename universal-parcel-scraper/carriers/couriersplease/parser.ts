import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { couriersPleaseStage } from './status.js';

export const PROVIDER = 'CouriersPlease';
// A consignment of several items is a few kilobytes per item.
export const COURIERSPLEASE_MAX_BYTES = 512 * 1024;
// Consignments, item labels, prepaid coupons and the SSCCs some senders print:
// letters and digits, with at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// The tracking page's session token: "salt==:encrypted".
const TOKEN = /<meta\s+name="csrf-token"\s+content="([A-Za-z0-9+/=_:-]{16,512})"/;
const MAX_ITEMS = 100;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for CouriersPlease's tracker, in upper case; anything else is not one it issues. */
export function normalizeCouriersPleaseNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CouriersPlease numbers are eight to thirty letters and digits');
  return number;
}

/** The session token the tracking page puts in its `csrf-token` meta tag, or null. */
export function couriersPleaseToken(html: string): string | null {
  return TOKEN.exec(html.slice(0, 200_000))?.[1] ?? null;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `CouriersPlease returned an invalid ${key}`);
  return clean(value, maxLength);
}

const LINK = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
const BREAK = /\s*<br\s*\/?>\s*/gi;
const MARK = '\u0000';

/**
 * A scan's wording without its markup. A line break becomes the end of a
 * sentence, as on the page, and a sentence that points to a link, such as
 * "Please contact our Customer Support Team here", is left out.
 */
export function couriersPleaseWording(raw: string): string {
  // A link's text keeps a mark, so that its sentence can be told apart.
  const marked = textFromHtml(raw.slice(0, 2_000).replace(LINK, ` ${MARK}$1 `).replace(BREAK, '. '), 1_000);
  const kept = marked.split(/(?<=\.)\s+/).filter((sentence) => !sentence.includes(MARK)).join(' ');
  const wording = kept || marked.replaceAll(MARK, '');
  return clean(wording.replace(/\.(?:\s*\.)+/g, '.').replace(/\s+([,.])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–.]+$/g, '');
}

const DATE = /^\d{1,2} [A-Z][a-z]{2} \d{4}$/;
const CLOCK = /^(?:1[0-2]|0?[1-9]):[0-5]\d [ap]m$/i;

/** A scan's `date` ("23 Mar 2026") and `time` ("5:00 pm"), a wall clock to the minute. */
function wallClock(date: string, time: string): string {
  const parsed = DATE.test(date) && CLOCK.test(time)
    // Parsing in UTC checks the calendar only; the wall clock keeps no offset.
    ? DateTime.fromFormat(`${date} ${time}`, 'd MMM yyyy h:mm a', { zone: 'UTC', locale: 'en-US' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'CouriersPlease returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The consignment's labelled facts: `time` names the field and `action` holds its value. */
function facts(rows: unknown): Map<string, string> {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CouriersPlease returned invalid consignment details');
  const found = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'CouriersPlease returned invalid consignment details');
    const label = text(row, 'time', 60);
    if (label && !found.has(label)) found.set(label, text(row, 'action', 300));
  }
  return found;
}

/** Each item's rows, or null for an item the tracker has no rows for. */
function items(entry: Record<string, unknown>): (Record<string, unknown>[] | null)[] {
  const list = entry.trakingInfo;
  if (!Array.isArray(list) || list.length > MAX_ITEMS) throw new SchemaError(PROVIDER, 'CouriersPlease returned invalid items');
  return list.map((item) => {
    if (!isRecord(item) || !isRecord(item.tracker)) throw new SchemaError(PROVIDER, 'CouriersPlease returned an invalid item');
    const track = item.tracker.track;
    if (track === null || track === undefined) return null;
    if (!Array.isArray(track) || track.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CouriersPlease returned an invalid item history');
    if (track.some((row) => !isRecord(row))) throw new SchemaError(PROVIDER, 'CouriersPlease returned an invalid scan');
    return track as Record<string, unknown>[];
  });
}

/** The item number an item's first row names ("CPPL TRACKER", "SSCC TRACKER" or a coupon's product), or ''. */
function itemNumber(rows: Record<string, unknown>[]): string {
  const [first] = rows;
  if (!first || first.action !== null || first.nodeType !== null) return '';
  return text(first, 'date', 64).toUpperCase();
}

interface Scan { event: CarrierEvent; key: string; wall: string; order: number }

/**
 * An item's scans, as the page lists them: rows with wording, without the
 * first row naming the item, the page's own "Overdue" marker, a sender's
 * notice that the parcel was despatched to CouriersPlease, or the shipment
 * details a sender sends after the pickup.
 */
function itemScans(rows: Record<string, unknown>[], order: { next: number }): Scan[] {
  const scans: Scan[] = [];
  let pickedUp = false;
  for (const row of itemNumber(rows) ? rows.slice(1) : rows) {
    const code = text(row, 'nodeType', 40).toLowerCase();
    if (code === 'pickup') pickedUp = true;
    const date = text(row, 'date', 32);
    const action = row.action;
    if (action !== null && action !== undefined && typeof action !== 'string') throw new SchemaError(PROVIDER, 'CouriersPlease returned an invalid action');
    const description = typeof action === 'string' ? couriersPleaseWording(action) : '';
    if (!date || !description || /^overdue$/i.test(description)) continue;
    if (code === 'manifest' && pickedUp) continue;
    if (code === 'status' && /despatched to couriersplease/i.test(description)) continue;
    const wall = wallClock(date, text(row, 'time', 16));
    const location = text(row, 'stateName', 60);
    const providerCode = /^[a-z][a-z-]{0,39}$/.test(code) ? code : '';
    const staged = couriersPleaseStage(providerCode, description);
    const event: CarrierEvent = {
      local_time: wall,
      ...(location ? { location } : {}),
      description,
      ...(providerCode ? { provider_code: providerCode } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    scans.push({ event, key: JSON.stringify([wall, providerCode, description, location]), wall, order: order.next++ });
  }
  return scans;
}

/** The estimate the page shows, "26 Mar 2026", as a calendar day. */
function estimate(value: string | undefined): string | null {
  if (!value || !DATE.test(value)) return null;
  const parsed = DateTime.fromFormat(value, 'd MMM yyyy', { zone: 'UTC', locale: 'en-US' });
  return parsed.isValid ? parsed.toISODate() : null;
}

/**
 * The reply of the tracking page's `/api/track/locate` for one number. Its one
 * entry holds the consignment's details, when the number is a consignment, and
 * each item's rows, the first naming the item. A consignment must be the
 * number asked, or an item must: a label or coupon has no consignment details.
 * An unknown number gets no rows ("No scan events found", or an empty list),
 * which the page reports as not a valid tracking number.
 */
export function parseCouriersPlease(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCouriersPleaseNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'data')) throw new SchemaError(PROVIDER, 'CouriersPlease returned an invalid envelope');
  if (payload.data === null) {
    // The service's refusal of the request itself, worded in `msg`.
    if (typeof payload.msg === 'string' && payload.msg) throw new IndeterminateError(PROVIDER, 'CouriersPlease did not take the lookup');
    throw new SchemaError(PROVIDER, 'CouriersPlease returned a reply without data');
  }
  if (!isRecord(payload.data) || !Array.isArray(payload.data.root)) throw new SchemaError(PROVIDER, 'CouriersPlease returned an invalid result list');
  if (payload.data.root.length !== 1 || !isRecord(payload.data.root[0])) {
    throw new SchemaError(PROVIDER, 'CouriersPlease answered for another number of shipments');
  }
  const entry = payload.data.root[0];
  if (!isRecord(entry.statusInfo)) throw new SchemaError(PROVIDER, 'CouriersPlease returned a result without its status');
  const details = facts(entry.consignmentInfo ?? []);
  const tracks = items(entry);
  const consignment = (details.get('Consignment #') ?? '').toUpperCase();
  const listed = tracks.flatMap((rows) => rows?.length ? [rows] : []);
  if (!listed.length) {
    if (consignment === number) throw new NoHistoryError(PROVIDER);
    throw new NotFoundError(PROVIDER);
  }
  if (consignment !== number && !listed.some((rows) => itemNumber(rows) === number)) {
    throw new IndeterminateError(PROVIDER, 'CouriersPlease answered for another shipment');
  }

  const order = { next: 0 };
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const rows of listed) {
    for (const scan of itemScans(rows, order)) {
      // An item of several repeats the consignment's own scans.
      if (seen.has(scan.key)) continue;
      seen.add(scan.key);
      scans.push(scan);
    }
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; each item lists its scans oldest first.
  scans.sort((a, b) => (a.wall === b.wall ? b.order - a.order : a.wall < b.wall ? 1 : -1));
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The page shows the estimate as still to be confirmed while the sender's
  // details are all there is.
  const announced = events.every((event) => event.provider_code === 'manifest');
  const expected = stage === 'delivered' || stage === 'returned' || announced ? null : estimate(details.get('Delivery ETA'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
