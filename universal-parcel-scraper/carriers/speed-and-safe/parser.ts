import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { speedAndSafeStage } from './status.js';

export const PROVIDER = 'Gokulam Speed & Safe';
// A scan's row is under four hundred bytes; a long history stays well under this.
export const SPEED_AND_SAFE_MAX_BYTES = 512 * 1024;

// Eight digits, as the AWB numbers customers quote. The page's own check only asks for three to a hundred characters.
const NUMBER = /^\d{8}$/;
// "2026-05-04 21:07:20.687+05:30": the ERP's timestamp, with its fraction of a second when it has one and its offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?([+-]\d{2})(?::?(\d{2}))?$/;
// A status ends with a dash and whatever the ERP writes after it, as "Arrived- ".
const STATUS = /^(.*?\S)\s*-(?:\s|$)/;
// The leg a dispatch (M) or an arrival (I) row is on: the page writes its other branch after the status, as these words do.
const LEGS: Readonly<Record<string, string>> = { M: 'to', I: 'at' };
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Gokulam Speed & Safe AWB number: eight digits. Anything else is not one it issues. */
export function normalizeSpeedAndSafeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Gokulam Speed & Safe AWB numbers are eight digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Gokulam Speed & Safe returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's instant. The ERP prints each one with its offset, India's +05:30,
 * so it is kept with that offset, to the second.
 */
function scanTime(value: unknown): { time: string; at: number } {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) invalid('Gokulam Speed & Safe returned an invalid scan time');
  const [, day, clock, fraction = '', hours, minutes = '00'] = match;
  const parsed = DateTime.fromISO(`${day}T${clock}${fraction}${hours}:${minutes}`, { setZone: true });
  // Luxon rolls an impossible day or hour over; only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd HH:mm:ss') !== `${day} ${clock}`) invalid('Gokulam Speed & Safe returned an invalid scan time');
  return { time: parsed.startOf('second').toISO({ suppressMilliseconds: true }), at: parsed.toMillis() };
}

/**
 * A status without its dash and what follows it, as "Arrived" for "Arrived- ".
 * The ERP wrote nothing after the dash in the replies seen; what it could put
 * there, such as who took the parcel, is not kept.
 */
export function speedAndSafeWording(status: string): string {
  const value = clean(status, 200);
  return STATUS.exec(value)?.[1] ?? value.replace(/\s*-$/, '');
}

/** The number a row's `consignmentno` ends with: it starts with the route, as "Origin-Destination( Area )-00000000". */
function namedNumber(row: Record<string, unknown>): string {
  const value = row.consignmentno;
  if (typeof value !== 'string' && typeof value !== 'number') invalid('Gokulam Speed & Safe returned a scan without its consignment');
  const named = String(value);
  return named.slice(named.lastIndexOf('-') + 1).trim();
}

interface Scan { at: number; key: string; event: CarrierEvent; staged: ClassifiedWording | null }

/**
 * One row of the history. A dispatch (`M`) goes from `source` to `dest` and an
 * arrival (`I`) is at `dest`, and the page words them "Dispatched to …" and
 * "Arrived at …"; the scan's place is the branch it was made at. An out for
 * delivery (`O`) or delivery (`D`) row is at its `source` branch: its `dest`
 * is the delivery's area. The branch's phone and the remarks are not read.
 */
function projectRow(row: unknown, number: string): Scan {
  if (!isRecord(row)) invalid('Gokulam Speed & Safe returned an invalid scan');
  if (namedNumber(row) !== number) throw new IndeterminateError(PROVIDER, 'Gokulam Speed & Safe answered for another consignment');
  const { time, at } = scanTime(row.processdate);
  const code = text(row, 'transit', 8).toUpperCase();
  const wording = speedAndSafeWording(text(row, 'status', 200));
  if (!wording) invalid('Gokulam Speed & Safe returned a scan without its status');
  const source = text(row, 'source');
  const dest = text(row, 'dest');
  const leg = LEGS[code];
  const description = leg && dest ? `${wording} ${leg} ${dest}` : wording;
  const location = code === 'I' ? dest : source;
  const staged = speedAndSafeStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at, key: JSON.stringify([time, code, description, location]), event, staged };
}

/**
 * The reply of the ERP's `getconsignmentstatus`, which the tracking page's
 * script asks for the number typed in: `{statusCode, status, data}`, with
 * `data` the consignment's scans, newest first. A number it holds nothing
 * under gets `statusCode` "200" and no rows. Another `statusCode` is a failed
 * lookup, which the page words as an invalid number. Every row must end its
 * `consignmentno` with the number asked.
 */
export function parseSpeedAndSafe(reply: unknown, raw: string): CarrierResult {
  const number = normalizeSpeedAndSafeNumber(raw);
  if (!isRecord(reply) || !Object.hasOwn(reply, 'statusCode')) invalid('Gokulam Speed & Safe returned an invalid reply');
  if (String(reply.statusCode) !== '200') throw new IndeterminateError(PROVIDER, 'Gokulam Speed & Safe did not complete the lookup');
  const rows = reply.data;
  if (!Array.isArray(rows)) invalid('Gokulam Speed & Safe returned a reply without its scans');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_ROWS) invalid('Gokulam Speed & Safe returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row: unknown) => {
    const scan = projectRow(row, number);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; of two scans at one instant, the earlier row is the newer, as the reply lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.at - a.at);
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const current = scans.find((scan) => scan.staged);
  const staged = current?.staged;
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(staged?.stage === 'delivered' ? { delivered_at: current!.event.time! } : {}),
    timezone: 'Asia/Kolkata',
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
