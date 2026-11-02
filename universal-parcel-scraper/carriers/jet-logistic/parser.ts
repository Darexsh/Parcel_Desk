import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jetLogisticStage } from './status.js';

export const PROVIDER = 'Jet Logistic';
// A delivered cargo's reply is about two kilobytes.
export const JET_LOGISTIC_MAX_BYTES = 64 * 1024;
// Cargo IDs are twelve digits; the service files a cargo under the last seven, its request number.
const NUMBER = /^\d{12}$/;
const REQUEST_DIGITS = 7;
const MAX_ANSWER = 32_000;
const MAX_LINES = 200;
const MAX_EVENTS = 100;

/** A cargo ID for Jet Logistic's tracker, twelve digits; anything else is not one it issues. */
export function normalizeJetLogisticNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jet Logistic cargo IDs are twelve digits');
  return number;
}

// The answer's first line, its heading.
const HEADING = /^Статус выполнения заявки\s*:?$/i;
// The cargo's ID and the kind of goods, which is not kept.
const IDENTITY = /^Код груза\s+(\d{1,20})(?:\s*,|$)/i;
// The cost of the service and the payments for goods Jet Logistic bought for the
// customer, with their dates: payment details, not kept.
const PAYMENT = /^(?:Оплата|Стоимость|Сумма|К оплате|Долг|Задолженность)/i;
// A step with its wall clock, as "Отправка груза со склада приемки-Москва-(Москва Город),
// дата выполнения : 25.11.2020 22:45:47". The page reads the time as optional.
const STEP = /^(.+?),?\s*дата выполнения\s*:\s*(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/i;
// A step dated by its day alone, as "Груз выдан : 4 декабря 2020 г.".
const DAY_STEP = /^(.+?)\s*:\s*(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s*г\.?$/i;
// The warehouse's town and region after the step's wording: "…-Усть-Каменогорск-(Восточно-Казахстанская область)".
const PLACE = /^(.+?)-(.+)-\(([^()]*)\)$/;
const MONTHS: ReadonlyMap<string, number> = new Map([
  ['января', 1], ['февраля', 2], ['марта', 3], ['апреля', 4], ['мая', 5], ['июня', 6],
  ['июля', 7], ['августа', 8], ['сентября', 9], ['октября', 10], ['ноября', 11], ['декабря', 12],
]);

/** A town and its region as one location; a city that is its own region, as "Москва-(Москва Город)", adds nothing. */
function location(town: string, region: string): string {
  const [place, area] = [clean(town, 80), clean(region, 80)];
  if (!area || area.toLowerCase().replace(/\s+город$/, '') === place.toLowerCase()) return place;
  return place ? `${place}, ${area}` : area;
}

/** A wall clock the answer prints as dd.mm.yyyy h:mm:ss, or its day alone. It names no zone, so it stays local. */
function wallClock(day: string | null, hours?: string, minutes?: string, seconds?: string): string {
  if (!day) throw new SchemaError(PROVIDER, 'Jet Logistic returned an invalid step date');
  if (hours === undefined) return day;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    throw new SchemaError(PROVIDER, 'Jet Logistic returned an invalid step time');
  }
  return `${day}T${hours.padStart(2, '0')}:${minutes}:${seconds}`;
}

/** One step of the answer as an event, or null for a line that is no step. */
function step(line: string): CarrierEvent | null {
  const timed = STEP.exec(line);
  if (timed) {
    const day = calendarDay(Number(timed[4]), Number(timed[3]), Number(timed[2]));
    return event(timed[1]!, wallClock(day, timed[5], timed[6], timed[7]));
  }
  const dated = DAY_STEP.exec(line);
  if (!dated) return null;
  const month = MONTHS.get(dated[3]!.toLowerCase());
  return event(dated[1]!, wallClock(month ? calendarDay(Number(dated[4]), month, Number(dated[2])) : null));
}

/** A step's wording, without the warehouse's town and region, which become its location. */
function event(wording: string, local: string): CarrierEvent {
  const place = PLACE.exec(wording);
  const description = clean(place ? place[1] : wording, 200);
  if (!description) throw new SchemaError(PROVIDER, 'Jet Logistic returned a step without wording');
  const where = place ? location(place[2]!, place[3]!) : '';
  const staged = jetLogisticStage(description);
  return {
    local_time: local,
    ...(where ? { location: where } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of `/ajax/checkstatus.php`, the cargo check on every page of
 * jetlogistic.kz: `success` 1 with the cargo's status as text in `answer`, one
 * line per step separated by carriage returns, oldest first; or `success` 0
 * with a message. The service looks the cargo up by the last seven digits of
 * what it is sent, so the answer must name the whole cargo ID asked. The kind
 * of goods, the cost and the payments for bought goods are not kept, nor is
 * the payment link the page can ask for.
 */
export function parseJetLogistic(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJetLogisticNumber(raw);
  if (!isRecord(payload) || (payload.success !== 0 && payload.success !== 1) || typeof payload.answer !== 'string') {
    throw new SchemaError(PROVIDER, 'Jet Logistic returned an invalid reply');
  }
  if (payload.answer.length > MAX_ANSWER) throw new SchemaError(PROVIDER, 'Jet Logistic returned an oversized answer');
  if (payload.success === 0) {
    // "Не обнаружены данные по заявке 1234567, проверьте указаный трек номер(ИД/ID)".
    const request = /Не обнаружены данные по заявке\s+(\d{1,20})/i.exec(payload.answer)?.[1];
    if (request === undefined) throw new IndeterminateError(PROVIDER, 'Jet Logistic did not complete the lookup');
    if (request.padStart(REQUEST_DIGITS, '0') === number.slice(-REQUEST_DIGITS)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Jet Logistic answered for another request');
  }

  const lines = payload.answer.split(/\r\n?|\n/).map((line) => clean(line, 1_000)).filter(Boolean);
  if (lines.length > MAX_LINES) throw new SchemaError(PROVIDER, 'Jet Logistic returned an oversized answer');
  const identity = lines.map((line) => IDENTITY.exec(line)?.[1]).filter((code) => code !== undefined);
  if (identity.length !== 1) throw new SchemaError(PROVIDER, 'Jet Logistic returned a status without the cargo ID');
  if (identity[0] !== number) throw new IndeterminateError(PROVIDER, 'Jet Logistic answered for another cargo');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const line of lines) {
    if (HEADING.test(line) || IDENTITY.test(line) || PAYMENT.test(line)) continue;
    // Any other line without a date is left out: it is no step, and could carry other details.
    const event = step(line);
    if (!event) continue;
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the answer lists the steps in the order they happened.
  events.reverse();

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
