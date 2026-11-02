import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { noxStage } from './status.js';

export const PROVIDER = 'nox';
/** The lookup the tracker at trackandtrace.app.nox.express makes for one barcode, which follows it. */
export const NOX_API = 'https://trackandtrace.app.nox.express/api/scannungen/';
// A long history is a few kilobytes.
export const NOX_MAX_BYTES = 256 * 1024;

const ZONE = 'Europe/Berlin';
// The label specification's shipping barcode: a two-digit client code, 000, the
// sender's customer id, the print date and a serial. Then the older SWR
// barcodes, the return barcode: RA, the pickup type, the return customer,
// the returning sender and a serial, and a sender's own barcode of C and 29
// digits, outside the specification, that the tracker answers too.
const NUMBER = /^(?:\d{2}000\d{19}|SWR\d{21}|RA[12][A-Z0-9]{12}\d{9}|C\d{29})$/;
// "2023-09-08T06:27:52": a wall clock in Germany, without an offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(?:\.\d{1,9})?$/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|gokuProps|captcha/i;
const MAX_ROWS = 300;

/** A nox barcode in capitals, as the tracker matches it; anything else is not one nox prints. */
export function normalizeNoxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'nox barcodes are 24 digits, SWR and 21 digits, RA and 22 characters, or C and 29 digits');
  return number;
}

/** Whether a reply is a bot check instead of nox's own. */
export function isNoxChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `nox returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock, dated in Germany; the reply gives no offset. */
function scanTime(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'scanZeit', 40));
  const local = match ? `${match[1]}${match[2] ?? ':00'}` : '';
  const placed = local ? firstOccurrence(DateTime.fromISO(local, { zone: ZONE })) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!placed?.isValid || placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'nox returned an invalid scan time');
  return placed.toISO({ suppressMilliseconds: true });
}

/**
 * One scan: its status wording and clock. The reply leaves the place, the
 * remark and the postcode empty until the recipient's postcode is checked,
 * which the adapter never does. The shipping date, the branch and consignment
 * numbers are left out.
 */
function projectRow(row: Record<string, unknown>): CarrierEvent {
  const description = text(row, 'status');
  if (!description) throw new SchemaError(PROVIDER, 'nox returned a scan without wording');
  const staged = noxStage(description);
  return { time: scanTime(row), description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/**
 * The reply of the tracker's `/api/scannungen/{barcode}`: the scans of the one
 * barcode asked, newest first. The tracker matches the whole barcode and
 * answers `[]` for one it does not know, which its page reports as unknown.
 * Every scan must name the barcode asked.
 */
export function parseNox(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNoxNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'nox returned an invalid reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'nox returned an oversized history');

  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  for (const row of payload) {
    if (!isRecord(row) || typeof row.barcode !== 'string') throw new SchemaError(PROVIDER, 'nox returned a scan without its barcode');
    if (normalizeTrackingNumber(row.barcode).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'nox answered for another barcode');
    const event = projectRow(row);
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(event);
  }
  // Newest first; scans on the same clock keep the reply's order, which is newest first too.
  if (listsNewestFirst(scans) === false) scans.reverse();
  const events = scans.sort((left, right) => Date.parse(right.time!) - Date.parse(left.time!));

  const latest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? scanned!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    events,
  };
}
