import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { forzaStage } from './status.js';

export const PROVIDER = 'Forza Delivery';
// A long history is a few kilobytes.
export const FORZA_MAX_BYTES = 512 * 1024;
// The tracking page's own check for a guía: the FD series and six to nine digits.
const NUMBER = /^FD(\d{6,9})$/;
// A scan's clock, to the second. The reply ends it with a Z that names no zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?Z?$/;
// The incidents, whose classification the page puts before their description.
const INCIDENT = '45';
// The method's results for a guía it does not know and for one it found.
const NOT_FOUND = 404;
const FOUND = new Set([200, 202]);
const MAX_ROWS = 500;
// A firewall's, CDN's or bot check's page in place of the reply, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|AwsWafIntegration|awswaf\.com|g-recaptcha|hcaptcha/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){7,}(?![A-Z\d])/gi;
// Who took or signed for the parcel, and anything after it.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:recibid[oa]|firmad[oa]|entregad[oa])\s+(?:por|a)\b|recibe\s*:)[\s\S]*$/iu;

/** A guía for Forza's tracker, in upper case; anything else is not one Forza issues. */
export function normalizeForzaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Forza guías are FD and six to nine digits');
  return number;
}

/** Whether a reply is a firewall's or bot check's page. */
export function isForzaBlockPage(text: string): boolean {
  return BLOCKED.test(text.slice(0, 64_000));
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Forza returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's stage id, the page's code for it: a nonnegative integer, or none. */
function codeOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, 'Forza returned an invalid stage id');
  return String(value);
}

/**
 * A scan's wording as the page shows it: the title, then the description
 * when it says more, after an incident's classification. The description
 * loses a clause naming who took the parcel, and both lose phone numbers.
 */
export function forzaWording(title: string, description = '', classification = ''): string {
  const tidy = (value: string) => clean(value.replace(PHONE, '').replace(/\s+([,;:.])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  const label = tidy(title);
  const detail = [tidy(classification), tidy(description.replace(RECEIVER, ''))].filter(Boolean).join(' - ');
  if (!detail || normalizeStatusWording(detail) === normalizeStatusWording(label)) return label;
  return label ? `${label}: ${detail}` : detail;
}

/**
 * A scan's `date`, as `2026-01-02 15:04:05Z`. The page shows its digits as
 * they are, through the UTC clock, and the tracker's summary gives the same
 * digits without a Z, so it is a wall clock and stays one.
 */
function clockOf(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'Forza returned an invalid scan time');
  }
  return wall;
}

/** One milestone: its title, description, stage id and clock. Its user, map point and proof of delivery are dropped. */
function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Forza returned an invalid scan');
  const code = codeOf(row.stageId);
  const description = forzaWording(text(row, 'title'), text(row, 'description'), code === INCIDENT ? text(row, 'clasification') : '');
  if (!description) throw new SchemaError(PROVIDER, 'Forza returned a scan without wording');
  const staged = forzaStage(code, description);
  return {
    local_time: clockOf(row.date),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The guía an order is for, which must be the one asked. */
function bindOrder(order: Record<string, unknown>, number: string): void {
  if (typeof order.GuideSerie !== 'string' || typeof order.GuideNumber !== 'number' || !Number.isSafeInteger(order.GuideNumber)) {
    throw new SchemaError(PROVIDER, 'Forza returned an order without its guía');
  }
  // The tracker reads the digits as a number, so leading zeros name the same guía.
  const asked = `FD${Number(number.slice(2))}`;
  const series = clean(order.GuideSerie, 8).toUpperCase();
  const id = order.id === undefined || order.id === null ? null : clean(order.id, 32).toUpperCase();
  if (`${series}${order.GuideNumber}` !== asked || (id !== null && id !== asked)) {
    throw new IndeterminateError(PROVIDER, 'Forza answered for another guía');
  }
}

/**
 * The `GetNewDeliveryTracking` answer for one guía, decoded from its
 * envelope: `ObjectValue.IdResult` 404 for a guía the tracker does not
 * know, which the page reports as missing, else the order with its
 * milestones, newest first. The customer, sender, recipient, phone and prices
 * in the order are not kept.
 */
export function parseForza(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeForzaNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Forza returned an invalid answer');
  if (payload.StatusCode !== 200) throw new IndeterminateError(PROVIDER, 'Forza did not complete the lookup');
  const answer = payload.ObjectValue;
  if (!isRecord(answer)) throw new SchemaError(PROVIDER, 'Forza returned an invalid answer');
  if (typeof answer.IdResult !== 'number') throw new SchemaError(PROVIDER, 'Forza returned an answer without its result');
  if (answer.IdResult === NOT_FOUND) throw new NotFoundError(PROVIDER);
  // The page shows its message for the other results: several guías for a reference, or a refusal.
  if (!FOUND.has(answer.IdResult)) throw new IndeterminateError(PROVIDER, 'Forza did not answer for the guía');
  if (!isRecord(answer.order)) throw new SchemaError(PROVIDER, 'Forza returned an answer without its order');
  bindOrder(answer.order, number);
  const rows = answer.order.milestones ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Forza returned an order with invalid milestones');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Forza returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = scanOf(row);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Older guías keep their order without its milestones.
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  if (events[0]!.local_time! < events.at(-1)!.local_time!) events.reverse();

  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    events,
  };
}

/** One layer of the reply: a JSON object written into a string. */
function layer(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Forza returned an invalid ${name}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new SchemaError(PROVIDER, `Forza returned an invalid ${name}`, { cause });
  }
  if (!isRecord(parsed)) throw new SchemaError(PROVIDER, `Forza returned an invalid ${name}`);
  return parsed;
}

/**
 * The page method's body. ASP.NET wraps the relay's answer as a string in
 * `d`; the relay's `Data` and its `PayLoad` are strings of JSON in turn. A
 * relay that failed to reach the tracking service has no `Data`, and names
 * the HTTP status it got in `StatusCode`.
 */
export function parseForzaReply(body: string, rawNumber: string): CarrierResult {
  const number = normalizeForzaNumber(rawNumber);
  // Trimming also drops a byte order mark.
  const raw = body.trim();
  if (!raw) throw new IndeterminateError(PROVIDER, 'Forza returned an empty reply');
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch (cause) {
    if (isForzaBlockPage(raw)) throw new ChallengeError(PROVIDER, 'Forza answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Forza returned a reply that is not JSON', { cause });
  }
  if (!isRecord(envelope)) throw new SchemaError(PROVIDER, 'Forza returned an invalid envelope');
  const relay = layer(envelope.d, 'envelope');
  if (relay.Data === null || relay.Data === undefined || relay.Data === '') {
    if (relay.StatusCode === 'TooManyRequests') throw new RateLimitedError(PROVIDER, undefined, 'Forza’s tracking service is rate limiting lookups');
    throw new IndeterminateError(PROVIDER, 'Forza’s tracking service did not answer');
  }
  const data = layer(relay.Data, 'reply');
  if (data.PayLoad === null || data.PayLoad === undefined || data.PayLoad === '') {
    throw new IndeterminateError(PROVIDER, 'Forza’s tracking service did not answer');
  }
  return parseForza(layer(data.PayLoad, 'answer'), number);
}
