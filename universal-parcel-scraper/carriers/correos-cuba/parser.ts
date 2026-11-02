import { load } from 'cheerio';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { correosCubaStage } from './status.js';

export const PROVIDER = 'Correos de Cuba';
// The tracker page is about seventy kilobytes, most of it the site's frame; a reply is a few.
export const CORREOS_CUBA_MAX_BYTES = 1024 * 1024;

const MAX_ROWS = 500;
// A firewall's, CDN's or bot check's page in place of the site's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha/i;
// The tracker's answer to a page token it does not take, or to none.
const EXPIRED_TOKEN = /token ha caducado/i;
// "2026-05-04 09:12:30", the office's wall clock, which the tracker gives without a zone.
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/;
// The office the tracker names for an item sent abroad; the page shows the destination country in its place.
const EXPORT_OFFICE = 'exportacionIPS';
// The scan for an item an office received; the page names the receiving office, the other scans the one they left.
const RECEIVED = 'RECEPCIONADO';

/** The tracker looks up S10 item codes, Correos de Cuba's own ending CU and those of the posts that send items to Cuba. */
export function normalizeCorreosCubaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Correos de Cuba tracks S10 item codes with a valid check digit');
}

/** A firewall's page in place of the site's, which is no answer about the item. */
export function assertNotChallenged(body: string): void {
  if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Correos de Cuba answered with a firewall page');
}

/**
 * The token the tracker page gives every visitor for its lookups. The page
 * styles a security plugin's captcha for its other forms, so only a page
 * without the token is checked for a firewall's, by its vendor's markers.
 */
export function correosCubaPageToken(html: string): string {
  const token = load(html)('input#side').attr('value')?.trim() ?? '';
  if (/^[A-Za-z0-9]{6,64}$/.test(token)) return token;
  assertNotChallenged(html);
  throw new SchemaError(PROVIDER, 'Correos de Cuba returned a tracker page without its token');
}

/** The tracker's refusal of the page token, which a fresh page replaces. */
export function isExpiredCorreosCubaToken(payload: unknown): boolean {
  return isRecord(payload) && typeof payload.error === 'string' && EXPIRED_TOKEN.test(payload.error);
}

/** A scan's date as the tracker gives it: the office's wall clock, without an offset. */
function localTime(value: unknown): string {
  const match = typeof value === 'string' ? DATE.exec(value.trim()) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Correos de Cuba returned an invalid scan date');
  const [hours, minutes, seconds = '00'] = match.slice(4) as [string | undefined, string | undefined, string | undefined];
  if (hours === undefined || minutes === undefined) return day;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    throw new SchemaError(PROVIDER, 'Correos de Cuba returned an invalid scan time');
  }
  return `${day}T${hours}:${minutes}:${seconds}`;
}

function text(value: unknown, maxLength: number): string {
  if (value != null && typeof value !== 'string') throw new SchemaError(PROVIDER, 'Correos de Cuba returned an invalid scan field');
  return clean(value, maxLength);
}

/**
 * The tracker's reply to `enviosweb`: the item's scans, newest first, each
 * with a state, a date, the office it left and the one it went to, and the
 * countries and progress rail the page shows above them. The tracker matches
 * the whole code, in the year asked and the one before, and its reply does
 * not repeat the code. It answers a code it holds nothing for in those years
 * with no scans and no error, so an empty history is inconclusive.
 */
export function parseCorreosCuba(payload: unknown, rawNumber: string): CarrierResult {
  normalizeCorreosCubaNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.datos)) throw new SchemaError(PROVIDER, 'Correos de Cuba returned an unexpected reply');
  if (payload.datos.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Correos de Cuba returned an oversized history');
  if (!payload.datos.length) {
    if (payload.error != null && typeof payload.error !== 'string') throw new SchemaError(PROVIDER, 'Correos de Cuba returned an invalid error');
    if (clean(payload.error, 200)) throw new IndeterminateError(PROVIDER, 'Correos de Cuba refused the lookup');
    throw new NoHistoryError(PROVIDER, 'Correos de Cuba holds no scans for the item this year or last');
  }
  const country = text(payload.p_destino, 80);
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of payload.datos) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Correos de Cuba returned an invalid history row');
    const description = text(row.estado, 200);
    if (!description) throw new SchemaError(PROVIDER, 'Correos de Cuba returned a scan without a state');
    const local = localTime(row.fecha);
    const from = text(row.oficina_origen, 120), to = text(row.oficina_destino, 120);
    // Where the page puts the scan: the office that received the item, else the one it left, the destination country for an export.
    const location = description.toUpperCase() === RECEIVED ? to || from : from === EXPORT_OFFICE ? country : from;
    const key = [local, location, description].join('\n');
    // A scan listed twice is kept once.
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = correosCubaStage(description);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description ?? null,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
