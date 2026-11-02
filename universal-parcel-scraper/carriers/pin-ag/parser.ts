import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pinAgStatus } from './status.js';

export const PROVIDER = 'PIN AG';
// A parcel's reply lists a few statuses, each with the recipient's address.
export const PIN_AG_MAX_BYTES = 256 * 1024;
// Parcels carry sixteen digits; registered letters and court deliveries thirteen,
// the last of which a label can print in brackets.
const NUMBER = /^(?:\d{13}|\d{16})$/;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;
// The page shows each stamp in UTC, so its clock is Berlin's labelled as UTC.
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(?:Z|\+00:?00)$/;
// The status the tracker sends for a number it does not know, like its 404.
const NOT_FOUND_HINT = 'NOT_FOUND_HINT';

/** A PIN AG number as its tracker takes it: digits only, without the brackets a label prints. */
export function normalizePinAgNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw.replace(/[()]/g, '')) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PIN AG numbers are thirteen or sixteen digits');
  return number;
}

function field(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `PIN AG returned an invalid ${key}`);
  return typeof value === 'number' ? cleanScalar(value, maxLength) : clean(value, maxLength);
}

/** The status's label, which the page renders as HTML, as plain text. */
function plain(label: string): string {
  return clean(label.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), 500);
}

/**
 * A 404, or another refusal, from the tracker. Its own message for a number it
 * holds no status for, after six months for instance, is not found; a 405 is an
 * item type PIN does not track, such as a standard letter.
 */
export function parsePinAgMissing(status: number, text: string): never {
  let message = '';
  try {
    const reply: unknown = JSON.parse(text);
    if (isRecord(reply) && isRecord(reply.error)) message = field(reply.error, 'message');
  } catch {
    // Not the tracker's JSON: a proxy's page says nothing about the number.
  }
  if (status === 404 && /kein Zustellstatus gefunden/i.test(message)) {
    throw new NotFoundError(PROVIDER, 'PIN AG holds no status for this number');
  }
  if (status === 405 && message) throw new IndeterminateError(PROVIDER, 'PIN AG does not track this item type', { reason: 'tracking_withheld' });
  throw new IndeterminateError(PROVIDER, `PIN AG answered HTTP ${status}`);
}

/**
 * The statuses of the number asked for. The reply does not repeat the number:
 * they are those of the number in the request. Only each status's code, stage,
 * label and clock are read; the recipient's address, the depot's and the sender's
 * customer number are not.
 */
export function parsePinAg(reply: unknown, raw: string): CarrierResult {
  normalizePinAgNumber(raw);
  if (!isRecord(reply) || !Array.isArray(reply.statuses) || reply.statuses.length > MAX_ROWS) throw new SchemaError(PROVIDER);
  if (!reply.statuses.length) throw new IndeterminateError(PROVIDER, 'PIN AG returned no status', { reason: 'portal_not_found' });
  // The tracker lists the oldest status first.
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of reply.statuses) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PIN AG returned an invalid status');
    const code = field(row, 'statusCode', 32);
    if (code === NOT_FOUND_HINT) throw new NotFoundError(PROVIDER, 'PIN AG holds no status for this number');
    const stageName = field(row, 'stage', 64);
    const description = plain(field(row, 'label', 2_000)) || field(row, 'statusDescription') || stageName;
    if (!code || !description) throw new SchemaError(PROVIDER, 'PIN AG returned a status without code or wording');
    const stamp = field(row, 'timeStamp', 64);
    const clock = STAMP.exec(stamp);
    const mapped = pinAgStatus(stageName, code);
    const event: CarrierEvent = { description, provider_code: code,
      ...(clock ? { local_time: clock[1]! } : stamp ? { provider_time_text: stamp } : {}),
      ...(mapped ? { stage: mapped.stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  events.reverse();
  const latest = events[0]!;
  const last = reply.statuses.at(-1) as Record<string, unknown>;
  const mapped = pinAgStatus(field(last, 'stage', 64), field(last, 'statusCode', 32));
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time ?? null,
    events: events.slice(0, MAX_EVENTS) };
}
