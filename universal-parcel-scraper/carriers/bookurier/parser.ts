import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bookurierStage } from './status.js';

export const PROVIDER = 'Bookurier';
/** The tracking page, which opens a session and hands it a lookup token. */
export const BOOKURIER_PAGE = 'https://t.bookurier.ro/';
/** The lookup the page makes for the number typed in. */
export const BOOKURIER_API = 'https://t.bookurier.ro/track/api';
// The page is under fifty kilobytes and a long history a few.
export const BOOKURIER_MAX_BYTES = 512 * 1024;

const ZONE = 'Europe/Bucharest';
// Bookurier's own waybills. Its tracker also answers its partners' numbers, which stay with them.
const NUMBER = /^BOK\d{7}$/;
const TOKEN = /<meta\s+name=["']track-token["']\s+content=["']([0-9a-f]{32,128})["']/i;
// "2026-03-05 13:45:17": a wall clock in Romania, without an offset.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const WEIGHT = /^(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:kg)?$/i;
// The reply's message for a number the tracker does not know.
const NOT_FOUND = 'AWB not found';
// Bot checks a CDN or firewall could put in place of the page or the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|hcaptcha|captcha-delivery/i;
const MAX_ROWS = 300;

/** A Bookurier waybill in capitals; anything else is not one Bookurier issues. */
export function normalizeBookurierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Bookurier waybills are BOK and seven digits');
  return number;
}

/** Whether a page or reply is a bot check instead of Bookurier's own. */
export function isBookurierChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** The lookup token the tracking page carries in a meta tag; it holds for one lookup in the page's session. */
export function readBookurierToken(html: string): string {
  const token = TOKEN.exec(html.slice(0, 64_000))?.[1];
  if (token) return token;
  if (isBookurierChallenge(html)) throw new ChallengeError(PROVIDER, 'Bookurier answered with a browser check');
  throw new SchemaError(PROVIDER, 'Bookurier\'s tracking page has no lookup token');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Bookurier returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock, dated in Romania; the reply gives no offset. */
function scanTime(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'date', 32));
  const local = match ? `${match[1]}T${match[2]}` : '';
  const placed = local ? firstOccurrence(DateTime.fromISO(local, { zone: ZONE })) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!placed?.isValid || placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Bookurier returned an invalid scan time');
  return placed.toISO({ suppressMilliseconds: true });
}

function projectRow(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bookurier returned an invalid scan');
  // The page shows the scan's own wording over its group's.
  const description = text(row, 'status') || text(row, 'status_unified');
  if (!description) throw new SchemaError(PROVIDER, 'Bookurier returned a scan without wording');
  const code = text(row, 'status_code', 40).toLowerCase();
  const location = text(row, 'location', 120);
  const staged = bookurierStage(code, description);
  return {
    time: scanTime(row),
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The shipment's weight, as "3.5 kg"; a missing or unreadable one is left out. */
function weightOf(value: unknown): number | null {
  const match = WEIGHT.exec(typeof value === 'number' ? String(value) : clean(value, 20));
  const weight = match ? Number(match[1]!.replace(',', '.')) : NaN;
  return Number.isFinite(weight) && weight > 0 && weight <= 10_000 ? weight : null;
}

/**
 * The reply of the page's `/track/api` for one waybill: its summary and its
 * scans, newest first, with Bookurier's code for each. An unknown number gets
 * `success: false` and "AWB not found"; a lookup without a valid session gets
 * `token_expired`. The shipment must name the number asked.
 */
export function parseBookurier(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBookurierNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Bookurier returned an invalid envelope');
  if (!payload.success) {
    if (payload.token_expired === true) {
      throw new IndeterminateError(PROVIDER, 'Bookurier did not accept the tracking session', { reason: 'session_rejected' });
    }
    if (text(payload, 'message', 200) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Bookurier did not complete the lookup');
  }
  if (typeof payload.awb !== 'string') throw new SchemaError(PROVIDER, 'Bookurier returned a shipment without its number');
  if (normalizeTrackingNumber(payload.awb).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Bookurier answered for another shipment');
  const rows = payload.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Bookurier returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Bookurier returned an oversized history');

  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  for (const row of rows) {
    const event = projectRow(row);
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(event);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans on the same clock keep the reply's order, which is newest first too.
  const events = scans.sort((left, right) => Date.parse(right.time!) - Date.parse(left.time!));

  const latest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The summary's flags for a parcel whose journey ended.
  const summary: Stage | undefined = payload.is_returned === true ? 'returned' : payload.is_delivered === true ? 'delivered' : undefined;
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const weight = weightOf(payload.weight);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    events,
  };
}
