import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent } from '../../core/result/index.js';
import type { ClassifiedWording } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

// The rtb56 tracking platform Shenzhen forwarders run their trackers on. Each
// forwarder has its own host; the request and the reply are the same.

// One parcel's reply is a few kilobytes.
export const RTB56_MAX_BYTES = 512 * 1024;
export const RTB56_REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
// A tenant's own codes can number its milestones after its letters.
const CODE = /^[A-Z]{1,8}\d{0,3}$/;
const MAX_ROWS = 500;
// Four to six digits standing alone in a place are a postcode.
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])\d{4,6}(?![\p{L}\p{N}])/gu;
// Who took a delivered parcel, as a delivery line can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signatory|signature)\b.*$/i;

/** The page's request for one number: `param` the JSON of its query, `key` the Base64 of that text's MD5 in hexadecimal. */
export function rtb56LookupUrl(api: string, callback: string, number: string): string {
  const param = JSON.stringify({ sp: '', nums: [number] });
  const key = Buffer.from(createHash('md5').update(param).digest('hex')).toString('base64');
  const query = new URLSearchParams({ callbackparam: callback, method: 'track', key, param });
  return `${api}?${query}`;
}

/** The reply's JSON, in the callback the request named or bare. */
export function rtb56Json(body: string, callback: string, provider: string): unknown {
  const jsonp = new RegExp(`^\\s*${callback}\\(([\\s\\S]*)\\)\\s*;?\\s*$`);
  try {
    return JSON.parse(jsonp.exec(body)?.[1] ?? body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/** An optional text field; anything but a string is a changed reply. */
export function rtb56Text(row: Record<string, unknown>, key: string, provider: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The entry of a `Service.ashx` reply for the whole number asked, and its
 * scans. A number the tracker does not know gets `success` 0 and its "No query
 * to track information" message.
 */
export function rtb56Entry(payload: unknown, number: string, provider: string): { item: Record<string, unknown>; rows: unknown[] } {
  if (!isRecord(payload)) throw new SchemaError(provider, `${provider} returned an invalid reply`);
  if (payload.success === 0) {
    const message = `${rtb56Text(payload, 'enmessage', provider, 200)} ${rtb56Text(payload, 'cnmessage', provider, 200)}`;
    if (/No query to track information|未查询到轨迹信息/i.test(message)) throw new NotFoundError(provider, `${provider} has no parcel under this number`);
    // The answer to a lookup whose key does not match its request.
    if (/Parameter error|参数错误/i.test(message)) throw new SchemaError(provider, `${provider} refused the lookup request`);
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  if (payload.success !== 1 || !Array.isArray(payload.data)) throw new SchemaError(provider, `${provider} returned an invalid reply`);
  const bound = payload.data.filter((item: unknown) => isRecord(item) && typeof item.server_hawbcode === 'string'
    && normalizeTrackingNumber(item.server_hawbcode) === number) as Record<string, unknown>[];
  if (bound.length !== 1) throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  const item = bound[0]!;
  const rows = item.details;
  if (!Array.isArray(rows)) throw new SchemaError(provider, `${provider} returned a parcel with invalid scans`);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  return { item, rows };
}

/** A scan's wall clock to the second, and its instant when the scan states a valid offset. */
export function rtb56Clock(row: Record<string, unknown>, provider: string): { local: string; instant?: { iso: string; timestamp: number } } {
  const match = CLOCK.exec(rtb56Text(row, 'track_occur_date', provider, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  const offset = rtb56Text(row, 'gmt_offset', provider, 16);
  const instant = OFFSET.test(offset) ? explicitOffsetTime(`${local}${offset}`) : null;
  return instant ? { local, instant } : { local };
}

/** A scan's wording without whoever took a delivered parcel, and its place without postcodes. */
export function rtb56Wording(row: Record<string, unknown>, provider: string): { description: string; location: string } {
  const wording = rtb56Text(row, 'track_description_en', provider) || rtb56Text(row, 'track_description', provider);
  const description = clean(/^delivered\b/i.test(wording) ? wording.replace(RECEIVER, '') : wording, 300);
  const location = clean(rtb56Text(row, 'track_location', provider, 120).replace(POSTCODE_RUN, '$1'), 120).replace(/^[\s,;:]+|[\s,;:]+$/g, '');
  // A placeholder such as "--" names no place.
  return { description, location: /[\p{L}\p{N}]/u.test(location) ? location : '' };
}

/**
 * A parcel's scans, newest first. With `offsets`, a scan whose place states
 * its offset gets its instant; any other scan keeps its wall clock. Some
 * tenants state China's offset for scans at the destination too, so a tenant
 * whose offsets were not seen to follow the scan's place keeps wall clocks.
 * With `codes`, a scan keeps its `track_code`, which the stage is asked with,
 * and a row without a code repeating a coded scan's Chinese wording at its
 * clock and place is that scan relayed.
 * The tracker orders the scans by their wall clocks, whatever their offsets;
 * when every scan has an instant they are ordered by it, equal ones in the
 * tracker's order. A row without wording says nothing, and a repeated one is
 * read once.
 */
export function rtb56Scans(rows: unknown[], provider: string, stage: (wording: string, code: string) => ClassifiedWording | null,
  { offsets, codes = false }: { offsets: boolean; codes?: boolean }): CarrierEvent[] {
  const read = rows.flatMap((row) => {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    const clock = rtb56Clock(row, provider);
    const instant = offsets ? clock.instant : undefined;
    const { description, location } = rtb56Wording(row, provider);
    if (!description) return [];
    const code = codes ? rtb56Text(row, 'track_code', provider, 16).toUpperCase() : '';
    if (code && !CODE.test(code)) throw new SchemaError(provider, `${provider} returned an invalid scan code`);
    const twin = JSON.stringify([instant?.iso ?? clock.local, location, rtb56Text(row, 'track_description', provider)]);
    return [{ local: clock.local, instant, description, location, code, twin }];
  });
  const coded = new Set(read.filter((scan) => scan.code).map((scan) => scan.twin));
  const seen = new Set<string>();
  const scans: { event: CarrierEvent; at: number | null; index: number }[] = [];
  for (const { local, instant, description, location, code, twin } of read) {
    if (!code && coded.has(twin)) continue;
    const key = JSON.stringify([instant?.iso ?? local, location, description, code]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = stage(description, code);
    scans.push({ at: instant?.timestamp ?? null, index: scans.length, event: {
      // A scan without its place's offset keeps its wall clock.
      ...(instant ? { time: instant.iso } : { local_time: local }),
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) throw new NoHistoryError(provider);
  if (scans.every((scan) => scan.at !== null)) scans.sort((left, right) => right.at! - left.at! || left.index - right.index);
  return scans.map((scan) => scan.event);
}
