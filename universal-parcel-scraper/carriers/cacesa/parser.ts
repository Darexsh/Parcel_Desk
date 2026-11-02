import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cacesaCode, cacesaStage } from './status.js';

export const PROVIDER = 'CACESA';
// A shipment's reply is a few kilobytes: one row per milestone, in two languages.
export const CACESA_MAX_BYTES = 256 * 1024;
// The tracker checks no format. A comma or a space would make the service read
// several numbers, so only letters and digits are sent.
const NUMBER = /^(?=.*\d)[A-Z0-9]{6,40}$/;
// The row the service sends for a number it does not know, as the tracker reads it.
const NOT_FOUND = 'Envio no encontrado';
// A wall clock without an offset; the service's placeholder date is year 1.
const CLOCK = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/;
// The milestones' clock is Madrid's: the customs milestones match Cainiao's to the second there.
const ZONE = 'Europe/Madrid';
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** A number CACESA can be asked about: letters and digits only. */
export function normalizeCacesaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CACESA numbers are six to forty letters and digits');
  return number;
}

/** A text field; an object, array or number is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `CACESA returned an invalid ${key}`);
  return clean(value, maxLength);
}

interface Milestone {
  readonly event: CarrierEvent & { time: string; description: string };
  readonly at: number;
  readonly index: number;
}

function projectMilestone(row: Record<string, unknown>, index: number): Milestone {
  const stamp = text(row, 'milestone_Date', 64);
  const year = CLOCK.exec(stamp)?.[1];
  const time = year && Number(year) >= 2000 ? isoTime(stamp, ZONE) : null;
  if (!time) throw new SchemaError(PROVIDER, 'CACESA returned a milestone without a usable date');
  // The tracker shows the English wording on its English page.
  const description = text(row, 'english_Description') || text(row, 'spanish_Description');
  if (!description) throw new SchemaError(PROVIDER, 'CACESA returned a milestone without wording');
  const type = text(row, 'shipmentType', 32);
  const icon = text(row, 'icon', 64);
  const stage = cacesaStage(type, icon);
  return {
    event: {
      time: time.iso,
      description,
      ...(type && icon ? { provider_code: cacesaCode(type, icon) } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    },
    at: time.timestamp,
    index,
  };
}

/**
 * The reply of `POST /cacesa.api/api/Tracking` for one number: a row per
 * milestone, oldest first, each naming its shipment. Rows of another shipment
 * are not read. A number the service does not know gets one placeholder row.
 */
export function parseCacesa(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCacesaNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'CACESA returned an unexpected reply');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CACESA returned an oversized history');
  const rows = payload.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'CACESA returned an invalid milestone');
    return row;
  }).filter((row) => normalizeTrackingNumber(text(row, 'shipmentCode', 64)) === number);
  if (!rows.length) throw new IndeterminateError(PROVIDER, payload.length ? 'CACESA answered for another shipment' : 'CACESA returned no milestones');
  if (rows.length === 1 && text(rows[0]!, 'spanish_Description') === NOT_FOUND) throw new NotFoundError(PROVIDER);

  const seen = new Set<string>();
  const milestones: Milestone[] = [];
  rows.forEach((row, index) => {
    const milestone = projectMilestone(row, index);
    const key = JSON.stringify(milestone.event);
    if (seen.has(key)) return;
    seen.add(key);
    milestones.push(milestone);
  });
  // Newest first; of two milestones at the same second, the later row is newer.
  milestones.sort((left, right) => right.at - left.at || right.index - left.index);
  const newest = milestones[0]!.event;
  const current = newest.stage
    ? { stage: newest.stage as Stage, source: 'carrier_map' }
    : classifyWording(newest.description, 'in_transit');
  const stage = current.source !== 'none' ? current.stage : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.source } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: newest.time } : {}),
    // The transport company CACESA hands the parcel to delivers it under the
    // same number. The reply does not name it; the catalog's hand-off rule
    // asks a carrier whose high-confidence detection rule claims the number.
    delivery_tracking_number: number,
    events: milestones.slice(0, MAX_EVENTS).map((milestone) => milestone.event),
    ...(milestones.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
