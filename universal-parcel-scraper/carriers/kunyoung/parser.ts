import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { kunyoungStage } from './status.js';

export const PROVIDER = 'Kunyoung Express';
// A parcel's history is a couple of kilobytes.
export const KUNYOUNG_MAX_BYTES = 256 * 1024;
const ZONE = 'Asia/Seoul';
const NUMBER = /^\d{10}$/;
// A scan's wall clock to the second, perhaps with a fraction of a second after it.
const CLOCK = /^(\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,9})?$/;
// The page draws a scan by this one-letter code.
const CODE = /^[A-Z]$/;
// The code of a scan whose description the page writes as its details, then its status line.
const DETAILED = 'N';
// The page's mark for a scan without a site.
const NO_SITE = '-';
// A site that names a person: a masked name or a driver (기사).
const PERSON = /[*＊]|기사/;
// A run of nine or more digits, with hyphens, dots, spaces or brackets between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

type Row = Record<string, unknown>;

/** A Kunyoung Express waybill: ten digits, as its tracking field asks for them, without hyphens. */
export function normalizeKunyoungNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Kunyoung Express waybills are ten digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Row, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Kunyoung Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's clock: every scan is at a branch or terminal in Korea, which keeps UTC+9 all year. */
function scanClock(row: Row): string {
  const clock = CLOCK.exec(text(row, 'writeDate', 40))?.[1] ?? '';
  const wall = firstOccurrence(DateTime.fromFormat(clock, 'yyyy-MM-dd HH:mm:ss', { zone: ZONE }));
  // Luxon rolls impossible days over; only a clock that reads back unchanged is kept.
  if (!clock || !wall.isValid || wall.toFormat('yyyy-MM-dd HH:mm:ss') !== clock) invalid('Kunyoung Express returned an invalid scan time');
  return wall.toUTC().toISO({ suppressMilliseconds: true });
}

/** A scan's site, a branch or terminal, without phone numbers; a site that names a person is dropped. */
function site(value: string): string {
  const name = clean(value.replace(PHONE, ' ').replace(/\(\s*\)/g, ' '), 80);
  return !name || name === NO_SITE || PERSON.test(name) ? '' : name;
}

/**
 * The reply of `mj.kunyoung.com/webinvoicetracehistory/selectListInvoiceTraceHistory.do`,
 * the lookup Kunyoung's tracking page makes. `msgCode` `0` with no rows is the
 * page's answer for a waybill it has not registered; another `msgCode` is an
 * error the page shows instead of a result. Rows are the scans, newest first,
 * each with its clock, site, one-letter code and status line. The reply does
 * not repeat the number: the service matches only the whole number asked. The
 * driver's name and phone number, the delivery photo and the staff and vehicle
 * fields are never read.
 */
export function parseKunyoung(payload: unknown, raw: string): CarrierResult {
  normalizeKunyoungNumber(raw);
  if (!isRecord(payload) || typeof payload.msgCode !== 'string') invalid('Kunyoung Express returned an invalid envelope');
  if (payload.msgCode !== '0') throw new IndeterminateError(PROVIDER, 'Kunyoung Express answered with an error');
  const rows = payload.rows;
  if (!Array.isArray(rows)) invalid('Kunyoung Express returned an answer without its scans');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_ROWS) invalid('Kunyoung Express returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) invalid('Kunyoung Express returned an invalid scan');
    const code = text(row, 'goodsTypeSP', 8);
    if (code && !CODE.test(code)) invalid('Kunyoung Express returned an invalid scan code');
    const line = text(row, 'goodsContent');
    // The page writes such a scan as its details followed by its status line.
    const description = code === DETAILED ? clean(`${text(row, 'deliveryContent')} ${line}`, 300) : line;
    if (!description) invalid('Kunyoung Express returned a scan without its status');
    const time = scanClock(row);
    const location = site(text(row, 'shopName', 120));
    const key = JSON.stringify([time, code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = kunyoungStage(code || null, description);
    events.push({
      time,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  // Newest first; the reply lists the scans that way.
  const newestFirst = events[0]!.time! < events.at(-1)!.time! ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: scanned!.time! } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
