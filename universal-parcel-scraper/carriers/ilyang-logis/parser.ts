import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ilyangStage } from './status.js';

export const PROVIDER = 'Ilyang Logis';
export const CARRIER = 'ilyang-logis';
// A reply is a few kilobytes.
export const ILYANG_MAX_BYTES = 256 * 1024;
const ZONE = 'Asia/Seoul';
// Ten digits on current waybills, nine on older ones.
const NUMBER = /^\d{9,10}$/;
const DATE = /^\d{8}$/;
// Hours and minutes, sometimes with seconds, as the page's script reads them.
const CLOCK = /^\d{4}(?:\d{2})?$/;
const CODE = /^\d{1,4}$/;
// The not-delivered checkpoint, whose remark gives the reason or the carrier it went to.
const NOT_DELIVERED = '88';
// The tracker's answer for a number it holds no parcel for: "an item not
// taken in; check the waybill number and try again".
const NOT_TAKEN_IN = /^미\s*접수된\s*물품/;
// A hand-over's remark: the delivering carrier and its waybill, as "CJ 1234-5678-9012".
const CJ_HANDOVER = /^CJ\s*(\d(?:-?\d){9,11})$/;
// A run of nine or more digits, with hyphens, dots, spaces or brackets between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

type Row = Record<string, unknown>;

/**
 * An Ilyang Logis waybill: nine or ten digits, the last the rest modulo 7,
 * without the hyphens or spaces it may be written with. Anything else is not
 * a number Ilyang Logis issues.
 */
