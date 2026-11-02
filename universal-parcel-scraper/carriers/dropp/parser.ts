import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { DROPP_STEPS, droppStage } from './status.js';

export const PROVIDER = 'Dropp';
// The reply is a few hundred bytes.
export const DROPP_MAX_BYTES = 64 * 1024;
// Letters and digits: Dropp's own DR barcodes and the order ids merchants print instead.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,40}$/;
// `dd.MM.yyyy HH:mm`, as the page shows it.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;

/** A number for Dropp's tracker, in upper case; anything else is not one it issues. */
export function normalizeDroppNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Dropp numbers are letters and digits');
  return number;
}

/** A step's clock as a wall clock, or nothing for a step not reached. */
function clock(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === null || value === undefined || value === '') return null;
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const [, day, month, year, hour, minute] = match ?? [];
  const date = match ? calendarDay(Number(year), Number(month), Number(day)) : null;
  if (!date || Number(hour) > 23 || Number(minute) > 59) throw new SchemaError(PROVIDER, `Dropp returned an invalid ${key} time`);
  return `${date}T${hour}:${minute}:00`;
}

/** An optional flag; anything but a boolean is a changed reply. */
function flag(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') throw new SchemaError(PROVIDER, `Dropp returned an invalid ${key}`);
  return value;
}

interface Step {
  readonly order: number;
  readonly local: string;
  readonly stage: Stage | undefined;
  readonly event: CarrierEvent;
}

/**
 * The reply of `GET /dropp/api/v1/dropp/track/json/{number}`, the lookup the
 * search on dropp.is makes: the shipment's barcode, its sender and the date of
 * each step it reached, blank for the others. A number Dropp does not know
 * comes back with a null `barcode` and `store` and no dates, which the search
 * reports as "Engin sending fannst með þessum kóða" (no shipment found with
 * this code). A shipment must name the number asked.
 */
export function parseDropp(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDroppNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'barcode')) throw new SchemaError(PROVIDER, 'Dropp returned an invalid reply');
  const barcode = payload.barcode;
  if (barcode !== null && typeof barcode !== 'string') throw new SchemaError(PROVIDER, 'Dropp returned an invalid barcode');
  const home = flag(payload, 'home');
  const steps: Step[] = [];
  DROPP_STEPS.forEach(({ step, wording }, order) => {
    const local = clock(payload, step);
    if (!local) return;
    const stage = droppStage(step, home);
    steps.push({ order, local, stage, event: {
      local_time: local, description: wording, provider_code: step,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } });
  });
  if (barcode === null || !clean(barcode)) {
    if (steps.length) throw new SchemaError(PROVIDER, 'Dropp returned a shipment without its number');
    throw new NotFoundError(PROVIDER);
  }
  if (normalizeTrackingNumber(clean(barcode, 64)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Dropp answered for another shipment');
  }
  if (!steps.length) throw new NoHistoryError(PROVIDER);

  // The furthest step reached is the parcel's state, as the page fills its rail.
  const furthest = steps.at(-1)!;
  // Newest first; of two steps in the same minute, the later step comes first.
  const sorted = [...steps].sort((a, b) => (a.local === b.local ? b.order - a.order : a.local < b.local ? 1 : -1));
  const { stage } = furthest;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: furthest.event.description!,
    last_update: null,
    last_update_local: sorted[0]!.local,
    expected_delivery: null,
    events: sorted.map((item) => item.event),
  };
}
