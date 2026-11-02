/**
 * The trace tracker of EWE's delivery system. EWE's page on trace.ewe.com.au
 * and HOMEXPRESS's on www.homexpress.com.au each send the number to
 * `/api/trace/orderRoute` on their own host, and one server answers both from
 * one database. This module holds the request and the reply's parser they
 * share; each carrier keeps its host, the numbers it takes and its status map,
 * which reads the delivery system's codes through `traceCodeStage` in EWE's.
 */
import { DateTime, FixedOffsetZone } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

/** One carrier's site on the trace tracker. */
export interface TraceTenant {
  /** The name errors carry. */
  readonly provider: string;
  /** A scan's stage from its `action` code ('' without one) and wording. */
  readonly stage: (code: string, wording: string) => ClassifiedWording | null;
}

// A long history is a few kilobytes.
const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|captcha/i;

/** The trace lookup at `endpoint`, the `/api/trace/orderRoute` of a tenant's host, for one number. */
export const orderRouteUrl = (endpoint: string, number: string) => `${endpoint}?${new URLSearchParams({ orderNo: number })}`;

function json(body: string, provider: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/**
 * A GET of a JSON lookup that answers an unknown number in a 200 reply. A 403
 * is a refusal; a 404 or a redirect is a moved route.
 */
export async function getJson(url: string, provider: string, signal: AbortSignal, timeoutMs: number,
  options: { fetcher?: typeof fetch; userAgent?: string } = {}): Promise<unknown> {
  const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
    Accept: 'application/json', 'User-Agent': userAgentOf(options.userAgent),
  } }, { provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES,
    redirect: 'manual', fetcher: options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
  if (response.status === 403) throw new ChallengeError(provider, `${provider} refused the lookup`, { status: 403 });
  if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
    throw new TransportError(provider, `${provider} tracking lookup is unavailable`, { status: response.status });
  }
  return json(decodeText(bytes), provider);
}

/** An optional text field; anything but a string is a changed reply. */
export function textField(provider: string, row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The driver's name after "driver", as in "Our driver Sample will deliver your parcel to you".
const DRIVER = /\b(drivers?)\s+(?!will\b|is\b|has\b)[^.,;!?]*?(?=\s+(?:will|is|has)\b|[.,;!?]|$)/gi;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/** A scan's wording without the driver's name or a phone number. */
export function scanWording(raw: string): string {
  return clean(raw.replace(DRIVER, '$1').replace(PHONE, '')).replace(/\s+([,;:.])/g, '$1');
}

/** Newest first; scans on one clock keep their order, read in the direction the reply lists them. */
export function newestFirst(events: readonly CarrierEvent[], clock: (event: CarrierEvent) => number): CarrierEvent[] {
  const listed = [...events];
  if (listsNewestFirst(listed) === false) listed.reverse();
  return listed.map((event) => ({ event, key: clock(event) }))
    .sort((a, b) => b.key - a.key)
    .map(({ event }) => event);
}

/** The result of a history, newest scan first. */
export function summarize(events: readonly CarrierEvent[], provider: string): CarrierResult {
  if (!events.length) throw new NoHistoryError(provider);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** A reply's list of scans; none is an empty list. */
export function scanRows(value: unknown, provider: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new SchemaError(provider, `${provider} returned invalid scans`);
  if (value.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  return value;
}

const WALL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ZONE = /^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i;

function zoneMinutes(value: string): number | null {
  const match = ZONE.exec(value);
  if (!match) return null;
  const minutes = (Number(match[2]) * 60 + Number(match[3] ?? 0)) * (match[1] === '-' ? -1 : 1);
  return minutes % 15 === 0 && minutes >= -12 * 60 && minutes <= 14 * 60 ? minutes : null;
}

/**
 * A scan's instant. `utcOperatorTime` is the scan in UTC, `timeZone` the
 * site's offset and `operatorTime` its wall clock, which must agree with the
 * other two. Without an offset the instant stays in UTC.
 */
function traceTime(row: Record<string, unknown>, provider: string): string {
  const utc = textField(provider, row, 'utcOperatorTime', 32);
  const parsed = DateTime.fromISO(utc.replace(' ', 'T'), { zone: 'UTC' });
  if (!WALL_TIME.test(utc) || !parsed.isValid || parsed.toFormat('yyyy-MM-dd HH:mm:ss') !== utc) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  const zone = textField(provider, row, 'timeZone', 16);
  const minutes = zone ? zoneMinutes(zone) : 0;
  if (minutes === null) throw new SchemaError(provider, `${provider} returned an invalid scan time zone`);
  const local = parsed.setZone(FixedOffsetZone.instance(minutes));
  const wall = textField(provider, row, 'operatorTime', 32);
  if (wall && wall !== local.toFormat('yyyy-MM-dd HH:mm:ss')) throw new SchemaError(provider, `${provider} returned clocks that disagree`);
  return local.toISO({ suppressMilliseconds: true })!;
}

function traceEvent(row: unknown, number: string, tenant: TraceTenant): { key: string; event: CarrierEvent } {
  const { provider } = tenant;
  if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
  if (typeof row.orderNo !== 'string') throw new SchemaError(provider, `${provider} returned a scan without its number`);
  if (clean(row.orderNo, 64).toUpperCase() !== number) throw new IndeterminateError(provider, `${provider} answered for another shipment`);
  const code = cleanScalar(row.action, 40);
  const description = scanWording(textField(provider, row, 'routingDescription'));
  if (!description) throw new SchemaError(provider, `${provider} returned a scan without wording`);
  const time = traceTime(row, provider);
  // The suburb and state; the postcode, the coordinates and the photos stay out.
  const city = textField(provider, row, 'eventCity', 80);
  const state = textField(provider, row, 'eventState', 16);
  const location = city ? [city, state].filter(Boolean).join(', ') : textField(provider, row, 'occurLocation', 120);
  const staged = tenant.stage(code, description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time, code, description, location]), event };
}

/**
 * The trace tracker's reply for `number`, already in the tenant's normalized
 * form. It answers a number it does not know with code 404, "Order does not
 * exist" (`订单不存在`), inside an HTTP 200 reply; every scan names its number.
 */
export function parseTrace(payload: unknown, number: string, tenant: TraceTenant): CarrierResult {
  const { provider } = tenant;
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  if (payload.code === 404) throw new NotFoundError(provider);
  if (payload.code !== 200) throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  if (!isRecord(payload.data)) throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of scanRows(payload.data.orderRoutes, provider)) {
    const scan = traceEvent(row, number, tenant);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  return summarize(newestFirst(events, (event) => DateTime.fromISO(event.time as string, { setZone: true }).toMillis()), provider);
}
