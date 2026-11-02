import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { swiftxStage } from './status.js';

export const PROVIDER = 'SwiftX';
/** The tracking page's GraphQL endpoint, which it asks once per lookup. */
export const SWIFTX_API = 'https://swiftx-express.com/api/graphql';
// A reply with a few dozen scans is a few kilobytes.
export const SWIFTX_MAX_BYTES = 1_000_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 200;
// The tracker's only notice for a number it does not know.
const NOT_FOUND = 'Order not found.';
// Its answer, for any number, to a query sent without the page's own verification.
const VERIFICATION = 'Verification required.';
// The batch's own code for a query whose verification token was missing or refused.
const VERIFICATION_CODES = new Set(['HUMAN_VERIFICATION_REQUIRED', 'SLIDER_VERIFICATION_FAILED']);
// "2026-01-13 09:04:05", the scan site's wall clock.
const STAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// "GMT-07:00" or "GMT-7:00", the scan site's offset at that time.
const OFFSET = /^GMT([+-])(\d{1,2}):(\d{2})$/;
/**
 * Rows at the recipient's door: their place is the recipient's town, state
 * and postcode, and a pickup or return row's is the shipper's.
 */
const RECIPIENT_SIDE = new Set(['DELIVERED', 'DELIVERY_FAILED', 'DELIVERY_ATTEMPT', 'PICKUP_FAILED', 'RETURN_RECEIVED']);
// SwiftX's own sites: "LAX HUB", "SFO STATION", "EWR_DCA Warehouse".
const SITE = /(?:^|[\s_])(?:HUB|STATION|WAREHOUSE)$/i;
// The help line that ends a failed-delivery note, with SwiftX's phone and email.
const HELP = /[\s,]*\bfor assistance\b.*$/i;
const CONTACT = /\+?\d[\d ().-]{8,}\d|\S+@\S+/;

/** The tracker takes SwiftX's own numbers: SWX and eighteen digits. */
export function normalizeSwiftxNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^SWX\d{18}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'SwiftX tracks SWX and eighteen digits');
}

/** The public tracking page, which looks the number up itself. */
export function swiftxTrackingUrl(raw: string): string {
  return `https://swiftx-express.com/track?trackingNumber=${normalizeSwiftxNumber(raw)}`;
}

/** The scan's wall clock with the offset the row gives for it. */
function scanTime(stamp: unknown, offset: unknown): { iso: string; timestamp: number } {
  const wall = STAMP.exec(clean(stamp, 32));
  const zone = OFFSET.exec(clean(offset, 16));
  const hours = Number(zone?.[2]);
  const minutes = Number(zone?.[3]);
  if (!wall || !zone || hours > 14 || minutes > 59) throw new SchemaError(PROVIDER, 'SwiftX returned an invalid scan clock');
  const parsed = explicitOffsetTime(`${wall[1]}T${wall[2]}${zone[1]}${zone[2]!.padStart(2, '0')}:${zone[3]}`);
  if (!parsed) throw new SchemaError(PROVIDER, 'SwiftX returned an invalid scan clock');
  return parsed;
}

/**
 * The scan's wording on one line. A failed delivery adds the driver's note on
 * a second line and ends it with SwiftX's help line, which is left out; some
 * rows come in quotes.
 */
export function swiftxWording(raw: unknown): string {
  let text = clean(raw, 2000);
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = clean(text.slice(1, -1), 2000);
  text = text.replace(HELP, '');
  const contact = CONTACT.exec(text);
  if (contact) text = text.slice(0, contact.index);
  return clean(text.replace(/[\s,;:]+$/, ''), 500);
}

