import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { PAPERFLY_LAYOUT, paperflyRequestNumber } from './number.js';
import { paperflyStage, paperflySummaryStage } from './status.js';

export const PROVIDER = 'Paperfly';
// A long history is a few kilobytes.
export const PAPERFLY_MAX_BYTES = 256 * 1024;
// Bangladesh's one zone, which the service writes every clock in.
const ZONE = 'Asia/Dhaka';
const CLOCK = 'yyyy-MM-dd HH:mm:ss';
// MySQL's placeholder for a clock it never set.
const NO_CLOCK = /^0000-00-00\b/;
// The service's answer for a number no order has.
const NOT_FOUND = /^data not found\.?\s*record\s*:\s*0$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

// The rider a line names, from the first "Name:" or "Call:" to its end:
// "On the way to delivery,Name: …,Call: …".
const PERSON = /\s*,?\s*\b(?:name|call|phone|mobile|contact)\s*:[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written, and a masked one ("017XXXXX000").
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])|(?<![A-Z\d])\d{2,5}X{3,}\d{2,4}(?![A-Z\d])/gi;
// An amount of money: the cash the rider collects or a merchant proposes.
const AMOUNT = /(?:৳|\b(?:tk|bdt|taka)\b\.?)\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:৳|\b(?:tk|bdt|taka)\b\.?)|(\bcash\b(?:\s+amount)?)\s*[:=]?\s*\d[\d,]*(?:\.\d+)?/gi;

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Paperfly returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A number as the library compares it: without hyphens, in capitals. */
const compared = (value: string) => normalizeTrackingNumber(value).toUpperCase();

/**
 * A history line without the rider it names, phone numbers or amounts of
 * money: "On the way to delivery,Name: …,Call: …" becomes "On the way to
 * delivery". A hold keeps its reason.
 */
export function paperflyWording(message: string): string {
  return clean(message.replace(PERSON, '').replace(PHONE, '').replace(AMOUNT, (_amount, cash?: string) => cash ?? ''))
    .replace(/\s+([,.;:])/g, '$1').replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

function projectRow(row: Record<string, unknown>): { key: string; timestamp: number; event: CarrierEvent } | null {
  const clock = text(row, 'date_time', 40);
  const description = paperflyWording(text(row, 'message', 2_000));
  if (NO_CLOCK.test(clock) || !description) return null;
  const parsed = zonedTime(clock, CLOCK, ZONE);
  if (!parsed) throw new SchemaError(PROVIDER, 'Paperfly returned an invalid scan time');
  const staged = paperflyStage(description);
  const event: CarrierEvent = {
    time: parsed.iso,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([parsed.timestamp, description]), timestamp: parsed.timestamp, event };
}

/**
 * The reply of `track_order.php` for one order number or Daraz reference,
 * the lookup Paperfly's public tracking page makes. A number no order has is
 * HTTP 400 with `{"error":"Data not found. Record:0"}`. The order must name
 * the number asked, as its order number or its merchant's reference. The
 * sender, the recipient, the package's weight, price and cash amounts and
 * the `rotp` field are never read.
 */
export function parsePaperfly(payload: unknown, raw: string): CarrierResult {
  const number = compared(paperflyRequestNumber(raw));
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Paperfly returned an invalid envelope');
  if (Object.hasOwn(payload, 'error')) {
    if (NOT_FOUND.test(cleanScalar(payload.error, 120))) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Paperfly returned an unexpected error');
  }
  const order = text(payload, 'order_number', 64);
  if (!order) throw new SchemaError(PROVIDER, 'Paperfly returned an order without its number');
  if (payload.package !== undefined && payload.package !== null && !isRecord(payload.package)) {
    throw new SchemaError(PROVIDER, 'Paperfly returned an invalid package');
  }
  const reference = isRecord(payload.package) ? text(payload.package, 'merchant_order_ref', 120) : '';
  if (compared(order) !== number && (!reference || compared(reference) !== number)) {
    throw new IndeterminateError(PROVIDER, 'Paperfly answered for another order');
  }
  const rows = payload.timeline ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Paperfly returned an order with an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Paperfly returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Paperfly returned an invalid history line');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  // Newest first; lines of the same second keep the reply's order, which lists the newest first.
  const events = scans.sort((a, b) => b.timestamp - a.timestamp).map((scan) => scan.event);

  const status = text(payload, 'status', 80);
  const summary = paperflySummaryStage(status);
  if (!events.length && !summary) throw new NoHistoryError(PROVIDER);
  const scanned = events.find((event) => event.stage);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  // A closed order's history can lose its lines; the order's status is then
  // ahead of every line that is left.
  const truncated = Boolean(events.length && summary && !events.some((event) => event.stage === summary));
  const newest = events[0];
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  // Looked up by its Daraz reference, the order has its own number.
  const own = compared(order);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: (truncated || !newest ? status : newest.description)!,
    last_update: newest?.time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    ...(own !== number && PAPERFLY_LAYOUT.test(own) ? { canonical_tracking_number: paperflyRequestNumber(own) } : {}),
    ...(events.length ? {} : { summary_only: true }),
    ...(truncated || events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
