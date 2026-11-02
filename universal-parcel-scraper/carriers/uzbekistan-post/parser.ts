import { DateTime, FixedOffsetZone } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { uzbekistanPostStage } from './status.js';

export const PROVIDER = 'Uzbekistan Post';
// A long history with its header is a few tens of kilobytes.
export const UZBEKISTAN_POST_MAX_BYTES = 1024 * 1024;

const ZONE = 'Asia/Tashkent';
const MAX_SCANS = 500;
// The delivery system's instants, in UTC: "2026-09-28T10:25:35.810Z".
const INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?Z$/;
// IPS clocks, without a zone: "2026-06-25T16:31:02", "2026-06-25T11:31:02.907".
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const CODE = /^(?:[a-z][a-z0-9_]{0,63}|\d{1,4})$/;
const COUNTRY = /^[A-Z]{2}$/;
// An office's six-digit postcode, which the delivery system puts in its offices' names.
const POSTCODE = /(?:^|\s)\d{6}(?=\s|$)/g;

/**
 * Uzbekistan Post's tracker takes UPU S10 item codes: its own, ending UZ, and
 * those of the posts that send mail to Uzbekistan. The code needs a valid check digit.
 */
export function normalizeUzbekistanPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Uzbekistan Post tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Uzbekistan Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional nested object; anything but an object is a changed reply. */
function part(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `Uzbekistan Post returned an invalid ${key}`);
  return value;
}

/** The first record of a list the IPS reply wraps one item in, or nothing. */
function only(row: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > 1 || (value.length && !isRecord(value[0]))) {
    throw new SchemaError(PROVIDER, `Uzbekistan Post returned an invalid ${key}`);
  }
  return (value[0] as Record<string, unknown> | undefined) ?? null;
}

function sameItem(value: string, number: string): boolean {
  return normalizeTrackingNumber(value) === number;
}

/** A calendar-checked wall clock to the second; parsing in UTC assigns no offset. */
function wallClock(digits: string | undefined): DateTime {
  const parsed = digits ? DateTime.fromISO(digits, { zone: 'UTC' }) : null;
  if (!digits || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== digits || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid scan time');
  }
  return parsed;
}

interface Scan { event: CarrierEvent; order: number }

/**
 * A scan from Uzbekistan Post's delivery system. Its `date` is an instant in
 * UTC: post-office scans fall in office hours only when read so, and the page
 * shows them in the visitor's own zone. A scan with an `external_id` was copied
 * from the sending post's data: its clock may be that post's wall clock, and its
 * office is the one that took the data in, so it keeps only the wall clock.
 */
function shipoxScan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid scan');
  const code = text(row, 'status', 64);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned a scan without a status');
  const raw = text(row, 'date', 40);
  const instant = wallClock(INSTANT.exec(raw)?.[1]);
  const external = row.external_id !== null && row.external_id !== undefined;
  if (external && typeof row.external_id !== 'string' && typeof row.external_id !== 'number') {
    throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid external_id');
  }
  // The Russian page's wording; a code the system gives no wording keeps its code.
  const description = text(row, 'status_ru', 200) || text(row, 'status_desc', 200) || text(row, 'status_eng', 200) || code;
  const location = external ? '' : officeName(text(part(row, 'warehouse'), 'name', 160));
  const staged = uzbekistanPostStage(code, description);
  const event: CarrierEvent = {
    ...(external ? { local_time: instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") }
      : { time: instant.setZone(ZONE).toISO({ suppressMilliseconds: true })! }),
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, order: DateTime.fromISO(raw).toMillis() };
}

/** An office's name without its postcode: "Примерск ОПС - Примерск - 999999" becomes "Примерск ОПС - Примерск". */
function officeName(name: string): string {
  return name.split(/\s+-\s+/).map(segment => segment.replace(POSTCODE, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join(' - ');
}

/**
 * An IPS scan's clocks. `LocalDateTime` is the scanning office's wall clock;
 * Uzbekistan Post's own scans also carry `GmtDateTime`, whose difference from it
 * is the office's offset. The sending post's scans carry no GMT clock and stay local.
 */
function ipsClock(row: Record<string, unknown>): { clock: { time: string } | { local_time: string }; order: number } {
  const local = wallClock(CLOCK.exec(text(row, 'LocalDateTime', 40))?.[1]);
  const wall = local.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const gmtText = text(row, 'GmtDateTime', 40);
  if (!gmtText) return { clock: { local_time: wall }, order: local.toMillis() };
  const gmt = DateTime.fromISO(CLOCK.test(gmtText) ? gmtText : '', { zone: 'UTC' });
  if (!gmt.isValid) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid scan time');
  const minutes = (local.toMillis() - gmt.toMillis()) / 60_000;
  const offset = Math.round(minutes / 15) * 15;
  // Two clocks that differ by no whole quarter hour, or by more than any zone does, settle no offset.
  if (Math.abs(minutes - offset) > 1 || offset < -720 || offset > 840) return { clock: { local_time: wall }, order: local.toMillis() };
  const time = local.setZone(FixedOffsetZone.instance(offset), { keepLocalTime: true }).toISO({ suppressMilliseconds: true })!;
  return { clock: { time }, order: local.toMillis() };
}

/** A scan from the UPU's IPS, which the tracker reads for EMS items. */
function ipsScan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid scan');
  const type = part(row, 'IPSEventType');
  const rawCode = type.Code;
  if (rawCode !== null && rawCode !== undefined && typeof rawCode !== 'string' && typeof rawCode !== 'number') {
    throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid event code');
  }
  const code = rawCode === null || rawCode === undefined ? '' : String(rawCode).trim();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid event code');
  // The Russian page's name for the event, else its IPS name.
  const name = text(type, 'LocalName_ru', 200) || text(type, 'Name', 200);
  if (!name) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned a scan without wording');
  // The page shows why an item was kept or not delivered beside the event.
  const detail = [text(part(row, 'RetentionReason'), 'Name', 160), text(part(row, 'NonDeliveryReason'), 'Name', 160)].filter(Boolean).join('; ');
  const description = detail ? `${name}: ${detail}` : name;
  const office = text(part(row, 'EventOffice'), 'Name', 120);
  // An office named with a run of digits may be named by its postcode.
  const location = /\d{4}/.test(office) ? '' : office;
  const { clock, order } = ipsClock(row);
  const staged = uzbekistanPostStage(code || null, description);
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, order };
}

