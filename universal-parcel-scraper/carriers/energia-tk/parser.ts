import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult, type EventPoint } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { energiaStage } from './status.js';

export const PROVIDER = 'TK Energia';
// A receipt's reply, with the issuing warehouse's timetable twice, is a few kilobytes.
export const ENERGIA_MAX_BYTES = 256 * 1024;
// The tracker's own example: a branch code of three or four digits, a dash and
// seven digits, or the seven digits alone. Some receipts end in R.
const NUMBER = /^(\d{3,4})?(\d{7})(R?)$/;
// A dash typed elsewhere makes another receipt's digits.
const DASHED = /^\s*\d{3,4}\s*-\s*\d{7}\s*R?\s*$/i;
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const MAX_STATES = 50;
// A state's Unix time, between 2000 and 2100.
const EARLIEST = 946_684_800;
const LATEST = 4_102_444_800;
// The stages a consignment passes in order. A split consignment is as far as
// its slowest places; a problem with some of them comes before any of these.
const PROGRESS: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery', 'failed_attempt',
  'ready_for_pickup', 'delivered'];
// Stages before the cargo reaches the issuing warehouse, while the arrival window still matters.
const BEFORE_ARRIVAL = new Set<Stage>(['registered', 'accepted', 'in_transit', 'customs']);

