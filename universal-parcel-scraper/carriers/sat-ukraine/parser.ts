import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { satStage } from './status.js';

export const PROVIDER = 'SAT';
// A long history is a few kilobytes.
export const SAT_MAX_BYTES = 256 * 1024;
// The tracker page's own field keeps nine digits, which it groups in threes.
const NUMBER = /^\d{9}$/;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
// The API's error code for a waybill it does not hold: "Накладна на вантаж по ідентифікатору не знайдена".
const NOT_FOUND = 'PD2';
// The current state of a written-off waybill, which the tracker page reports as "ННВ не знайдено".
const WRITTEN_OFF = 'Списан';
// The page's message when the waybill exists and the cargo has not reached a branch yet.
export const SAT_CREATED = 'ННВ створено. Очікуємо передачу вантажу до відділення SAT.';
const MAX_STATES = 300;
const MAX_EVENTS = 100;

/** A SAT waybill: nine digits, with or without the spaces the page groups them with. */
export function normalizeSatNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SAT waybills are nine digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`SAT returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** "06.01.2026" as a calendar day: the history gives days without a clock. */
function day(row: Record<string, unknown>): string {
  const match = DAY.exec(text(row, 'date', 16));
  return (match && calendarDay(Number(match[3]), Number(match[2]), Number(match[1]))) || invalid('SAT returned an invalid state date');
}

interface State {
  day: string;
  code: string;
  staged: ClassifiedWording | null;
  /** The SAT branch the state happened at: its name, its address and, when the name leaves it out, its town. */
  branch: string;
  event: CarrierEvent;
}

/**
 * One of the waybill's states: its day, its wording, its code (`statusRef`),
 * the town and, at a branch, the branch's name, address and coordinates.
 */
function state(row: Record<string, unknown>): State {
  const code = text(row, 'statusRef', 64);
  // The page leaves a state's wording blank when it has none; its code still says what happened.
  const description = text(row, 'status') || code;
  if (!description) invalid('SAT returned a state without wording');
  const town = text(row, 'town', 80);
  const name = text(row, 'rsp', 80);
  const address = text(row, 'address', 160);
  const point = name ? eventPoint(row.latitude, row.longitude) : null;
  const location = town || name;
  const staged = satStage(code, description);
  const branch = name ? [name, address, town && !name.includes(town) ? town : ''].filter(Boolean).join('\n') : '';
  const local_time = day(row);
  return { day: local_time, code, staged, branch, event: {
    local_time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    ...(point ? { point } : {}),
  } };
}

/**
 * The branch a parcel waits at, or was collected from: the one whose arrival
 * made it ready for pickup, when nothing but the delivery moved it since.
 */
function pickupPoint(newestFirst: readonly State[]): string {
  const staged = newestFirst.filter((entry) => entry.staged);
  const newest = staged[0];
  const ready = newest?.staged?.stage === 'delivered' ? staged.find((entry) => entry.staged?.stage !== 'delivered') : newest;
  return ready?.staged?.stage === 'ready_for_pickup' ? ready.branch : '';
}

/**
 * The reply of `GET /openws/hs/api/v2.0/tracking/json` on urm.sat.ua for one
 * waybill, read as the tracker page reads it. An unknown waybill is
 * `{"success":"false","error":{"code":"PD2",...}}`, a waybill whose cargo has
 * not reached a branch yet an empty `data`, and any other waybill one record
 * naming its number, with its current state and its states oldest first.
 * The waybill's summary is only in the reply to the page's key, which this
 * lookup does not send.
 */
export function parseSat(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSatNumber(raw);
  if (!isRecord(payload)) invalid('SAT returned an invalid envelope');
  const success = payload.success;
  if (success === false || success === 'false') {
    const error = isRecord(payload.error) ? payload.error : null;
    if (error && text(error, 'code', 16) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'SAT did not complete the lookup');
  }
  if (success !== true && success !== 'true') invalid('SAT returned an invalid envelope');
  const data = payload.data ?? [];
  if (!Array.isArray(data)) invalid('SAT returned an invalid list of waybills');
  // The tracker page's reading of a waybill that exists before the cargo reaches a branch.
  if (!data.length) {
    return { status: languageStageStatus('registered'), current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: SAT_CREATED, last_update: null, expected_delivery: null, summary_only: true, events: [] };
  }
  if (!data.every(isRecord)) invalid('SAT returned an invalid waybill');
  if (data.some((waybill) => typeof waybill.number !== 'string')) invalid('SAT returned a waybill without its number');
  const waybill = data.find((candidate) => normalizeTrackingNumber(clean(candidate.number, 32)) === number);
  if (!waybill) throw new IndeterminateError(PROVIDER, 'SAT answered for another waybill');

  const current = waybill.currentStatusDetailed === null || waybill.currentStatusDetailed === undefined ? null : waybill.currentStatusDetailed;
  if (current !== null && !isRecord(current)) invalid('SAT returned an invalid current state');
  const currentCode = current ? text(current, 'statusRef', 64) : '';
  if (currentCode === WRITTEN_OFF) throw new NotFoundError(PROVIDER, 'SAT reports the waybill as written off');

  const rows = waybill.states ?? [];
  if (!Array.isArray(rows)) invalid('SAT returned invalid states');
  if (rows.length > MAX_STATES) invalid('SAT returned an oversized history');
  const seen = new Set<string>();
  const states: State[] = [];
  for (const row of rows) {
    if (!isRecord(row)) invalid('SAT returned an invalid state');
    const entry = state(row);
    const key = JSON.stringify([entry.day, entry.code, entry.event.description, entry.event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    states.push(entry);
  }
  // Newest first. The reply lists the states oldest first, and states of one day keep its order.
  if (states.length > 1 && states[0]!.day <= states.at(-1)!.day) states.reverse();
  const newest = states[0];

  // The page reads the waybill's progress from its current state, which repeats the newest one.
  const summary = current ? { day: current.date ? day(current) : '', wording: text(current, 'status') || text(waybill, 'currentStatus') || currentCode }
    : null;
  if (!newest && !summary?.wording) throw new NoHistoryError(PROVIDER);
  const summaryStaged = summary?.wording ? satStage(currentCode, summary.wording) : null;
  const decided = summaryStaged ?? states.find((entry) => entry.staged)?.staged ?? null;
  const pickup = pickupPoint(states);
  const events = states.map((entry) => entry.event);
  const local = summary?.day || newest?.day;
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: summary?.wording || newest!.event.description!,
    ...(!newest && currentCode ? { provider_code: currentCode } : {}),
    last_update: null,
    ...(local ? { last_update_local: local } : {}),
    expected_delivery: null,
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
