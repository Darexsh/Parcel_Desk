import { isAcsVoucherNumber } from '../../core/detection/acsCourier.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { acsMilestoneStage, acsScanStage, acsSummary, isAcsNotice } from './status.js';

export const PROVIDER = 'ACS Courier';
export const ACS_MAX_BYTES = 512_000;
const MAX_SCANS = 300;
const MAX_EVENTS = 100;
/** The reply's note for a number ACS does not know, in English and in Greek. */
const NOT_FOUND_NOTES = new Set(['Shipment not found', 'Η αποστολή δεν βρέθηκε']);
/** A naive wall clock, to the second with an optional fraction. */
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,7})?$/;

/** An ACS voucher number, normalized. */
export function normalizeAcsNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!isAcsVoucherNumber(number)) throw new InvalidInputError(PROVIDER, 'ACS Courier voucher numbers are ten digits');
  return number;
}

/**
 * A scan's or estimate's wall clock, which carries no offset. Pickups and
 * deliveries summarized by day come at midnight exactly, so midnight is a
 * calendar day.
 */
function wallClock(value: unknown): string | null {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) return null;
  const [, day, time] = match as unknown as [string, string, string];
  const seconds = time.length === 5 ? `${time}:00` : time;
  if (Number.isNaN(Date.parse(`${day}T${seconds}Z`))) return null;
  return seconds === '00:00:00' ? day : `${day}T${seconds}`;
}

interface Scan {
  event: CarrierEvent;
  local: string;
  notice: boolean;
}

/**
 * The rows of a full history: a branch or hub as `controlPoint` and the scan's
 * wording as `description`. A shortened history (the Greek site's) puts its
 * milestone wording in `controlPoint` with a `controlPid` and no description,
 * and lists the milestones still to come without a date; those are skipped.
 * `info` holds a signatory's or sender's name on some rows, so it is read only
 * as the reason on a failed delivery.
 */
/**
 * Why a delivery failed, as ACS words it on the scan ("DIFFICULT TO ACCESS AREA").
 * A masked name, a phone or an address carries an asterisk, a digit or an at sign, and is dropped.
 */
function failureReason(info: unknown): string {
  const reason = clean(info, 80);
  return reason.length > 1 && !/[*@\d]/.test(reason) ? reason : '';
}

function scansOf(rows: readonly unknown[]): Scan[] {
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ACS Courier returned an invalid scan');
    if (row.controlPointDate === undefined || row.controlPointDate === null) continue;
    const local = wallClock(row.controlPointDate);
    if (!local) throw new SchemaError(PROVIDER, 'ACS Courier returned a scan with an invalid date');
    const description = clean(row.description, 200);
    const point = clean(row.controlPoint, 120);
    const wording = description || point;
    if (!wording) throw new SchemaError(PROVIDER, 'ACS Courier returned a scan without wording');
    const location = description ? point : '';
    const milestone = !description && Number.isInteger(row.controlPid) ? row.controlPid as number : undefined;
    const stage = milestone === undefined ? acsScanStage(wording) : acsMilestoneStage(milestone);
    const reason = stage === 'failed_attempt' && description ? failureReason(row.info) : '';
    const event: CarrierEvent = { local_time: local, description: reason ? `${wording} (${reason})` : wording, ...(location ? { location } : {}),
      ...(milestone === undefined ? {} : { provider_code: String(milestone) }), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ event, local, notice: isAcsNotice(wording) });
  }
  // Oldest first, as listed: a notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  for (const { event, notice } of scans) {
    if (notice) Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
    else if (event.stage) previous = event.stage as Stage;
  }
  // The history lists scans oldest first; a day without a clock keeps its place.
  return scans.reverse();
}

/**
 * The search reply for one voucher number. The parcel's summary status
 * settles delivered, returned and problem parcels; while it says the parcel
 * is on its way, the newest scan's stage is the current one.
 */
export function parseAcs(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAcsNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new SchemaError(PROVIDER);
  if (payload.items.length !== 1) throw new SchemaError(PROVIDER, 'ACS Courier did not answer for one parcel');
  const item: unknown = payload.items[0];
  if (!isRecord(item) || clean(item.trackingNumber, 40) !== number) {
    throw new SchemaError(PROVIDER, 'ACS Courier answered for a different parcel');
  }
  const rows = item.statusHistory ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'ACS Courier returned an invalid history');
  const statusId = item.shipmentStatusId;
  if (!Number.isInteger(statusId) || (statusId as number) < 0) throw new SchemaError(PROVIDER, 'ACS Courier returned a parcel without a status');

  const scans = scansOf(rows);
  if (statusId === 0 && !rows.length) {
    // The search answers every number; one it does not know comes back empty with this note.
    if (NOT_FOUND_NOTES.has(clean(item.notes, 80)) && item.isDelivered !== true && item.isReturned !== true) {
      throw new NotFoundError(PROVIDER);
    }
    throw new IndeterminateError(PROVIDER, 'ACS Courier returned a parcel without a status or history');
  }

  const events = scans.map(({ event }) => event);
  const summary = acsSummary(statusId as number);
  const scansDecide = !summary || summary.scansDecide === true;
  const newest = scans.find(({ notice }) => !notice)?.event;
  const stage = (scansDecide ? newest?.stage as Stage | undefined : undefined) ?? summary?.stage;
  // The newest scan words the status when it set it, or when the summary only says the parcel is on its way.
  const worded = newest && (newest.stage === stage || (scansDecide && !newest.stage)) ? newest.description : undefined;
  const text = worded ?? summary?.wording ?? newest?.description ?? null;

  // The SmartPoint the parcel waits at, or was collected from.
  const delivered = stage === 'delivered' ? events.findIndex(event => event.stage === 'delivered') : -1;
  const collected = delivered >= 0 && lastMovement(events.slice(delivered + 1)) === 'ready_for_pickup';
  const waiting = stage === 'ready_for_pickup' || collected
    ? events.slice(Math.max(0, delivered)).find(event => event.stage === 'ready_for_pickup' && event.stage_source === 'carrier_map')
    : undefined;
  const pickup = waiting?.location;

  // The estimate is a day; it stops once the parcel waits, arrives or turns back.
  const latestDay = scans[0]?.local.slice(0, 10);
  const estimate = wallClock(item.expectedDeliveryDate)?.slice(0, 10);
  const moving = stage && ['registered', 'accepted', 'in_transit', 'out_for_delivery'].includes(stage);
  const expected = moving && estimate && (!latestDay || estimate >= latestDay) ? estimate : null;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: text,
    ...(events.length ? {} : { provider_code: String(statusId), summary_only: true }),
    last_update: null,
    last_update_local: scans[0]?.local ?? null,
    expected_delivery: expected,
    ...(pickup ? { pickup_point: pickup } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