export function normalizeIlyangNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || !hasMod7CheckDigit(number)) {
    throw new InvalidInputError(PROVIDER, 'Ilyang Logis waybills are nine or ten digits, the last the rest modulo 7');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Row, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Ilyang Logis returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's clock: every scan is at an Ilyang Logis branch, office or terminal in Korea, which keeps UTC+9 all year. */
function scanClock(row: Row): string {
  const date = text(row, 'actDate', 16);
  const clock = text(row, 'actTime', 16);
  const wall = `${date}${clock.padEnd(6, '0')}`;
  const time = firstOccurrence(DateTime.fromFormat(wall, 'yyyyMMddHHmmss', { zone: ZONE }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!DATE.test(date) || !CLOCK.test(clock) || !time.isValid || time.toFormat('yyyyMMddHHmmss') !== wall) {
    throw new SchemaError(PROVIDER, 'Ilyang Logis returned an invalid scan time');
  }
  return time.toUTC().toISO({ suppressMilliseconds: true });
}

/** The CJ Logistics waybill a hand-over's remark names, without its hyphens. */
export function ilyangHandover(remark: string): string | null {
  const digits = CJ_HANDOVER.exec(clean(remark, 40))?.[1]?.replace(/-/g, '');
  return digits && (digits.length === 10 || digits.length === 12) ? digits : null;
}

/**
 * A not-delivered scan's wording: its label, then its remark, as
 * "미배달(기타): 배송 기사 결원". A remark loses phone numbers; a hand-over's
 * names the delivering carrier's waybill, which stays.
 */
export function ilyangWording(label: string, remark: string): string {
  const kept = ilyangHandover(remark) ? clean(remark, 40) : clean(remark.replace(PHONE, ' '), 120).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  return kept ? `${label}: ${kept}` : label;
}

interface Scan { event: CarrierEvent; handover: string | null }

function projectScan(row: Row): Scan {
  const raw = row.chkPointCd;
  if (raw !== null && raw !== undefined && typeof raw !== 'string' && typeof raw !== 'number') {
    throw new SchemaError(PROVIDER, 'Ilyang Logis returned an invalid checkpoint code');
  }
  const code = raw === null || raw === undefined ? '' : clean(String(raw), 8);
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Ilyang Logis returned an invalid checkpoint code');
  // The page shows the label with the reason a parcel was not delivered; the summary label lacks it.
  const label = text(row, 'chkPointDesc2', 40) || text(row, 'chkPointDesc', 40);
  if (!label) throw new SchemaError(PROVIDER, 'Ilyang Logis returned a scan without its checkpoint');
  const remark = code === NOT_DELIVERED ? text(row, 'exptDesc', 200) : '';
  const description = ilyangWording(label, remark);
  const time = scanClock(row);
  const location = text(row, 'stationName', 60);
  const staged = ilyangStage(code || null, label);
  return {
    event: {
      time,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    handover: remark ? ilyangHandover(remark) : null,
  };
}

/**
 * The reply of `POST /tracking/trackingByDeliNo.do`, the lookup Ilyang Logis'
 * tracking result page makes. `res` is true with the parcel as the one entry of
 * `rows`, its checkpoints oldest first in `tracking`. A number the tracker
 * holds no parcel for comes back without checkpoints and with its "not taken
 * in" notice. The parcel must name the number asked. The sender's and
 * recipient's names, addresses and phone numbers, the goods, the order number,
 * the person who took the parcel, the staff and the branches' phone numbers are
 * never read.
 */
export function parseIlyang(payload: unknown, raw: string): CarrierResult {
  const number = normalizeIlyangNumber(raw);
  if (!isRecord(payload) || typeof payload.res !== 'boolean') throw new SchemaError(PROVIDER, 'Ilyang Logis returned an invalid envelope');
  // The page shows the message of a refused lookup, seen for input that is not a waybill.
  if (!payload.res) throw new IndeterminateError(PROVIDER, 'Ilyang Logis did not look the number up');
  const head = payload.result;
  if (!isRecord(head) || head.returnCode !== 'R0') throw new IndeterminateError(PROVIDER, 'Ilyang Logis did not complete the lookup');
  const rows = payload.rows;
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) throw new SchemaError(PROVIDER, 'Ilyang Logis returned an unexpected parcel list');
  const parcel = rows[0];
  const echoed = text(parcel, 'blNum', 32);
  if (!echoed) throw new SchemaError(PROVIDER, 'Ilyang Logis returned a parcel without its waybill');
  if (normalizeTrackingNumber(echoed) !== number) throw new IndeterminateError(PROVIDER, 'Ilyang Logis answered for another parcel');
  if (text(parcel, 'ilyErrorType', 40)) throw new IndeterminateError(PROVIDER, 'Ilyang Logis reported an error for the lookup');
  const scans = parcel.tracking ?? [];
  if (!Array.isArray(scans)) throw new SchemaError(PROVIDER, 'Ilyang Logis returned a parcel with invalid checkpoints');
  if (!scans.length) {
    if (NOT_TAKEN_IN.test(text(parcel, 'lastTrackingDesc', 200))) throw new NotFoundError(PROVIDER);
    throw new NoHistoryError(PROVIDER);
  }
  if (scans.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Ilyang Logis returned an oversized history');

  const seen = new Set<string>();
  const projected: Scan[] = [];
  for (const row of scans) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Ilyang Logis returned an invalid checkpoint');
    const scan = projectScan(row);
    const { time, provider_code: code, description, location } = scan.event;
    const key = JSON.stringify([time, code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push(scan);
  }
  // Newest first; the reply lists the checkpoints oldest first.
  if (listsNewestFirst(projected.map(({ event }) => event)) === false) projected.reverse();
  const newestFirst = projected.sort((left, right) => right.event.time!.localeCompare(left.event.time!));
  const events = newestFirst.map((scan) => scan.event);

  const newest = events[0]!;
  // The sending office can record taking the parcel in after it has moved on,
  // which does not take it back.
  const current = events.find((event, index) => event.stage
    && !(event.stage === 'accepted' && events.slice(index + 1).some((older) => older.stage && older.stage !== 'accepted')));
  const stage = current?.stage as Stage | undefined;
  const handover = newestFirst.find((scan) => scan.handover)?.handover;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: (current ?? newest).description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    ...(handover ? { delivery_carrier: 'cj-logistics', delivery_tracking_number: handover } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