function scansOf(rows: unknown, read: (row: unknown) => Scan): Scan[] {
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an item with invalid scans');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row) => {
    const scan = read(row);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  return scans;
}

function resultOf(scans: Scan[], destination: string, truncated: boolean): CarrierResult {
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((left, right) => right.order - left.order).map(({ event }) => event);
  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...(COUNTRY.test(destination) ? { destination_country: destination } : {}),
    ...(truncated ? { history_truncated: true } : {}),
    events,
  };
}

/** The country code of the recipient's location in the item's header. */
function destinationOf(data: Record<string, unknown>): string {
  const locations = data.locations;
  if (locations === null || locations === undefined) return '';
  if (!Array.isArray(locations)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned invalid locations');
  const recipient: unknown = locations.find(location => isRecord(location) && location.pickup === false);
  return isRecord(recipient) ? text(part(recipient, 'country'), 'code', 8) : '';
}

/**
 * The reply for an item of Uzbekistan Post's delivery system: `header` names
 * the item and its locations, and `shipox` holds its scans newest first. Every
 * part null is the page's "not found", which it gives an unknown item and one
 * whose records expired. `gdeposilka`, scans an aggregator relayed from other
 * carriers, is not read.
 */
function parseShipox(payload: Record<string, unknown>, number: string): CarrierResult {
  if (payload.header === null && payload.shipox === null && payload.gdeposilka === null) throw new NotFoundError(PROVIDER);
  const header = payload.header;
  if (!isRecord(header) || header.status !== 'success' || !isRecord(header.data)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid reply');
  const data = header.data;
  if (typeof data.order_number !== 'string') throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an item without its code');
  if (!sameItem(clean(data.order_number, 64), number)) throw new SchemaError(PROVIDER, 'Uzbekistan Post answered for a different item');
  const destination = destinationOf(data);
  const history = payload.shipox;
  if (history === null || history === undefined) throw new NoHistoryError(PROVIDER);
  if (!isRecord(history)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid history');
  if (history.status !== 'success') throw new IndeterminateError(PROVIDER, 'Uzbekistan Post could not read the item’s history');
  if (!isRecord(history.data)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid history');
  const { list, total } = history.data;
  const scans = scansOf(list, shipoxScan);
  const truncated = typeof total === 'number' && Array.isArray(list) && total > list.length;
  return resultOf(scans, destination, truncated);
}

/**
 * The reply for an EMS item, read from the UPU's IPS: one entry naming the
 * item. Its scanning record holds Uzbekistan Post's scans and the sending
 * post's; an item no office scanned yet has only the sending post's data.
 */
function parseIps(payload: unknown[], number: string): CarrierResult {
  if (!payload.length) throw new IndeterminateError(PROVIDER, 'Uzbekistan Post returned no entry for the item');
  if (payload.length !== 1 || !isRecord(payload[0])) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid reply');
  const entry = payload[0];
  if (typeof entry.Fid !== 'string') throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an item without its code');
  if (!sameItem(clean(entry.Fid, 64), number)) throw new SchemaError(PROVIDER, 'Uzbekistan Post answered for a different item');
  const scanned = only(part(entry, 'OperationalMailitems'), 'TMailitemInfoFromScanning');
  const announced = only(part(entry, 'InfoFromEdi'), 'TMailitemInfoFromEDI');
  const info = scanned ?? announced;
  if (!info) throw new NoHistoryError(PROVIDER);
  const id = text(info, 'InternationalId', 64);
  if (id && !sameItem(id, number)) throw new SchemaError(PROVIDER, 'Uzbekistan Post answered for a different item');
  const events = part(info, 'Events');
  const rows = scanned ? events.TMailitemEventScanning : events.TMailitemEventEDI;
  return resultOf(scansOf(rows ?? [], ipsScan), text(part(info, 'DestCountry'), 'Code', 8), false);
}

/** The reply of the tracking page's `GET /api/v1/public/test/{number}/` for one item. */
export function parseUzbekistanPost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeUzbekistanPostNumber(rawNumber);
  if (Array.isArray(payload)) return parseIps(payload, number);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Uzbekistan Post returned an invalid reply');
  // The tracker's answer for an EMS item IPS does not know.
  if (payload.code === 'order_not_found') throw new NotFoundError(PROVIDER);
  return parseShipox(payload, number);
}
