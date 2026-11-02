import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { optimaMappedStage } from './status.js';

export const PROVIDER = 'Optima Overnight';
export const CARRIER = 'optima-overnight';
// A long history is a couple of kilobytes.
export const OPTIMA_MAX_BYTES = 256 * 1024;

// P and fourteen digits, as its tracking page prints them.
const NUMBER = /^P\d{14}$/;
// "2026-04-16 23:10:08": a wall clock with no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
// Firewall and bot-check pages that could stand in for the lookup's JSON.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_EVENTS = 200;

/** A number for Optima's tracker: P and fourteen digits. */
export function normalizeOptimaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Optima Overnight numbers are P and fourteen digits');
  return number;
}

/** A firewall or bot-check page in place of the lookup's JSON. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** A scan's date and time as one wall time. The reply names no zone. */
function wallClock(value: unknown): string {
  const parts = CLOCK.exec(text(value));
  if (!parts) throw new SchemaError(PROVIDER, 'Optima Overnight returned an invalid status time');
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number) as [number, number, number, number, number, number];
  // UTC only checks the calendar fields; no offset is assigned.
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 2000 || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new SchemaError(PROVIDER, 'Optima Overnight returned an invalid status time');
  }
  return instant.toISOString().slice(0, 19);
}

function scan(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Optima Overnight returned an invalid status');
  const description = text(row.status);
  if (!description) throw new SchemaError(PROVIDER, 'Optima Overnight returned a status without wording');
  const stage = optimaMappedStage(description);
  return { local_time: wallClock(row.time), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/**
 * The lookup's reply for one number: the shipment's status, its delivery town,
 * its packages, each with its barcode, status, signatory and delivery photos,
 * and its history, oldest first, each status a wall clock with no zone.
 *
 * A package must carry the whole number asked. The address, the signatory,
 * the photos and each status's note are not read.
 */
export function parseOptima(payload: unknown, raw: string): CarrierResult {
  const number = normalizeOptimaNumber(raw);
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw new SchemaError(PROVIDER, 'Optima Overnight returned an unexpected reply');
  }
  const { data } = payload;
  const packages = Array.isArray(data.packages) ? data.packages.filter(isRecord) : [];
  const parcel = packages.find((item) => text(item.barcode).toUpperCase() === number);
  if (!parcel) throw new IndeterminateError(PROVIDER, 'Optima Overnight answered for another shipment');
  const history = data.trackingHistory;
  if (!Array.isArray(history) || history.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Optima Overnight returned an invalid history');

  if (!history.length) {
    // A shipment Optima has not received yet has a status and no history.
    const status = text(parcel.status) || text(data.status);
    const stage = status ? optimaMappedStage(status) : undefined;
    if (!stage) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
      last_status_text: status, last_update: null, last_update_local: wallClock(data.statusTime ?? data.dateCreated),
      expected_delivery: null, summary_only: true, events: [],
    };
  }

  // Newest first: the reply lists them oldest first, so its order is reversed before the sort
  // keeps scans of one second in the order Optima gave them.
  const events = history.map(scan).reverse().sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}

/**
 * The lookup's answer to a number it does not know: HTTP 404 with status
 * NOT_FOUND and a message quoting the number. Any other 404 is a missing route.
 */
export function isUnknownShipment(body: string, number: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  return isRecord(payload) && payload.success === false && payload.status === 'NOT_FOUND' && text(payload.message).includes(`'${number}'`);
}

/** The lookup's reply as JSON, or the reason it is not one. */
export function optimaJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isBlockPage(body)) throw new ChallengeError(PROVIDER, 'Optima Overnight answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Optima Overnight returned a reply that is not JSON', { cause });
  }
}
