import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { firstOccurrence } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { FIRST_LINE_CHINA_ZONE, firstLineInChina } from './clock.js';
import { firstLineStage } from './status.js';

export const PROVIDER = 'FIRST LINE';
// A long history is a few kilobytes; the tracking page is about twelve.
export const FIRST_LINE_MAX_BYTES = 256 * 1024;
// 1ST and eleven digits, as the group's forwarders print their waybills.
const NUMBER = /^1ST\d{11}$/;
// The lookup's address, as the tracking page's script holds it, signed for the page's session.
const LOOKUP = /query\.php\?meter=track_query&nonce=[A-Z0-9]{8,64}&timestamp=\d{9,12}&sign=[0-9a-f]{40}(?=['&])/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /acw_sc__v2|aliyun_waf|_____tmd_____|<title>\s*(?:Just a moment|Attention Required|Access Denied|滑动验证|验证码)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// The answer to a lookup without the page's session cookies, or with a spent signature.
const SESSION_REFUSED = /身份验证失败/;
const NOT_FOUND = '未找到此单号信息';
// A scan as the tracker lists it: its wall clock, its place (possibly empty) and its wording, six spaces apart.
const ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:&nbsp;){6}(.*?)(?:&nbsp;){6}(.*)$/s;
// The shipper's order data, which names no place; 17TRACK and ParcelsApp date it on Beijing's clock.
const ORDER_DATA = /^forecast has been received$/i;
const MAX_SHIPMENTS = 5;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A 1ST waybill number; anything else is a number FIRST LINE's tracker is not asked for. */
export function normalizeFirstLineNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FIRST LINE waybill numbers are 1ST and eleven digits');
  return number;
}

/** The signed lookup address the tracking page holds for its session. */
export function parseFirstLinePage(html: string): string {
  const lookup = LOOKUP.exec(html)?.[0];
  if (lookup) return lookup;
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FIRST LINE answered its tracking page with a browser check');
  throw new SchemaError(PROVIDER, 'FIRST LINE’s tracking page holds no lookup address');
}

/** A place as the tracker writes it, without a trailing postcode. */
function placeOf(location: string): string {
  return location.replace(/\s+\d{4,6}(?:-\d{4})?$/, '').trim();
}

function stageOf(description: string): { stage: Stage; source: string } | undefined {
  const mapped = firstLineStage(null, normalizeStatusWording(description));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, source: worded.source };
}

function projectRow(row: string, readAt: number): { key: string; event: CarrierEvent } | null {
  const match = ROW.exec(row.trim());
  if (!match) throw new SchemaError(PROVIDER, 'FIRST LINE returned an invalid scan');
  const local = `${match[1]}T${match[2]}`;
  // China's clock is the latest of the clocks the rows can be on, so a past scan is never read as a future one.
  const latest = firstOccurrence(DateTime.fromISO(local, { zone: FIRST_LINE_CHINA_ZONE }));
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!latest?.isValid || latest.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'FIRST LINE returned an invalid scan time');
  // A row dated after the read on every clock it could be on is not a scan yet.
  if (latest.toMillis() > readAt) return null;
  const description = textFromHtml(match[4]);
  if (!description) return null;
  const location = placeOf(textFromHtml(match[3], 200));
  const staged = stageOf(description);
  // A row in China or Hong Kong is on Beijing's clock; any other keeps its wall clock.
  const inChina = location ? firstLineInChina(location) : ORDER_DATA.test(description);
  const event: CarrierEvent = {
    ...(inChina ? { time: latest.toISO({ suppressMilliseconds: true }) } : { local_time: local }),
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, location, description]), event };
}

/** The one shipment block of a reply that is for the number asked. */
function shipmentFor(html: string, number: string): string {
  const blocks = html.split('<div class="track_list">').slice(1);
  if (!blocks.length || blocks.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'FIRST LINE returned no shipment list');
  const matching = blocks.filter((block) => {
    const cells = /<div class="track_list_thead"[^>]*>.*?<tr>(.*?)<\/tr>/s.exec(block)?.[1]?.split(/<\/td>/) ?? [];
    return normalizeTrackingNumber(textFromHtml(cells[1] ?? '', 64)) === number;
  });
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'FIRST LINE did not answer for the number once');
  return matching[0]!;
}

/**
 * The reply of `query.php?meter=track_query`, the lookup FIRST LINE's
 * tracking page makes: `ok{FGF}` and an HTML list with one block per number
 * asked, a header row with the number and its newest scan, then the scans,
 * newest first. An unknown number's block says so instead of listing scans.
 * Scan times are each facility's own wall clock without an offset: rows in
 * China and Hong Kong, and the shipper's order data, are dated on Beijing's
 * clock, and the destination's rows stay wall clocks. The header's system
 * number and the places' postcodes are not read.
 */
export function parseFirstLine(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeFirstLineNumber(raw);
  const split = body.indexOf('{FGF}');
  const head = split < 0 ? '' : body.slice(0, split).trim();
  const html = body.slice(split + 5);
  if (head === 'error') {
    // A refused session says nothing about the shipment.
    if (SESSION_REFUSED.test(html)) throw new IndeterminateError(PROVIDER, 'FIRST LINE refused the lookup’s session', { reason: 'session_rejected' });
    throw new IndeterminateError(PROVIDER, 'FIRST LINE did not complete the lookup');
  }
  if (head !== 'ok') {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FIRST LINE answered with a browser check');
    throw new SchemaError(PROVIDER, 'FIRST LINE returned an unexpected reply');
  }
  const shipment = shipmentFor(html, number);
  const message = /<div class="track_result_errmsg"[^>]*>(.*?)<\/div>/s.exec(shipment);
  if (message) {
    // Another of the 1ST group's forwarders can hold a 1ST waybill this tracker does not know.
    if (textFromHtml(message[1]) === NOT_FOUND) {
      throw new IndeterminateError(PROVIDER, 'FIRST LINE does not know the waybill, which another 1ST forwarder may hold', { reason: 'portal_not_found' });
    }
    throw new IndeterminateError(PROVIDER, 'FIRST LINE did not list the waybill’s scans');
  }
  const rows = [...shipment.matchAll(/<li>(.*?)<\/li>/gs)].map((row) => row[1]!);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'FIRST LINE returned an oversized history');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'FIRST LINE listed the waybill without scans or a message');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = projectRow(row, readAt);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'FIRST LINE has no scans for the waybill yet');

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