/** A receipt number as the tracker takes it, with its dash; anything else is not one Energia issues. */
export function energiaDocumentNumber(raw: string): string {
  const match = NUMBER.exec(raw.length <= 64 && (!raw.includes('-') || DASHED.test(raw)) ? normalizeTrackingNumber(raw) : '');
  if (!match) throw new InvalidInputError(PROVIDER, 'TK Energia receipts are seven digits after a branch code of three or four');
  return `${match[1] ? `${match[1]}-` : ''}${match[2]}${match[3]}`;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TK Energia returned an invalid ${key}`);
  return clean(value, maxLength);
}

function record(value: unknown, what: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `TK Energia returned an invalid ${what}`);
  return value;
}

function code(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new SchemaError(PROVIDER, `TK Energia returned an invalid ${what}`);
  return value as number;
}

interface Warehouse {
  title: string;
  address: string;
  point: EventPoint | null;
}

/** One of Energia's warehouses: its name, its address and where it is. Its phone, email and timetable are not read. */
function warehouse(value: unknown): Warehouse | null {
  const row = record(value, 'warehouse');
  if (!row) return null;
  const title = text(row, 'title', 120);
  if (!title) return null;
  return { title, address: text(row, 'fulladdress') || text(row, 'address'), point: eventPoint(row.latitude, row.longitude) };
}

/** A trip's route, as the tracker shows it: "Новосибирск ⇒ Владивосток". */
function route(value: unknown): string {
  const trip = record(value, 'trip');
  if (!trip) return '';
  const [from, to] = ['cityFrom', 'cityTo'].map((key) => {
    const city = record(trip[key], 'trip town');
    return city ? text(city, 'name', 80) : '';
  });
  return from && to ? `${from} ⇒ ${to}` : '';
}

/** A state's Unix time as an instant: every issue it dates falls in the warehouse's opening hours read this way. */
function moment(value: unknown): string | undefined {
  if (value === null || value === undefined || value === 0) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < EARLIEST || (value as number) > LATEST) {
    throw new SchemaError(PROVIDER, 'TK Energia returned an invalid state date');
  }
  return new Date((value as number) * 1000).toISOString().replace('.000Z', 'Z');
}

interface State {
  index: number;
  stage?: Stage;
  source?: string;
  place: Warehouse | null;
  event: CarrierEvent;
}

/**
 * One of the receipt's current states, worded as the tracker lists it: its
 * label and sub-state, the places it covers when the cargo is split, and a
 * trip's route. The warehouse it is at, or was handed out at, is its location.
 * The name of whoever collected the cargo is never read.
 */
function state(row: Record<string, unknown>, index: number, split: boolean): State {
  const id = code(row.idState, 'state');
  const sub = row.idSubState === null || row.idSubState === undefined ? 0 : code(row.idSubState, 'sub-state');
  const title = text(row, 'title', 80);
  const subTitle = text(row, 'subStateTitle', 80);
  const wording = [title, subTitle].filter(Boolean).join(': ') || (id === 0 || id === 3 ? 'Груз у отправителя' : '');
  if (!wording) throw new SchemaError(PROVIDER, 'TK Energia returned a state without wording');
  const info = record(row.stateInfo, 'state details');
  const issued = info ? record(info.issued, 'issue') : null;
  const place = warehouse(issued ? issued.warehouse : info?.warehouse);
  const places = split && Number.isSafeInteger(row.amount) && (row.amount as number) > 0 ? `мест ${row.amount as number}` : '';
  const description = [wording, places, info ? route(info.trip) : ''].filter(Boolean).join(', ');
  const time = moment(row.movingDate);
  const providerCode = `${id}-${sub}`;
  // The tracker reads a state by its sub-state's label, else its own.
  const staged = energiaStage(providerCode, subTitle || title, description);
  return { index, place, ...(staged ? { stage: staged.stage, source: staged.source } : {}), event: {
    ...(time ? { time } : {}),
    ...(place ? { location: place.title } : {}),
    description,
    ...(place?.point ? { point: place.point } : {}),
    provider_code: providerCode,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** How far a state's stage is: a problem first, then the order of `PROGRESS`, a state without a stage last. */
function progress(stage: Stage | undefined): number {
  if (!stage) return PROGRESS.length;
  const rank = PROGRESS.indexOf(stage);
  return rank < 0 ? -1 : rank;
}

/** A calendar day the tracker writes as dd.mm.yyyy. */
function day(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 16);
  if (!value) return null;
  const match = DAY.exec(value);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!match || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new SchemaError(PROVIDER, `TK Energia returned an invalid ${key}`);
  }
  return iso;
}

/**
 * The reply of `/rest/waybills/states` for one receipt, the lookup the
 * tracker page makes. It holds the receipt's current state, one per group of
 * places, not a history. An unknown receipt is a 404 whose message names it.
 * The reply must name the whole number asked: an empty search answers some
 * other receipt.
 */
export function parseEnergia(payload: unknown, raw: string): CarrierResult {
  const number = energiaDocumentNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'TK Energia returned an invalid reply');
  if (!Object.hasOwn(payload, 'docnum')) {
    if (payload.status === 'NOT_FOUND') {
      // "Waybill with document number: … not found".
      if (clean(payload.message, 300).includes(number)) throw new NotFoundError(PROVIDER);
      throw new IndeterminateError(PROVIDER, 'TK Energia answered for another receipt');
    }
    throw new SchemaError(PROVIDER, 'TK Energia returned a reply without the receipt');
  }
  if (typeof payload.docnum !== 'string') throw new SchemaError(PROVIDER, 'TK Energia returned an invalid receipt number');
  if (normalizeTrackingNumber(clean(payload.docnum, 64)) !== normalizeTrackingNumber(number)) {
    throw new IndeterminateError(PROVIDER, 'TK Energia answered for another receipt');
  }
  const rows = payload.states ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_STATES) throw new SchemaError(PROVIDER, 'TK Energia returned invalid states');
  const states = rows.map((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TK Energia returned an invalid state');
    return state(row, index, rows.length > 1);
  });
  if (!states.length) throw new NoHistoryError(PROVIDER);
  // Newest first; an undated state, cargo still with the sender, last.
  const at = (entry: State) => (entry.event.time ? Date.parse(entry.event.time) : -1);
  states.sort((left, right) => at(right) - at(left) || left.index - right.index);

  const current = states.reduce((slowest, entry) => (progress(entry.stage) < progress(slowest.stage) ? entry : slowest));
  const stage = current.stage;
  const delivered = stage === 'delivered' ? states.find((entry) => entry.stage === 'delivered' && entry.event.time) : undefined;
  // Cargo waits at, or was handed out at, its state's warehouse; until then
  // the destination warehouse is where it will wait. Door delivery has none.
  const waiting = stage === 'ready_for_pickup' || stage === 'delivered' ? current.place : null;
  const point = payload.isDelivery === true ? null : waiting ?? warehouse(payload.warehouseTo);
  const window = stage === undefined || BEFORE_ARRIVAL.has(stage) ? { from: day(payload, 'deliveryDateFromFormatted'),
    to: day(payload, 'deliveryDateToFormatted') } : { from: null, to: null };
  const expected = window.to ?? window.from;
  const weight = typeof payload.weight === 'number' && Number.isFinite(payload.weight) && payload.weight > 0 ? payload.weight : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.source ?? 'carrier_map' } : {}),
    last_status_text: current.event.description!,
    last_update: states.find((entry) => entry.event.time)?.event.time ?? null,
    expected_delivery: expected,
    ...(window.from && expected && window.from < expected ? { expected_delivery_from: window.from } : {}),
    ...(delivered ? { delivered_at: delivered.event.time } : {}),
    ...(point ? { pickup_point: [point.title, point.address].filter(Boolean).join('\n') } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    summary_only: true,
    events: states.map((entry) => entry.event),
  };
}
