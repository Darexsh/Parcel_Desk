import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { KIT_ARRIVED, kitStage } from './status.js';

export const PROVIDER = 'TK KIT';
// The tracking page is about 600 kB.
export const KIT_PAGE_MAX_BYTES = 2 * 1024 * 1024;
// A consignment's reply is a few kilobytes.
export const KIT_MAX_BYTES = 256 * 1024;
const MAX_ROWS = 100;
// The tracker's estimates, which its page shows as the arrival date and leaves out of the steps.
const ESTIMATES = new Set(['F1', 'F2']);
// The page's own labels, which it shows in place of the reply's text.
const LABELS: Readonly<Record<string, string>> = {
  '00': 'Новый заказ',
  '01': 'Груз принят на терминале',
  '02': 'Груз отправлен',
  '03': 'Груз прибыл на терминал',
  F3: 'Груз принят на доставку',
  '04': 'Груз выдан',
  ZZ: 'Отменен',
};
// Where a step happens: acceptance and dispatch at the sending terminal, the
// arrival and the handover to the driver at the consignee's one.
const AT_ORIGIN = new Set(['01', '02']);
const AT_DESTINATION = new Set([KIT_ARRIVED, 'F3']);
const ISSUED = '04';
// A forwarding receipt as the reply names it: six Cyrillic letters and the ten digits.
const RECEIPT = /^(?:[А-ЯЁ]{6})?(\d{10})$/u;
const CODE = /^[0-9A-Z]{1,8}$/;
const DATE = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const WEIGHT = /^\d{1,6}(?:[.,]\d{1,3})?$/;
const TOKEN = /^[A-Za-z0-9_\-+/=]{16,256}$/;
const PARAM = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/;
// Bot checks a firewall could put in place of the page or the reply. The
// tracking page itself loads a captcha for its feedback form.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|ddos-guard|__qrator|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i;

/**
 * The ten digits of a forwarding receipt, which the tracker finds alone. The
 * receipt's six Cyrillic letters never reach an adapter, and anything else is
 * not a number KIT issues.
 */
export function normalizeKitNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'TK KIT consignments are tracked by the ten digits of their forwarding receipt');
  return number;
}

/** Whether a page is the tracker's own, whatever else it loads. */
export function isKitTrackingPage(html: string): boolean {
  return /id=["']?trackload-form\b/.test(html);
}

/** A bot check in place of the tracker's page or reply. */
export function isKitChallenge(html: string): boolean {
  return !isKitTrackingPage(html) && CHALLENGE.test(html.slice(0, 64_000));
}

/** The form field and the token the tracker's lookup sends back with the page's cookie, as Yii writes them into the page. */
export function kitCsrf(html: string): { param: string; token: string } | null {
  const $ = load(html);
  const param = $('meta[name="csrf-param"]').attr('content')?.trim() ?? '';
  const token = $('meta[name="csrf-token"]').attr('content')?.trim()
    || $('#trackload-form input[type="hidden"]').filter((_, input) => $(input).attr('name') === param).attr('value')?.trim() || '';
  return PARAM.test(param) && TOKEN.test(token) ? { param, token } : null;
}

/** The tracker's own answer for a number it does not know: HTTP 404 with "Статусы null", for the statuses it found none of. */
export function isKitNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.status === 404 && typeof payload.message === 'string' && payload.message.trim() === 'Статусы null';
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TK KIT returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional object; anything else is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `TK KIT returned an invalid ${key}`);
  return value;
}

/**
 * A step's clock: a day as DD-MM-YYYY and a time to the second. The reply
 * names neither the zone nor the terminal, and Russia spans eleven zones, so it
 * stays a wall clock.
 */
