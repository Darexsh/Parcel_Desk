import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { emsVietnamStage } from './status.js';

export const PROVIDER = 'EMS Vietnam';
// A long history is under twenty kilobytes.
export const EMS_VIETNAM_MAX_BYTES = 512 * 1024;
const ZONE = 'Asia/Ho_Chi_Minh';
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
// The delivery table's clock on the international exchange's rows: "1/12/2026 9:56:00 AM".
const DATED_CLOCK = /^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const LISTS = ['List_TBL_DINH_VI', 'List_TBL_DELIVERY', 'List_TBL_DELIVERY_lIST'] as const;

/** A UPU S10 number, in upper case; anything else is not one EMS Vietnam issues. */
export function normalizeEmsVietnamNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!isValidS10TrackingNumber(number)) throw new InvalidInputError(PROVIDER, 'EMS Vietnam numbers are UPU S10 numbers');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `EMS Vietnam returned an invalid ${key}`);
  return clean(value.normalize('NFC'), maxLength);
}

// The UPU event code some scans start with: "EMI - Phát thành công (Delivered)".
const CODE = /^([A-Z]{3})\s+-\s+/;
// The office that scanned, after the wording: "(100000: Office - Province)".
const OFFICE = /\(\s*\d{6}\s*:/;
// The office in the older layout's position field: "100000 - Office".
const LEGACY_OFFICE = /^\d{6}\s*-\s*(.+)$/;
// The customer-service contact the acceptance scan names.
const HELPLINE = /\(\s*Đầu mối CSKH[^)]*\)?/gi;
// The postman the older layout names after the handover: "Đã giao cho bưu tá: name SĐT: phone".
const POSTMAN = /(bưu tá(?: phát)?)\s*:[\s\S]*$/i;
// A receiver, a signer or a phone after its label: the rest of the wording goes.
const PERSON = /\s*[,;.\-–]?\s*(?:(?:người nhận|người ký|ký nhận|điện thoại|s?[đð]t)\s*:|s[đð]t\b)[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/** The text inside the bracket that opens at `start`, and where it ends. */
function bracketed(value: string, start: number): { inner: string; end: number } {
  let depth = 0;
  for (let index = start; index < value.length; index++) {
    if (value[index] === '(') depth++;
    if (value[index] === ')' && --depth === 0) return { inner: value.slice(start + 1, index), end: index + 1 };
  }
  return { inner: value.slice(start + 1), end: value.length };
}

/**
 * A scan's wording, code and office. The wording loses its code, the office
 * and what follows it (the customer-service line), a postman's name, a
 * receiver or signer and phone numbers.
 */
export function emsVietnamScanText(raw: string): { code: string; description: string; office: string } {
  const value = clean(raw.normalize('NFC'), 1000);
  const code = CODE.exec(value)?.[1] ?? '';
  let rest = code ? value.replace(CODE, '') : value;
  let office = '';
  const at = rest.search(OFFICE);
  if (at >= 0) {
    const { inner } = bracketed(rest, at);
    office = clean(inner.replace(/^\s*\d{6}\s*:/, ''), 120);
    rest = rest.slice(0, at);
  }
  const description = clean(rest.replace(HELPLINE, '').replace(POSTMAN, '$1').replace(PERSON, '').replace(PHONE, ''))
    .replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  return { code, description, office };
}

/** The wall clock of `NGAY` (day/month/year) and `GIO`, to the second. */
function wallClock(row: Record<string, unknown>): string {
  const date = DATE.exec(text(row, 'NGAY', 16));
  const clock = text(row, 'GIO', 16);
  const wall = date ? `${date[3]}-${date[2]}-${date[1]}T${clock}` : '';
  // Parsing in UTC checks the calendar digits only. Luxon rolls 24:00:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!date || !CLOCK.test(clock) || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'EMS Vietnam returned an invalid scan time');
  }
  return wall;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent; wall: string } {
  const scan = emsVietnamScanText(text(row, 'TRANG_THAI', 1000));
  if (!scan.description) throw new SchemaError(PROVIDER, 'EMS Vietnam returned a scan without wording');
  const legacy = LEGACY_OFFICE.exec(text(row, 'VI_TRI', 300));
  const office = scan.office || clean(legacy?.[1], 120);
  const wall = wallClock(row);
  // A scan at a Vietnamese post office, by its six-digit office code, is on
  // Vietnam's clock, which has no daylight saving. Anything else keeps its wall clock.
  const vietnamese = Boolean(scan.office || legacy);
  const clock = vietnamese
    ? { time: firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })! }
    : { local_time: wall };
  const staged = emsVietnamStage(scan.code, scan.description);
  const event: CarrierEvent = {
    ...clock,
    ...(office ? { location: office } : {}),
    description: scan.description,
    ...(scan.code ? { provider_code: scan.code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([wall, scan.code, scan.description, office]), event, wall };
}

function rows(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = payload[key] ?? [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `EMS Vietnam returned an invalid ${key}`);
  if (value.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'EMS Vietnam returned an oversized history');
  if (value.some((row) => !isRecord(row))) throw new SchemaError(PROVIDER, 'EMS Vietnam returned an invalid scan');
  return value as Record<string, unknown>[];
}

/** The two-letter code before the country's name: "VN - VIETNAM". */
function country(info: Record<string, unknown>): string | null {
  return /^([A-Z]{2})\s*-/.exec(text(info, 'Nuoc_Phat', 80))?.[1] ?? null;
}

/** `KHOI_LUONG`, in grams. */
function weightKg(info: Record<string, unknown>): number | null {
  const grams = cleanScalar(info.KHOI_LUONG, 16);
  return /^\d{1,7}(?:\.\d+)?$/.test(grams) && Number(grams) > 0 ? Number(grams) / 1000 : null;
}

/**
 * The reply of `TrackAndTraceItemCode` for one number. `Code` "00" carries the
 * record, whose `TBL_INFO.MAE1` must be the number asked; its scans are in
 * `List_TBL_DINH_VI`, oldest first. A number the tracker does not know comes
 * back with every field null, which the page reports as not found.
 */
export function parseEmsVietnam(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEmsVietnamNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'Code')) {
    // The service's own failure, as ASP.NET words it: a message and nothing else of the reply.
    if (isRecord(payload) && typeof payload.Message === 'string' && !Object.hasOwn(payload, 'TBL_INFO')
      && LISTS.every((key) => !Object.hasOwn(payload, key))) throw new IndeterminateError(PROVIDER, 'EMS Vietnam did not complete the lookup');
    throw new SchemaError(PROVIDER, 'EMS Vietnam returned an invalid envelope');
  }
  const code = payload.Code;
  if (code === null) {
    if (payload.TBL_INFO === null && LISTS.every((key) => payload[key] === null)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'EMS Vietnam returned a record without its result code');
  }
  if (typeof code !== 'string') throw new SchemaError(PROVIDER, 'EMS Vietnam returned an invalid result code');
  if (code !== '00') {
    // The former reply's explicit answer: "Không tìm thấy thông tin bưu gửi".
    if (code === '99' && /không tìm thấy/i.test(text(payload, 'Message', 200))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'EMS Vietnam did not complete the lookup');
  }

  const info = payload.TBL_INFO;
  if (info !== null && info !== undefined && !isRecord(info)) throw new SchemaError(PROVIDER, 'EMS Vietnam returned an invalid item record');
  const scans = rows(payload, 'List_TBL_DINH_VI');
  const deliveries = rows(payload, 'List_TBL_DELIVERY');
  // An international item whose Vietnamese record has expired keeps only the
  // delivery table, which names no item: nothing binds it to the number.
  if (!info || !Object.keys(info).length) throw new IndeterminateError(PROVIDER, 'EMS Vietnam answered without naming the item');
  if (typeof info.MAE1 !== 'string') throw new SchemaError(PROVIDER, 'EMS Vietnam returned an item without its number');
  if (clean(info.MAE1, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'EMS Vietnam answered for another item');

  const seen = new Set<string>();
  const projected: { event: CarrierEvent; wall: string }[] = [];
  for (const row of scans) {
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    projected.push(scan);
  }
  if (!projected.length) throw new NoHistoryError(PROVIDER);
  // Newest first. The page lists the scans oldest first, a later one of the
  // same second after the earlier; a reply listed newest first stays as it is.
  const oldestFirst = projected[0]!.wall <= projected.at(-1)!.wall;
  const events = (oldestFirst ? projected.reverse() : projected).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' && typeof current!.time === 'string' ? current!.time : null;
  // Domestic delivery rows give the time alone and repeat the history's delivery
  // scans. Rows dated in full are the international exchange's scans, which
  // the history does not hold.
  const abroad = deliveries.some((row) => DATED_CLOCK.test(text(row, 'GIO_TRANG_THAI', 32)));
  const destination = country(info);
  const weight = weightKg(info);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(abroad || events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
