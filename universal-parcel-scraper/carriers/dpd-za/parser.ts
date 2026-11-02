import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dpdZaRailStage, dpdZaStage } from './status.js';

export const PROVIDER = 'DPD South Africa';
// A long history is under twenty kilobytes.
export const DPD_ZA_MAX_BYTES = 512 * 1024;

// Waybills are letters and digits an account, branch or shop chooses, with at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The wall clock the page shows, to the second, with an optional fraction and no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,7})?$/;
// Bot checks Cloudflare, in front of the tracker, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
// Who took the parcel, with the delivery's date and time after: "delivered to SAMPLE <br>Date: …".
const RECEIVER = /\b(delivered|collected|signed|received)\s+(?:to|by)\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone
// numbers are written, or an email address.
const CONTACT = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])|[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill number for DPD South Africa's tracker, in capitals; anything else is not one it issues. */
export function normalizeDpdZaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DPD South Africa waybills are six to thirty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `DPD South Africa returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's wording, the `longDescription` the page shows, without the branch
 * the reply appends, the person who took the parcel and the delivery time
 * after them, or a sentence giving a phone number or an email address.
 */
export function dpdZaWording(description: string, branch = ''): string {
  let line = textFromHtml(description, 600).replace(RECEIVER, '$1');
  if (branch && line.toUpperCase().endsWith(` ${branch.toUpperCase()}`)) line = line.slice(0, -branch.length).trimEnd();
  return line.split(/(?<=[.!?])\s+/).filter((sentence) => !CONTACT.test(sentence)).join(' ').trim().slice(0, 400);
}

/**
 * A scan's `dateAndTime`, which the page shows as it comes: a wall clock in
 * South Africa, with no zone, so it stays `local_time`.
 */
function scanClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  // .NET writes its minimum date where it has none.
  if (!match || !day || day < '2000-01-01') throw new SchemaError(PROVIDER, 'DPD South Africa returned an invalid scan time');
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

/** The waybill a row names, in capitals as the tracker matches it. */
function waybillOf(row: Record<string, unknown>): string {
  if (typeof row.waybillNo !== 'string') throw new SchemaError(PROVIDER, 'DPD South Africa returned a record without its waybill');
  return clean(row.waybillNo, 64).toUpperCase();
}

interface Scan { local: string; code: string; description: string; location: string }

/** A scan the page lists, or null for one it hides. */
function projectScan(row: Record<string, unknown>): Scan | null {
  // The page leaves out scans marked not to be shown, and scans without wording.
  if (row.webVisible === false) return null;
  const id = row.trackingEventTypeId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new SchemaError(PROVIDER, 'DPD South Africa returned a scan without its type');
  }
  const location = text(row, 'branch', 120);
  const local = scanClock(row.dateAndTime);
  const wording = row.longDescription;
  if (wording !== null && wording !== undefined && typeof wording !== 'string') {
    throw new SchemaError(PROVIDER, 'DPD South Africa returned an invalid longDescription');
  }
  const description = dpdZaWording(wording ?? '', location);
  return description ? { local, code: String(id), description, location } : null;
}

/**
 * The reply of the tracker app's `QuickTrack` for one waybill. The tracker
 * answers HTTP 200 with an empty body for a waybill it does not hold, and the
 * page names a `waybillId` of 0 as not found. A waybill must be the one asked;
 * the scans of a parent or child waybill the reply names are not its own.
 */
export function parseDpdZa(body: string, raw: string): CarrierResult {
  const number = normalizeDpdZaNumber(raw);
  // A byte-order mark is whitespace to trim().
  const trimmed = body.trim();
  if (!trimmed || trimmed === 'null') throw new NotFoundError(PROVIDER);
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (cause) {
    if (CHALLENGE.test(trimmed.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DPD South Africa answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'DPD South Africa returned a reply that is not JSON', { cause });
  }
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'DPD South Africa returned an invalid waybill');
  const id = payload.waybillId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new SchemaError(PROVIDER, 'DPD South Africa returned a waybill without its id');
  }
  if (id === 0) throw new NotFoundError(PROVIDER);
  if (waybillOf(payload) !== number) throw new IndeterminateError(PROVIDER, 'DPD South Africa answered for another shipment');
  const related = new Set([text(payload, 'parentWaybillNo', 64), text(payload, 'childWaybillNo', 64)]
    .map((value) => value.toUpperCase()).filter(Boolean));

  const rows = payload.trackingEvents ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'DPD South Africa returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DPD South Africa returned an oversized history');
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DPD South Africa returned an invalid scan');
    // Json.NET writes an object it has already written as a reference to it.
    if (typeof row.$ref === 'string' && Object.keys(row).length === 1) continue;
    const waybill = waybillOf(row);
    if (waybill !== number) {
      if (related.has(waybill)) continue;
      throw new IndeterminateError(PROVIDER, 'DPD South Africa answered with another shipment’s scans');
    }
    const scan = projectScan(row);
    if (scan) scans.push(scan);
  }
  // The depot's copy of a scan names the branch; a copy without it, at the same moment, is dropped.
  const located = new Set(scans.filter((scan) => scan.location).map((scan) => JSON.stringify([scan.local, scan.code, scan.description])));
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const scan of scans) {
    const key = JSON.stringify([scan.local, scan.code, scan.description, scan.location]);
    if (seen.has(key) || (!scan.location && located.has(JSON.stringify([scan.local, scan.code, scan.description])))) continue;
    seen.add(key);
    const staged = dpdZaStage(scan.code, scan.description);
    events.push({
      local_time: scan.local,
      ...(scan.location ? { location: scan.location } : {}),
      description: scan.description,
      provider_code: scan.code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; the reply lists them oldest first.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((a, b) => (a.local_time! < b.local_time! ? 1 : a.local_time! > b.local_time! ? -1 : 0));

  const ops = payload.opsStatusId ?? null;
  if (ops !== null && (typeof ops !== 'number' || !Number.isSafeInteger(ops))) {
    throw new SchemaError(PROVIDER, 'DPD South Africa returned an invalid opsStatusId');
  }
  const rail = ops === null ? undefined : dpdZaRailStage(ops);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The rail settles a delivery, which later manifest and image scans do not
  // undo, and an exception no scan names. Otherwise the newest scan is more
  // precise than the rail, such as a failed round the rail shows on delivery.
  const decided = rail === 'delivered' || rail === 'exception' || !scanned ? rail : undefined;
  const stage = (decided ?? scanned?.stage) as Stage | undefined;
  const source = decided && decided !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