function clock(row: Record<string, unknown>): string {
  const date = DATE.exec(text(row, 'date', 16));
  const time = TIME.exec(text(row, 'time', 16));
  const pad = (part: string) => part.padStart(2, '0');
  const local = date && time ? `${date[3]}-${pad(date[2]!)}-${pad(date[1]!)}T${pad(time[1]!)}:${time[2]}:${time[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'TK KIT returned an invalid step time');
  }
  return local;
}

/** The steps, as a list or as an object of them, which the page reads alike. */
function rows(value: unknown): unknown[] {
  const list = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : null;
  if (!list) throw new SchemaError(PROVIDER, 'TK KIT returned a consignment without its steps');
  if (list.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TK KIT returned an oversized history');
  return list;
}

/** The number a reply names, upper-cased: the number sent, or a forwarding receipt. */
function named(value: string): string | undefined {
  return RECEIPT.exec(value.replace(/\s+/g, '').toUpperCase())?.[1];
}

/** The gross weight in kilograms the page shows, when the reply gives a plain one. */
function weightKg(goods: Record<string, unknown>): number | undefined {
  const raw = text(goods, 'Brgew', 16);
  const weight = WEIGHT.test(raw) ? Number(raw.replace(',', '.')) : 0;
  return weight > 0 ? weight : undefined;
}

/**
 * The reply of the tracker's lookup for one number. It repeats the number
 * sent as `track_code` and names the consignment's forwarding receipt, which
 * must end in that number, and lists its steps oldest first.
 */
export function parseKit(payload: unknown, raw: string): CarrierResult {
  const number = normalizeKitNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'TK KIT returned an invalid reply');
  // The page lets the visitor choose among several consignments; none of them is the number's own.
  if (payload.multiple === true) throw new IndeterminateError(PROVIDER, 'TK KIT found several consignments for the number');
  if (typeof payload.track_code !== 'string') throw new SchemaError(PROVIDER, 'TK KIT returned a consignment without its number');
  const details = record(payload, 'deliveryInfo');
  const receipt = text(record(details, 'ESubi'), 'Xblnr', 64);
  const receiptNumber = receipt ? named(receipt) : undefined;
  if (named(payload.track_code) !== number || (receiptNumber !== undefined && receiptNumber !== number)) {
    throw new IndeterminateError(PROVIDER, 'TK KIT answered for another consignment');
  }

  const deliveryType = text(payload, 'deliveryType', 32);
  const stepCount = payload.stepCount;
  if (stepCount !== null && stepCount !== undefined && !Number.isInteger(stepCount)) {
    throw new SchemaError(PROVIDER, 'TK KIT returned an invalid stepCount');
  }
  // A consignment goes to an address or a pickup point when the page draws
  // its six-step route or a delivery is ordered; otherwise it is collected
  // at the consignee's terminal.
  const atTerminal = !['delivery', 'PVZ'].includes(deliveryType) && stepCount !== 6 && payload.isDeliveryRequest !== true;
  const origin = text(record(payload, 'cityOut'), 'name', 120);
  const destination = text(record(payload, 'cityIn'), 'name', 120);

  const seen = new Set<string>();
  const scans: { order: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows(payload.status).entries()) {
    if (!isRecord(row) || typeof row.status_code !== 'string') throw new SchemaError(PROVIDER, 'TK KIT returned an invalid step');
    const code = clean(row.status_code, 16).toUpperCase();
    if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'TK KIT returned an invalid step code');
    if (ESTIMATES.has(code)) continue;
    const local = clock(row);
    const description = text(row, 'text') || LABELS[code] || text(row, 'textMobile');
    if (!description) throw new SchemaError(PROVIDER, 'TK KIT returned a step without wording');
    const location = AT_ORIGIN.has(code) ? origin
      : AT_DESTINATION.has(code) || (code === ISSUED && atTerminal) ? destination : '';
    const staged = kitStage(code, description, atTerminal);
    const key = JSON.stringify([local, code, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ order: local, index, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; steps with the same clock keep the reply's order, oldest first.
  scans.sort((left, right) => right.order.localeCompare(left.order) || right.index - left.index);
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const weight = weightKg(record(details, 'EGinf'));
  // The page names the terminal in the consignee's city by its address; a
  // consignment collected there waits for the consignee at that terminal.
  const terminal = atTerminal ? text(payload, 'address') : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: scans[0]!.order,
    expected_delivery: null,
    ...(terminal ? { pickup_point: terminal } : {}),
    ...(weight !== undefined ? { weight_kg: weight } : {}),
    events,
  };
}
