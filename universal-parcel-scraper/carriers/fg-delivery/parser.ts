import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fgDeliveryStage } from './status.js';

export const PROVIDER = 'FG Delivery';
// A long history is a few kilobytes.
export const FG_DELIVERY_MAX_BYTES = 256 * 1024;

// FG Delivery's own shipment code, FGD and twenty-two digits as its labels
// print it, or Cainiao's code for an AliExpress parcel it delivers.
const NUMBER = /^(?:FGD\d{22}|CNIT[A-Z]{2}\d{8}FLM)$/;
// `DataConsegna` is month, day and year, as the page's script reads it.
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const ORDER = /^[1-9]\d{0,3}$/;
const CODE = /^\d{1,6}$/;
// The FortiWeb page the tracking host answers a refused request with, and bot
// checks a CDN could put in place of the reply.
const CHALLENGE = /Web Page Blocked|Attack ID:|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for FG Delivery's tracker, in upper case; anything else is not one it tracks. */
export function normalizeFgDeliveryNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'FG Delivery numbers are FGD and twenty-two digits, or a Cainiao CNIT code ending in FLM');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `FG Delivery returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An identifier of the row, whole: a longer one is never the number asked. */
function identifier(row: Record<string, unknown>, key: string): string {
  const value = text(row, key, 1000);
  return value.length <= 64 ? normalizeTrackingNumber(value) : '';
}

/**
 * A scan's `DataConsegna` and `OraConsegna`. Each scan also names a
 * `TimeZone`, `GMT+01:00` on every one seen, all of them in winter; whether it
 * follows summer time is unknown, so the clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const date = DATE.exec(text(row, 'DataConsegna', 16));
  const clock = CLOCK.exec(text(row, 'OraConsegna', 16));
  const day = date ? calendarDay(Number(date[3]), Number(date[1]), Number(date[2])) : null;
  if (!day || !clock || day < '2000-01-01') throw new SchemaError(PROVIDER, 'FG Delivery returned an invalid scan time');
  return `${day}T${clock[1]!.padStart(2, '0')}:${clock[2]}:${clock[3]}`;
}

interface Scan {
  readonly shipment: string;
  readonly bound: boolean;
  readonly order: number;
  readonly key: string;
  readonly event: CarrierEvent;
}

/**
 * One row: a scan of the shipment `IdSpedizione`. The tracker finds a row by
 * that number, by `RiferimentoCliente`, the sender's reference, or by
 * `Barcode2`. An FGD number must be the shipment's own; a Cainiao code may be
 * any of the three, whole. The recipient's postcode, name and delivery notes
 * are not read.
 */
function projectRow(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'FG Delivery returned an invalid scan');
  const shipment = identifier(row, 'IdSpedizione');
  if (!shipment) throw new SchemaError(PROVIDER, 'FG Delivery returned a scan without its shipment');
  const order = text(row, 'Progressivo', 8);
  if (!ORDER.test(order)) throw new SchemaError(PROVIDER, 'FG Delivery returned a scan without its order');
  const code = text(row, 'EventCode', 8);
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'FG Delivery returned an invalid scan code');
  const description = text(row, 'Causale', 300);
  if (!description) throw new SchemaError(PROVIDER, 'FG Delivery returned a scan without wording');
  const local = scanClock(row);
  const aliases = [identifier(row, 'RiferimentoCliente'), identifier(row, 'Barcode2')];
  const bound = shipment === number || (!number.startsWith('FGD') && aliases.includes(number));
  const staged = fgDeliveryStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { shipment, bound, order: Number(order), key: JSON.stringify([local, code, description]), event };
}

/**
 * The reply of `GET /GetTrack?IdSpedizione={number}` on tracking.fgdelivery.it:
 * the scans of every shipment the number finds, newest first by `Progressivo`.
 * A number it does not know gets an empty list, which the page reports as an
 * error; FG Delivery's help centre says such a parcel has not reached its
 * national hub. The scans read are those of the one shipment the whole number
 * names.
 */
export function parseFgDelivery(body: string, raw: string): CarrierResult {
  const number = normalizeFgDeliveryNumber(raw);
  // A byte-order mark is whitespace to trim().
  const trimmed = body.trim();
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (cause) {
    if (CHALLENGE.test(trimmed.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FG Delivery answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'FG Delivery returned a reply that is not JSON', { cause });
  }
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'FG Delivery returned an unexpected reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'FG Delivery returned an oversized history');

  const rows = payload.map((row) => projectRow(row, number)).filter((row) => row.bound);
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'FG Delivery answered for another shipment');
  const shipment = rows[0]!.shipment;
  // A reference several parcels share names none of them.
  if (rows.some((row) => row.shipment !== shipment)) throw new IndeterminateError(PROVIDER, 'FG Delivery found several shipments for the number');

  // Newest first, as `Progressivo` counts them; equal orders keep the reply's.
  rows.sort((left, right) => left.order - right.order);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    events.push(row.event);
  }

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    // A Cainiao code finds the parcel under FG Delivery's own number.
    ...(shipment !== number ? { canonical_tracking_number: shipment } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
