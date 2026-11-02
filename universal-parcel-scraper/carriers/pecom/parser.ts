import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult, type EventPoint } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pecomStage } from './status.js';

export const PROVIDER = 'PEC';
// A cargo's reply carries both terminals' timetables and its storage days; a
// long-stored one is under 300 kilobytes.
export const PECOM_MAX_BYTES = 2 * 1024 * 1024;
// PEC's error for a cargo code it does not know: "Запрашиваемый Вами груз … не найден".
const NOT_FOUND = -33000;
const NOT_FOUND_WORDING = /не\s+найден/iu;
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
// A status PEC records without a time of day gets the last second of its day.
const END_OF_DAY = 'T23:59:59';
// Where a status happens, by its id: acceptance (1) and documentation (3) at
// the sending department, arrival (5) and collection (8) at the receiving one.
// Transit (4) and door delivery (9) name no department.
const AT_SOURCE = new Set([1, 3]);
const AT_TARGET = new Set([5, 8]);
const ARRIVED = 5;
const MAX_ROWS = 200;
// Stages before the cargo reaches the receiving terminal, when its forecast still matters.
const BEFORE_ARRIVAL = new Set<Stage>(['registered', 'accepted', 'in_transit', 'customs']);

/** A cargo code: twelve digits, sometimes typed in groups of four. Anything else is not one PEC's tracker takes. */
export function normalizePecomNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'PEC cargo codes are twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PEC returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional wall clock to the second. The reply names no zone, so it stays local. */
function clock(row: Record<string, unknown>, key: string): string | undefined {
  const value = text(row, key, 32);
  if (!value) return undefined;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  if (!CLOCK.test(value) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value) {
    throw new SchemaError(PROVIDER, `PEC returned an invalid ${key}`);
  }
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new SchemaError(PROVIDER, `PEC returned invalid ${what}`);
  return value;
}

interface Department {
  name: string;
  town: string;
  address: string;
  point: EventPoint | null;
}

/** A PEC department: its name, its town without the district PEC adds in brackets, its address and its coordinates. */
function department(value: unknown): Department | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'PEC returned an invalid department');
  const town = isRecord(value.Town) ? text(value.Town, 'Town', 80).replace(/\s*\([^()]*\)$/u, '') : '';
  const address = list(value.Addresses, 'department addresses')
    .map((row) => (isRecord(row) && isRecord(row.address) ? row.address : null))
    .find((row) => row !== null);
  const coordinates = address && isRecord(address.Coordinates) ? address.Coordinates : null;
  return {
    name: text(value, 'DepartmentName', 120),
    town,
    address: address ? text(address, 'RawAddress', 200) : '',
    point: coordinates ? eventPoint(coordinates.latitude, coordinates.longitude) : null,
  };
}

function statusId(row: Record<string, unknown>): number | undefined {
  return Number.isSafeInteger(row.Id) && (row.Id as number) >= 0 ? row.Id as number : undefined;
}

/** A dated row, kept by its full clock for ordering. */
interface Row {
  clock: string;
  event: CarrierEvent;
}