/** A SwiftX site's town and state. The site's name and postcode are not read. */
function sitePlace(row: Record<string, unknown>, code: string): string {
  if (RECIPIENT_SIDE.has(code) || !SITE.test(clean(row.location, 200))) return '';
  const town = clean(row.cityUppercase, 100);
  const state = clean(row.iso3166Sc, 8);
  if (!/^[A-Z][A-Z .'-]{0,60}[A-Z.]$/.test(town) || town === 'SYSTEM') return '';
  return /^[A-Z]{2}$/.test(state) ? `${town}, ${state}` : town;
}

interface Row { event: CarrierEvent & { time: string; description: string; provider_code: string }; timestamp: number; index: number }

/**
 * The tracker's reply for one number, read at `readAt`. Only a reply naming
 * the whole number counts, and only the tracker's own notice for it is a
 * missing parcel.
 */
export function parseSwiftx(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeSwiftxNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (payload.errors !== undefined && payload.errors !== null) throw new IndeterminateError(PROVIDER, 'SwiftX answered its tracking query with an error');
  // The page asks for its one number as a batch: one answer for the batch, one result per number.
  const batch = isRecord(payload.data) ? payload.data.getOfficialWebsiteTrackingInfoBatch : undefined;
  if (!isRecord(batch) || typeof batch.success !== 'boolean') throw new SchemaError(PROVIDER);
  if (!batch.success) {
    if (VERIFICATION_CODES.has(String(batch.errorCode))) throw new ChallengeError(PROVIDER, 'SwiftX asked for its tracking page\'s verification');
    throw new IndeterminateError(PROVIDER, 'SwiftX did not answer for the shipment');
  }
  if (!Array.isArray(batch.results) || batch.results.length !== 1) throw new SchemaError(PROVIDER, 'SwiftX returned another set of shipments');
  const info: unknown = batch.results[0];
  if (!isRecord(info) || typeof info.success !== 'boolean') throw new SchemaError(PROVIDER);
  if (clean(info.trackingNo, 64).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'SwiftX returned a different shipment');
  const list = info.trackingEventList;
  if (info.success && info.unlockStatus === 'BASIC' && (list === null || (Array.isArray(list) && list.length === 0))) {
    throw new InputRequiredError(PROVIDER, 'recipient verification', 'SwiftX withholds tracking history without recipient phone verification');
  }
  if (!info.success) {
    if (info.message === NOT_FOUND && (list === null || (Array.isArray(list) && list.length === 0))) throw new NotFoundError(PROVIDER);
    if (info.message === VERIFICATION) throw new ChallengeError(PROVIDER, 'SwiftX asked for its tracking page\'s verification');
    throw new IndeterminateError(PROVIDER, 'SwiftX did not answer for the shipment');
  }
  if (!Array.isArray(list) || list.length > MAX_ROWS) throw new SchemaError(PROVIDER);
  const seen = new Set<string>();
  const rows: Row[] = [];
  list.forEach((item, index) => {
    if (!isRecord(item)) throw new SchemaError(PROVIDER);
    const code = clean(item.event, 64);
    const description = swiftxWording(item.description);
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code) || !description) throw new SchemaError(PROVIDER, 'SwiftX returned an unreadable scan');
    const time = scanTime(item.localTime, item.localGmtOffset);
    // A scan stamped after the reply was read has not happened yet.
    if (time.timestamp > readAt) return;
    const location = sitePlace(item, code);
    const event = { time: time.iso, description, ...(location ? { location } : {}), provider_code: code };
    const key = JSON.stringify(event);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ event, timestamp: time.timestamp, index });
  });
  // Newest first, as the tracker lists them; equal clocks keep its order.
  rows.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const newest = rows[0];
  if (!newest) throw new NoHistoryError(PROVIDER);

  // Oldest first, so a scan that moves nothing keeps the stage before it.
  let decider: Row | undefined;
  for (const row of [...rows].reverse()) {
    const classified = swiftxStage(row.event.provider_code, row.event.description);
    if (!classified || classified === 'quiet') continue;
    Object.assign(row.event, { stage: classified.stage, stage_source: classified.source });
    decider = row;
  }
  const stage = decider?.event.stage as Stage | undefined;
  const events = rows.map((row) => row.event);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.event.stage_source } : {}),
    last_status_text: newest.event.description,
    last_update: newest.event.time,
    ...(stage === 'delivered' && decider!.event.provider_code === 'DELIVERED' ? { delivered_at: decider!.event.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS || info.unlockStatus === 'BASIC' ? { history_truncated: true } : {}),
  };
}
