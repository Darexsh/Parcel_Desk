import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ceskaPostaStage, isCeskaPostaNotice, RETURN_STARTS } from './status.js';

export const PROVIDER = 'Česká pošta';
// A long history is a few kilobytes.
export const CESKA_POSTA_MAX_BYTES = 256_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const CODE = /^-?[A-Z0-9]{1,4}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Rows the service adds to every answer, which are not scans: a line pointing
// to the customer line, no record for the number, and a type it does not show.
const INFO = '-1';
const NO_RECORD = '-3';
const WITHHELD = '-4';

/**
 * Česká pošta's domestic numbers are two letters, ten digits and a letter
 * (DR for Balíkovna and parcels, BA and others for registered items); it also
 * tracks S10 items, its own and those other posts send to the Czech Republic.
 */
export function normalizeCeskaPostaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^[A-Z]{2}\d{10}[A-Z]$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Česká pošta tracks its own item numbers and S10 item codes');
}

interface Row { readonly code: string; readonly day: string; readonly text: string; readonly place: string; readonly index: number }

function rowOf(value: unknown, index: number): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Česká pošta returned an invalid row');
  const code = clean(value.id, 8);
  const match = typeof value.date === 'string' ? DAY.exec(value.date.trim()) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!CODE.test(code) || !day) throw new SchemaError(PROVIDER, 'Česká pošta returned a row without a code or date');
  // The row's postcode, coordinates and attempt time are never read: they can
  // place the recipient.
  return { code, day, text: textFromHtml(value.text, 300), place: textFromHtml(value.postoffice, 160), index };
}

/**
 * The tracking service's answer for one number: its rows, each with a state
 * code, a calendar day and English wording, in no strict order. An unknown
 * number comes back with a single row saying there is no record.
 */
export function parseCeskaPosta(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeCeskaPostaNumber(rawNumber);
  if (isRecord(payload) && 'ident' in payload) throw new IndeterminateError(PROVIDER, 'Česká pošta returned an error instead of the item');
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SchemaError(PROVIDER, 'Česká pošta did not return one item');
  }
  const item = payload[0];
  if (typeof item.id !== 'string' || item.id.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Česká pošta answered for a different item');
  }
  const states = isRecord(item.states) ? item.states.state : undefined;
  if (!Array.isArray(states) || states.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Česká pošta returned an invalid item history');
  const rows = states.map(rowOf).filter(row => row.code !== INFO);
  const notices = rows.filter(row => row.code === NO_RECORD || row.code === WITHHELD);
  if (notices.length) {
    // Only an answer made of the no-record notice alone is a missing item.
    if (notices.length === rows.length && notices.every(row => row.code === NO_RECORD)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, notices.some(row => row.code === WITHHELD)
      ? 'Česká pošta does not show this item type' : 'Česká pošta returned a notice next to the item history');
  }
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'Česká pošta returned no rows');

  const scans: { event: CarrierEvent; row: Row }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const event: CarrierEvent = { local_time: row.day, description: row.text || row.code, provider_code: row.code,
      ...(row.place ? { location: row.place } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push({ event, row });
  }
  // Newest day first. Rows of one day come oldest first, so their order is
  // reversed; the tracking page lists them the same way.
  scans.sort((left, right) => right.row.day.localeCompare(left.row.day) || right.row.index - left.row.index);

  // Oldest first: a notice keeps the stage of the row before it, and a
  // delivery after the item was sent back reaches the sender.
  let returning = false;
  let previous: Stage | undefined;
  for (const { event, row } of [...scans].reverse()) {
    if (RETURN_STARTS.has(row.code)) returning = true;
    if (isCeskaPostaNotice(row.code)) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
      continue;
    }
    const classified = ceskaPostaStage(row.code, row.text);
    const stage = classified?.stage === 'delivered' && returning ? 'returned' : classified?.stage;
    if (stage) Object.assign(event, { stage, stage_source: classified!.source });
    previous = stage;
  }
  const events = scans.map(scan => scan.event);

  const decider = scans.find(scan => !isCeskaPostaNotice(scan.row.code)) ?? scans[0]!;
  const stage = decider.event.stage as Stage | undefined;
  // The office or box an item waits at is its pickup point; a delivered item
  // was collected there when it waited there last. A return's is the sender's.
  let point = '';
  if (!returning) {
    if (stage === 'ready_for_pickup') point = decider.row.place;
    else if (stage === 'delivered') {
      const earlier = scans.slice(scans.indexOf(decider) + 1);
      if (lastMovement(earlier.map(scan => scan.event)) === 'ready_for_pickup') {
        point = earlier.find(scan => scan.event.stage === 'ready_for_pickup' && !isCeskaPostaNotice(scan.row.code))?.row.place ?? '';
      }
    }
  }
  const attributes = isRecord(item.attributes) ? item.attributes : {};
  const weight = typeof attributes.weight === 'number' && Number.isFinite(attributes.weight) && attributes.weight > 0 && attributes.weight < 10_000
    ? attributes.weight : null;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider.event.stage_source } : {}),
    last_status_text: decider.event.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