/** A scan at its wall clock; a clock at the last second of a day keeps only the day. */
function scan(clock: string, description: string, place: { location?: string; point?: EventPoint | null }): Row {
  const staged = pecomStage(description);
  return { clock, event: {
    local_time: clock.endsWith(END_OF_DAY) ? clock.slice(0, 10) : clock,
    ...(place.location ? { location: place.location } : {}),
    description,
    ...(place.location && place.point ? { point: place.point } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

interface Arrival {
  reached: boolean;
  forecast?: string;
}

/**
 * The cargo's dated statuses. A status without an actual clock is one the
 * cargo has not reached; the arrival's planned or corrected date is then the
 * forecast the tracker shows.
 */
function statuses(cargo: Record<string, unknown>, source: Department | null, target: Department | null) {
  const dated: Row[] = [];
  const arrival: Arrival = { reached: false };
  for (const row of list(cargo.statuses, 'statuses')) {
    if (!isRecord(row) || !isRecord(row.clientStatus)) throw new SchemaError(PROVIDER, 'PEC returned an invalid status');
    const id = statusId(row.clientStatus);
    const local = clock(row, 'clientStatusActualDateTime');
    if (id === ARRIVED) {
      arrival.reached ||= Boolean(local);
      const forecast = clock(row, 'clientStatusSpecifiedDate') ?? clock(row, 'clientStatusPlannedDate');
      if (forecast) arrival.forecast = forecast.slice(0, 10);
    }
    if (!local) continue;
    const description = text(row.clientStatus, 'ClientStatus', 120);
    if (!description) throw new SchemaError(PROVIDER, 'PEC returned a status without wording');
    const at = id !== undefined && AT_SOURCE.has(id) ? source : id !== undefined && AT_TARGET.has(id) ? target : null;
    dated.push(scan(local, description, { location: at?.town, point: at?.point }));
  }
  return { rows: dated, arrival };
}

/**
 * The transit rows the tracker lists under "В пути": a status and the terminal
 * it concerns, worded as the page words them ("Отправлен на терминал выдачи
 * Раменское"). An arrival happens at its terminal; a dispatch only names where
 * the cargo goes. The arrival at the receiving terminal repeats the main
 * status, so the page leaves it out.
 */
function transit(cargo: Record<string, unknown>, arrived: boolean): Row[] {
  const dated: Row[] = [];
  for (const row of list(cargo.detailsCargoStatus, 'transit rows')) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PEC returned an invalid transit row');
    const local = clock(row, 'initDate');
    const status = text(row, 'statusName', 60);
    if (!local || !status) continue;
    const kind = text(row, 'targetWarehouseType', 60);
    const terminal = text(row, 'targetWarehouseName', 120);
    if (status === 'Прибыл' && kind === 'Терминал выдачи' && arrived) continue;
    const kindText = kind.toLowerCase();
    const description = [status, kindText ? `${kindText === 'пункт выдачи' ? 'в' : 'на'} ${kindText}` : '', terminal].filter(Boolean).join(' ');
    dated.push(scan(local, description, { location: status === 'Прибыл' ? terminal : undefined }));
  }
  return dated;
}

/**
 * The reply of `LK.OCR.Get` for one cargo code, the call PEC's tracking page
 * makes for a cargo's details. PEC answers a code it does not know with a
 * JSON-RPC error. The cargo must carry the whole code asked. Its current
 * status decides the stage; its dated statuses and transit rows are the
 * history. Sender and recipient details in the reply are never read.
 */
export function parsePecom(payload: unknown, raw: string): CarrierResult {
  const number = normalizePecomNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'PEC returned an invalid envelope');
  if (payload.error !== undefined && payload.error !== null) {
    const error = isRecord(payload.error) ? payload.error : {};
    if (error.code === NOT_FOUND && NOT_FOUND_WORDING.test(clean(error.message, 300))) throw new NotFoundError(PROVIDER);
    // JSON-RPC's own errors, such as an unknown method or invalid params, mean the request changed.
    if (typeof error.code === 'number' && error.code <= -32000 && error.code >= -32768) {
      throw new SchemaError(PROVIDER, 'PEC refused the tracking request');
    }
    throw new IndeterminateError(PROVIDER, 'PEC did not complete the lookup');
  }
  const data = isRecord(payload.result) ? payload.result.data : undefined;
  if (!isRecord(data) || !isRecord(data.cargo)) throw new SchemaError(PROVIDER, 'PEC returned a reply without the cargo');
  const cargo = data.cargo;
  const codes = [text(cargo, 'index', 40), text(cargo, 'barcode', 40)].filter(Boolean);
  if (!codes.length) throw new SchemaError(PROVIDER, 'PEC returned a cargo without its code');
  if (!codes.includes(number)) throw new IndeterminateError(PROVIDER, 'PEC answered for another cargo');

  const source = department(cargo.sourceDepartment);
  const target = department(cargo.targetDepartment);
  const { rows: dated, arrival } = statuses(cargo, source, target);
  // Newest first; of two rows at one clock, the later in the reply is newer.
  const events = [...dated, ...transit(cargo, arrival.reached)]
    .map((row, index) => ({ ...row, index }))
    .sort((left, right) => right.clock.localeCompare(left.clock) || right.index - left.index)
    .map(({ event }) => event);

  const current = isRecord(cargo.currentStatus) ? text(cargo.currentStatus, 'ClientStatus', 120) : '';
  if (!current && !events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0];
  const summary = current ? pecomStage(current) : null;
  const scanned = events.find((event) => event.stage);
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const stageSource = summary ? summary.source : scanned?.stage_source;

  // A cargo brought to the door has a delivery order, or a status that says so.
  const door = isRecord(cargo.cargoDelivery) || stage === 'out_for_delivery'
    || [current, ...events.map((event) => event.description)].some((wording) => /^доставлен получателю$/iu.test(wording ?? ''));
  const pickup = !door && target ? [target.name, target.address].filter(Boolean).join('\n') : '';
  const expected = !arrival.reached && (!stage || BEFORE_ARRIVAL.has(stage)) ? arrival.forecast ?? null : null;
  const weight = typeof cargo.totalWeight === 'number' && Number.isFinite(cargo.totalWeight) && cargo.totalWeight > 0 ? cargo.totalWeight : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: stageSource ?? 'carrier_map' } : {}),
    last_status_text: current || newest!.description!,
    ...(events.length ? {} : { summary_only: true }),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expected,
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    events,
  };
}
