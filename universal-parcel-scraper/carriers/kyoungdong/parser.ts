import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { kyoungdongStage } from './status.js';

export const PROVIDER = 'Kyungdong Express';
export const CARRIER = 'kyoungdong';
// A reply is a few kilobytes.
export const KYOUNGDONG_MAX_BYTES = 256 * 1024;
const ZONE = 'Asia/Seoul';
const NUMBER = /^\d{13}$/;
// A scan's wall clock to the second, some with a fraction of a second after it.
const CLOCK = /^(\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{1,9})?$/;
const CODE = /^\d{1,6}$/;
// A site that names a person: a masked name (최**) or a role such as (배송기사), the driver.
const PERSON = /[*＊(（]|기사/;
// A branch carries its number after its area's name; terminals and hubs say what they are.
const BRANCH = /\d|(?:터미널|허브|센터)$/;
// Scans whose site can be the driver who delivers.
const DELIVERY_LEG: readonly Stage[] = ['out_for_delivery', 'failed_attempt', 'delivered'];
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

type Row = Record<string, unknown>;

/** A Kyungdong Express waybill as its tracker looks it up: thirteen digits, without the hyphens a label prints. */
export function normalizeKyoungdongNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Kyungdong Express waybills are thirteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Row, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Kyungdong Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's clock: every scan is at a branch or terminal in Korea, which keeps UTC+9 all year. */
function scanClock(row: Row): string {
  const clock = CLOCK.exec(text(row, 'scanDt', 40))?.[1] ?? '';
  const wall = firstOccurrence(DateTime.fromFormat(clock, 'yyyy-MM-dd HH:mm:ss', { zone: ZONE }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!clock || !wall.isValid || wall.toFormat('yyyy-MM-dd HH:mm:ss') !== clock) throw new SchemaError(PROVIDER, 'Kyungdong Express returned an invalid scan time');
  return wall.toUTC().toISO({ suppressMilliseconds: true });
}

/**
 * A scan's site, when it is a branch, terminal or hub. A delivery-leg scan
 * keeps only a branch the summary names, since it can name the driver, and a
 * line-haul load can name its driver too.
 */
export function kyoungdongSite(value: string, branches: ReadonlySet<string>, stage?: Stage): string {
  const name = clean(value, 120);
  if (!name || PERSON.test(name)) return '';
  if (branches.has(name)) return name;
  return stage && DELIVERY_LEG.includes(stage) ? '' : BRANCH.test(name) ? name : '';
}

/**
 * The reply of `/service/delivery/new/ajax_basic.do?barcode=`, the lookup
 * Kyungdong's tracking page makes. `result` is `suc` with the parcel in `data`
 * and its scans oldest first, or `fail` without data, which the page words as a
 * wrong waybill or a failed lookup: an unknown number, a parcel older than four
 * months or a lookup that failed, so it proves no absence. The parcel must name
 * the number asked. Senders, recipients, addresses, phone numbers, goods and
 * the delivery's signature files are never read.
 */
export function parseKyoungdong(payload: unknown, raw: string): CarrierResult {
  const number = normalizeKyoungdongNumber(raw);
  if (!isRecord(payload) || typeof payload.result !== 'string') throw new SchemaError(PROVIDER, 'Kyungdong Express returned an invalid envelope');
  if (payload.result === 'fail') {
    if (payload.data !== undefined && payload.data !== null) throw new SchemaError(PROVIDER, 'Kyungdong Express returned an unexpected failure');
    throw new IndeterminateError(PROVIDER, 'Kyungdong Express has no parcel for this number or failed to look it up', { reason: 'portal_not_found' });
  }
  const data = payload.data;
  if (payload.result !== 'suc' || !isRecord(data)) throw new SchemaError(PROVIDER, 'Kyungdong Express returned an unexpected answer');
  const echoed = cleanScalar(data.prodCode, 64);
  if (!echoed) throw new SchemaError(PROVIDER, 'Kyungdong Express returned a parcel without its waybill');
  if (normalizeTrackingNumber(echoed) !== number) throw new IndeterminateError(PROVIDER, 'Kyungdong Express answered for another parcel');
  const rows = data.scanList ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Kyungdong Express returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Kyungdong Express returned an oversized history');
  const branches = new Set([text(data, 'branSndnNm'), text(data, 'branArvlNm')].filter((name) => name && !PERSON.test(name)));

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Kyungdong Express returned an invalid scan');
    const label = text(row, 'scanTypeNm', 40);
    if (!label) throw new SchemaError(PROVIDER, 'Kyungdong Express returned a scan without its type');
    const code = cleanScalar(row.scanType, 16);
    if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Kyungdong Express returned an invalid scan type code');
    const time = scanClock(row);
    const staged = kyoungdongStage(code || null, label);
    const location = kyoungdongSite(text(row, 'strtPointNm'), branches, staged?.stage);
    const key = JSON.stringify([time, code, label, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      time,
      ...(location ? { location } : {}),
      description: label,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the reply lists the scans oldest first.
  const newestFirst = events[0]!.time! <= events.at(-1)!.time! ? events.reverse() : events;

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
