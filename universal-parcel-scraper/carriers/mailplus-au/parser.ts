import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { mailplusStage } from './status.js';

export const PROVIDER = 'MailPlus';
export const CARRIER = 'mailplus-au';
// A parcel's reply is a few kilobytes.
export const MAILPLUS_MAX_BYTES = 256 * 1024;
// The tracker takes MailPlus's numbers and the barcodes of the carriers it lodges parcels with,
// so the adapter takes any run of letters and digits with a digit and leaves the layout to it.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// MailPlus's own numbers: MPX and nine digits, MPXL and six.
const OWN = /^MPXL?\d+$/;
// The partner's own pre-advice names it, as Australia Post's first scan does.
const AUSTRALIA_POST = /\bby Australia Post\b/i;
// A clock as the reply gives it: ISO 8601 with milliseconds and the scan's offset.
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const FINAL: readonly Stage[] = ['delivered', 'returned'];
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for MailPlus's tracker, in capitals as the page sends it; anything else is not one it tracks. */
export function normalizeMailplusNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'MailPlus tracks numbers of six to forty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `MailPlus returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A clock with the offset the reply gives it, which the page shows as the shipment's local time. */
function instant(raw: string): { time: string; at: number } {
  const parsed = CLOCK.test(raw) ? explicitOffsetTime(raw) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'MailPlus returned an invalid scan time');
  return { time: parsed.iso, at: parsed.timestamp };
}

/** The calendar day of an estimate, as the page shows it. */
function estimatedDay(payload: Record<string, unknown>, key: string): string | null {
  const raw = text(payload, key, 40);
  if (!raw) return null;
  instant(raw);
  return raw.slice(0, 10);
}

/** A row as an event with its instant, or nothing for an undated one, which the page cannot place. */
function projectRow(row: unknown): { event: CarrierEvent; at: number } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'MailPlus returned an invalid scan');
  const name = text(row, 'name', 200);
  const note = text(row, 'note');
  if (!name && !note) throw new SchemaError(PROVIDER, 'MailPlus returned a scan without a status');
  const location = [text(row, 'city', 120), text(row, 'country', 60)].filter(Boolean).join(', ');
  const date = text(row, 'datetime', 40);
  if (!date) return null;
  const { time, at } = instant(date);
  const staged = mailplusStage(name, note);
  return { at, event: {
    time,
    ...(location ? { location } : {}),
    description: note || name,
    ...(name ? { provider_code: name } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** Rows newest first, as the page lists them, with a repeated row once. */
function eventsOf(rows: readonly unknown[]): CarrierEvent[] {
  const seen = new Set<string>();
  const dated: { event: CarrierEvent; at: number }[] = [];
  // The reply lists rows oldest first; reversed, a row keeps its place before an older one at the same minute.
  for (const row of [...rows].reverse()) {
    const projected = projectRow(row);
    if (!projected) continue;
    const { event } = projected;
    const key = JSON.stringify([event.time, event.provider_code, event.description, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    dated.push(projected);
  }
  return dated.sort((a, b) => b.at - a.at).map(({ event }) => event);
}

/**
 * The newest staged event. A partner's pre-advice after MailPlus collected the parcel moves
 * nothing, so the newest event that did stands in for it.
 */
function currentEvent(events: readonly CarrierEvent[]): CarrierEvent | undefined {
  const staged = events.filter((event) => event.stage);
  const newest = staged[0];
  return newest?.stage === 'registered' ? staged.find((event) => event.stage !== 'registered') ?? newest : newest;
}

/**
 * The carrier the reply names for the barcode it follows the parcel under: its `carrier`, with
 * the link the page gives it, else a partner's pre-advice naming Australia Post.
 */
function partnerOf(payload: Record<string, unknown>, events: readonly CarrierEvent[]): string | undefined {
  const named = text(payload, 'carrier', 80);
  if (named) return carrierIdFromPartner(named, text(payload, 'sendle_tracking_url', 300));
  return events.some((event) => AUSTRALIA_POST.test(event.description ?? '') || AUSTRALIA_POST.test(event.provider_code ?? ''))
    ? 'australia-post' : undefined;
}

/** Whether the tracker asks for the reply to be refreshed from the partner, as the page then does. */
export function isSyncable(payload: unknown): boolean {
  return isRecord(payload) && payload.syncable === true;
}

/**
 * The reply of the tracker's `GET /api/v1/customer/trackings/public/{number}`: the barcode the
 * parcel is followed under, its events oldest first and MailPlus's delivery estimate. The
 * reply never repeats a MailPlus number lodged with a partner: it answers with the partner's
 * barcode. It must name the number asked, or answer a MailPlus number with another carrier's barcode.
 */
export function parseMailplus(payload: unknown, raw: string): CarrierResult {
  const asked = normalizeMailplusNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'MailPlus returned an invalid reply');
  const tracked = normalizeTrackingNumber(text(payload, 'tracked_barcode', 64));
  if (!tracked) throw new SchemaError(PROVIDER, 'MailPlus returned a reply without its barcode');
  if (tracked !== asked && (!OWN.test(asked) || OWN.test(tracked))) throw new IndeterminateError(PROVIDER, 'MailPlus answered for another parcel');
  const rows = payload.events;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'MailPlus returned invalid events');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'MailPlus returned an oversized history');
  const from = estimatedDay(payload, 'estimated_delivery_date_minimum');
  const to = estimatedDay(payload, 'estimated_delivery_date_maximum') ?? from;
  const events = eventsOf(rows);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const current = currentEvent(events);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const settled = stage !== undefined && FINAL.includes(stage);
  const partner = tracked === asked ? undefined : partnerOf(payload, events);
  const service = text(payload, 'service', 80);
  // Grams, which the page shows in kilograms.
  const weight = typeof payload.weight === 'number' && Number.isFinite(payload.weight) && payload.weight > 0 ? payload.weight / 1000 : undefined;
  // While the tracker's partner feeds are down it keeps only collection and lodgement scans.
  const down = payload.uptime !== undefined && payload.uptime !== null && payload.uptime !== 'true' && payload.uptime !== true;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    ...(!settled && to ? { expected_delivery: to } : {}),
    ...(!settled && from && to && from < to ? { expected_delivery_from: from } : {}),
    ...(service ? { service_name: service } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(partner && partner !== CARRIER ? { delivery_carrier: partner } : {}),
    ...(tracked !== asked ? { delivery_tracking_number: tracked } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS || down ? { history_truncated: true } : {}),
  };
}
