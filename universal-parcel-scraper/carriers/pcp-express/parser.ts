import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pcpExpressStage } from './status.js';

export const PROVIDER = 'PCP Express';
// A long history is a few kilobytes.
export const PCP_EXPRESS_MAX_BYTES = 256 * 1024;
// The tracker refuses fewer than fourteen characters as not an AWB. PCP Express AWBs are a
// branch code and digits, sometimes with letters between; letters and digits only keep a
// comma, which would search a second number, or a wildcard from reaching it.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{14,30}$/;
// A scan's clock, to the second, sometimes with a fraction.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,7})?$/;
// The tracker's answer for a number it has no shipment for.
const NOT_FOUND = /^Awb\/Refno tidak ditemukan\b/i;
// Its answer for a number it does not take as an AWB.
const NOT_AN_AWB = /^AWB tidak valid\b/i;
// Its answer for a request without a number.
const NO_NUMBER = /^Awb wajib diisi\b/i;
// The undelivered status, whose note opens with the reason the courier recorded:
// "-{reason}-{receiver}-{date}-{time}". The receiver is not read.
const UNDELIVERED = '1';
const REASON = /^-([A-Z][A-Z .,/()&']{2,80}?)\s*-[^-]*-\d{4}-\d{2}-\d{2}-\d{2}:\d{2}$/i;
// The brand before a branch's name, as "PCP EXPRESS PULOGADUNG".
const BRAND = /^PCP\s+EXPRESS\b\s*/i;
const MAX_SHIPMENTS = 10;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A PCP Express AWB, in capitals; anything else is not one PCP Express issues. */
export function normalizePcpExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PCP Express AWBs are fourteen or more letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PCP Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's `StatusId`, a nonnegative integer, as text; none when the scan has none. */
function statusId(row: Record<string, unknown>): string {
  const value = row.StatusId;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return String(Number(value));
  throw new SchemaError(PROVIDER, 'PCP Express returned an invalid StatusId');
}

/**
 * A scan's `TrackingDate`: a wall clock without a zone. Indonesia has three
 * zones and the reply does not say whose clock it is, so it stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'TrackingDate', 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'PCP Express returned an invalid scan time');
  }
  return local;
}

/** A scan's wording: its status name, and for an undelivered scan the reason, as "…: PENERIMA TIDAK DITEMPAT". */
function wording(row: Record<string, unknown>, code: string): string {
  const name = text(row, 'StatusName', 120);
  if (!name) throw new SchemaError(PROVIDER, 'PCP Express returned a scan without its status');
  if (code !== UNDELIVERED) return name;
  const reason = REASON.exec(text(row, 'RelatioanName', 300))?.[1]?.trim();
  return reason ? `${name}: ${reason}` : name;
}

/** The scan's town, else its branch without the brand. */
function place(row: Record<string, unknown>): string {
  return text(row, 'Location', 80) || text(row, 'OfficeName', 80).replace(BRAND, '');
}

interface Scan { event: CarrierEvent; order: number }

function scanOf(row: Record<string, unknown>, number: string, order: number): Scan {
  const awb = text(row, 'AwbNo', 64);
  if (!awb) throw new SchemaError(PROVIDER, 'PCP Express returned a scan without its AWB');
  if (normalizeTrackingNumber(awb) !== number) throw new IndeterminateError(PROVIDER, 'PCP Express answered for another shipment');
  const code = statusId(row);
  const description = wording(row, code);
  const location = place(row);
  const staged = pcpExpressStage(code, description);
  return {
    event: {
      local_time: scanClock(row),
      description,
      ...(location ? { location } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    order,
  };
}

/** The reply's one shipment whose header names the number asked. */
function shipmentFor(list: unknown, number: string): Record<string, unknown> {
  if (!Array.isArray(list) || !list.length || list.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'PCP Express returned an invalid shipment list');
  const matching = list.filter((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.header)) throw new SchemaError(PROVIDER, 'PCP Express returned an invalid shipment');
    const tracking = text(entry.header, 'TrackingNo', 64);
    if (!tracking) throw new SchemaError(PROVIDER, 'PCP Express returned a shipment without its AWB');
    return normalizeTrackingNumber(tracking) === number;
  }) as Record<string, unknown>[];
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'PCP Express answered for another shipment');
  return matching[0]!;
}

/**
 * The reply of `apps/RequestTracking.php`, the lookup the tracking results
 * page makes, for one AWB: `{"status":true,"list":[{"header":…,"detail":[…]}]}`.
 * A number it has no shipment for is `{"status":false}` with a message, which
 * the page reports as not found. The shipment and each scan must name the AWB
 * asked. The sender's and recipient's names and addresses, the receiver who
 * signed, the courier and the run sheet, manifest and bag numbers are never read.
 */
export function parsePcpExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizePcpExpressNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'boolean') throw new SchemaError(PROVIDER, 'PCP Express returned an invalid envelope');
  if (!payload.status) {
    const message = typeof payload.msg === 'string' ? clean(payload.msg, 300) : '';
    if (NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER);
    if (NOT_AN_AWB.test(message)) throw new InvalidInputError(PROVIDER, 'PCP Express does not take this number as an AWB', { reason: 'wrong_number' });
    if (NO_NUMBER.test(message)) throw new SchemaError(PROVIDER, 'PCP Express did not read the number asked');
    // A database timeout, or another failure of the lookup itself.
    throw new IndeterminateError(PROVIDER, 'PCP Express could not complete the lookup');
  }
  const shipment = shipmentFor(payload.list, number);
  const rows = shipment.detail ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'PCP Express returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PCP Express returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const [order, row] of rows.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PCP Express returned an invalid scan');
    const scan = scanOf(row, number, order);
    const { local_time: local, provider_code: code, description, location } = scan.event;
    const key = JSON.stringify([local, code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock; the reply lists scans newest first, so scans of one second keep its order.
  const clock = (scan: Scan) => scan.event.local_time as string;
  const events = scans.sort((a, b) => (clock(a) < clock(b) ? 1 : clock(a) > clock(b) ? -1 : a.order - b.order)).map(({ event }) => event);

  const newest = events[0]!;
  // A delivery settles the parcel whatever its clock, as the results page lists it first.
  const current = events.find((event) => event.stage === 'delivered') ?? events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = text(shipment.header as Record<string, unknown>, 'ServiceName', 80);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: (stage === 'delivered' ? current! : newest).description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(/[A-Z]/i.test(service) ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
