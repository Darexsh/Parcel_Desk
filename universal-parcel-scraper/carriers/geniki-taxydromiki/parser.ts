import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { genikiStage } from './status.js';

export const PROVIDER = 'Geniki Taxydromiki';

const MAX_EVENTS = 500;
// The voucher web service's result codes, which the tracker passes on.
const FOUND = 0;
const ABSENT = 9;
// Where a scan names the sender or the recipient instead of a service point.
const ROLES = new Set(['SHIPPER', 'RECIPIENT', 'ΑΠΟΣΤΟΛΕΑΣ', 'ΠΑΡΑΛΗΠΤΗΣ']);
// The tracking page hides a scan and the scan that cancels it, the last such pair of each kind.
const CANCELLED: readonly (readonly [string, string])[] = [['C_L1', 'C_L2'], ['C_E1', 'C_E2'], ['C_K8', 'C_K9']];

/** A ten-digit voucher, the only shape Geniki Taxydromiki's tracker, clients and shipments show. */
export function normalizeGenikiNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Geniki Taxydromiki requires a ten-digit voucher number');
  return number;
}

/** A scan's wall clock. The reply gives no offset, so the clock stays local; fractions of a second are dropped. */
function clock(raw: unknown): { local_time?: string; provider_time_text?: string } {
  if (raw != null && typeof raw !== 'string') throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned an invalid scan clock');
  const text = clean(raw, 40);
  const wall = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/.exec(text)?.[1];
  const parsed = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  // The web service's empty date is a year-1 or 1900 placeholder.
  if (parsed?.isValid && parsed.year < 2000) return {};
  return parsed?.isValid ? { local_time: wall } : text ? { provider_time_text: text } : {};
}

function cancelledRows(codes: readonly string[]): Set<number> {
  const hidden = new Set<number>();
  for (const [scan, cancellation] of CANCELLED) {
    let pair: readonly [number, number] | undefined;
    codes.forEach((code, index) => {
      const later = code === scan ? codes.indexOf(cancellation, index + 1) : -1;
      if (later !== -1) pair = [index, later];
    });
    if (pair) pair.forEach(index => hidden.add(index));
  }
  return hidden;
}

/**
 * The tracker's reply for one voucher: its checkpoints, oldest first, each with
 * its code, wording, service point and wall clock. The name of whoever received
 * the parcel, the scanning device's coordinates, the return voucher and the
 * delivery summary are never read.
 */
export function parseGeniki(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGenikiNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  // The tracker's own refusal, such as a missing number, or its expired service key.
  if (payload.success === false || payload.invalid_token !== undefined) {
    throw new IndeterminateError(PROVIDER, 'Geniki Taxydromiki tracking did not answer');
  }
  if (payload.success !== true) throw new SchemaError(PROVIDER);
  const keys = Object.keys(payload).filter(key => key !== 'success');
  if (keys.length !== 1 || keys[0] !== number) throw new SchemaError(PROVIDER, 'Geniki Taxydromiki answered for a different voucher');
  const entry = payload[number];
  const reply = isRecord(entry) ? entry.TrackAndTraceResult : undefined;
  if (!isRecord(reply) || typeof reply.Result !== 'number' || !Number.isInteger(reply.Result)) {
    throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned no tracking result');
  }
  if (reply.Result === ABSENT) throw new NotFoundError(PROVIDER);
  // 10 withholds a voucher from the tracker's account and 11 is its expired
  // session: neither says anything about the parcel.
  if (reply.Result !== FOUND) throw new IndeterminateError(PROVIDER, `Geniki Taxydromiki answered with result ${reply.Result}`);
  if (!isRecord(reply.Checkpoints)) throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned invalid checkpoints');
  const listed = reply.Checkpoints.Checkpoint;
  // The web service collapses a single checkpoint into an object.
  const rows = listed === undefined ? [] : Array.isArray(listed) ? listed : [listed];
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned invalid checkpoints');
  // The page shows its not-found notice for a voucher without checkpoints, but the
  // service found the voucher: that proves neither a parcel on its way nor absence.
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'Geniki Taxydromiki returned no checkpoints for the voucher');
  const scans = rows.map(row => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned an invalid checkpoint');
    const code = typeof row.StatusCode === 'string' ? row.StatusCode.trim() : '';
    const description = clean(row.Status, 300);
    if (!/^C_[A-Z0-9_]{1,16}$/.test(code) || !description) {
      throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned a checkpoint without its code or wording');
    }
    if (row.Shop != null && typeof row.Shop !== 'string') throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned an invalid service point');
    const shop = clean(row.Shop, 100);
    return { code, description, location: ROLES.has(shop.toUpperCase()) ? '' : shop, time: clock(row.StatusDate) };
  });
  const hidden = cancelledRows(scans.map(scan => scan.code));
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // Newest first; equal clocks keep the reply's order.
  for (const [index, scan] of [...scans.entries()].reverse()) {
    if (hidden.has(index)) continue;
    const stage = genikiStage(scan.code);
    const event: CarrierEvent = { description: scan.description, provider_code: scan.code, ...scan.time,
      ...(scan.location ? { location: scan.location } : {}), ...(stage ? { stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Geniki Taxydromiki returned only cancelled checkpoints');
  const latest = events[0]!;
  const stage = genikiStage(latest.provider_code!);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage } : {}),
    last_status_text: latest.description ?? null, last_update: null, last_update_local: latest.local_time ?? null,
    expected_delivery: null, events };
}
