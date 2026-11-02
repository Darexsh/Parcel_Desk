import { DateTime } from 'luxon';
import { isValidSscc, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { aramexAuStage } from './status.js';

export const PROVIDER = 'Aramex Australia';
// A parcel's reply is a few kilobytes: a dozen scans with their depots.
export const ARAMEX_AU_MAX_BYTES = 512 * 1024;

// A label: two letters or digits, at least one a letter, then ten digits.
const LABEL = /^(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\d{10}$/;
// The tracker also finds a parcel by the sender's SSCC printed on it.
const SSCC = /^00\d{18}$/;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CODE = /^[A-Z0-9]{1,8}$/;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** One Aramex network on the tracker platform Aramex Australia and Aramex New Zealand share. */
export interface AramexNetwork {
  /** The network's name: the source of its failures and the subject of their messages. */
  readonly provider: string;
  /** Whether its tracker also finds a parcel by the sender's SSCC and names Aramex's own label. */
  readonly sscc: boolean;
  /** Scans the page hides. */
  readonly hidden: ReadonlySet<string>;
  /** Scans the page shows without a place: those before pickup, filed under the depot that will collect. */
  readonly placeless: ReadonlySet<string>;
  /** The page's name for the depot a scan names, or '' for none. */
  readonly place: (name: string, heading: string) => string;
  readonly stage: (code: string, heading: string) => ClassifiedWording | null;
  /** The zone of every depot's wall clock, when the network keeps one. */
  readonly zone?: string;
  /** Whether the page names the parcel's Priority or Economy service. */
  readonly priority: boolean;
  /** What else the page asks of a reply before it shows the delivery estimate. */
  readonly showsEstimate: (result: Record<string, unknown>, rows: readonly unknown[]) => boolean;
  /** The partner and its number for a parcel the reply marks as handed on, when the network reads them. */
  readonly handoff?: (result: Record<string, unknown>) => Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'>;
}

// The page hides the label's own record and an internal scan, and shows no
// place for scans before pickup.
const AUSTRALIA: AramexNetwork = {
  provider: PROVIDER,
  sscc: true,
  hidden: new Set(['PP0', 'IOC']),
  placeless: new Set(['ARP', 'PP0', 'PP2', 'PP3', 'PP4', 'PP5', 'PP7', 'PP8']),
  place: (name, heading) => {
    // The page renames the regional linehaul partner's depot.
    if (name === 'Linehaul Express Australia') return 'Aramex Regional Network';
    // The page leaves out this depot's name on a delivery.
    return name === 'Devonport' && heading.includes('Delivered') ? '' : name;
  },
  stage: aramexAuStage,
  priority: true,
  // Never once a `PP5` label scan is in the history.
  showsEstimate: (_result, rows) => !rows.some((row) => isRecord(row) && row.Status === 'PP5'),
};

/** A number as the network's tracker looks it up: upper case, without spaces or dashes. */
export function normalizeAramexNumber(raw: string, network: AramexNetwork): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (LABEL.test(number) || (network.sscc && SSCC.test(number) && isValidSscc(number))) return number;
  throw new InvalidInputError(network.provider,
    `${network.provider} tracks a twelve-character label${network.sscc ? ' or the SSCC on the parcel' : ''}`);
}

/** A number as the tracker looks it up: upper case, without spaces or dashes. */
export function normalizeAramexAuNumber(raw: string): string {
  return normalizeAramexNumber(raw, AUSTRALIA);
}

/** An optional text field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, provider: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A `YYYY-MM-DD HH:mm:ss` reading as an ISO wall clock, checked field by field. */
function wallOf(value: string): string | null {
  const match = WALL_CLOCK.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  // Luxon accepts hour 24.
  if (!calendarDay(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/** A `dd/mm/yyyy` day as `YYYY-MM-DD`, or null. */
function dayOf(value: string): string | null {
  const match = DAY.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** The scan's place: the depot it was made at, as the page names it. */
function placeOf(row: Record<string, unknown>, code: string, heading: string, network: AramexNetwork): string {
  if (network.placeless.has(code)) return '';
  const name = network.place(text(row, 'Name', network.provider, 100), heading);
  return /\d/.test(name) ? '' : name;
}

/**
 * One scan: its heading, the depot, the code and the wall clock the depot
 * recorded, read in `zone` when the network keeps one. The scan's longer
 * explanation, the signatory, the courier's id and the collection point's
 * address are never read.
 */
function eventOf(row: unknown, network: AramexNetwork, zone: string | null): CarrierEvent | null {
  const { provider } = network;
  if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
  const rawCode = text(row, 'Status', provider, 16).toUpperCase();
  const code = CODE.test(rawCode) ? rawCode : '';
  if (network.hidden.has(code)) return null;
  const description = text(row, 'Description', provider, 200);
  const local = wallOf(text(row, 'RealDateTime', provider, 40));
  if (!description || !local) throw new SchemaError(provider, `${provider} returned a scan without its heading or clock`);
  const location = placeOf(row, code, description, network);
  const staged = network.stage(code, description);
  const clock = zone ? { time: firstOccurrence(DateTime.fromISO(local, { zone })).toISO({ suppressMilliseconds: true })! } : { local_time: local };
  return { ...clock, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/**
 * The delivery day the page shows: only while the parcel moves between pickup
 * and the delivering courier, and before that day has passed at the pickup
 * depot.
 */
function etaOf(result: Record<string, unknown>, newest: CarrierEvent, rows: readonly unknown[], network: AramexNetwork): string | null {
  if (newest.stage !== 'accepted' && newest.stage !== 'in_transit') return null;
  if (!text(result, 'DeliveryFranchiseCode', network.provider, 16) || !network.showsEstimate(result, rows)) return null;
  const eta = dayOf(text(result, 'DeliveryETADate', network.provider, 16));
  const today = dayOf(text(result, 'PickupFranchiseCurrentDate', network.provider, 16));
  return eta && (!today || today <= eta) ? eta : null;
}

/**
 * The reply of `GET /umbraco/api/TrackingApi/GetTrackingData` for one number
 * on one network's host: the depots that collect and deliver the parcel with
 * their own date, the label, its scans oldest first and the delivery estimate.
 * A number the tracker has no scans for, unknown or only labelled, gets an
 * error naming it. The signatory, the delivery instructions, the sender's
 * reference and the collection point's details are never read.
 */
export function parseAramex(payload: unknown, raw: string, network: AramexNetwork): CarrierResult {
  const { provider } = network;
  const number = normalizeAramexNumber(raw, network);
  if (!isRecord(payload)) throw new SchemaError(provider, `${provider} returned an unexpected reply`);
  if (payload.error !== undefined && payload.error !== null) {
    const error = typeof payload.error === 'string' ? payload.error.slice(0, 500) : '';
    if (error === `Label '${number}' does not have any scans.`) throw new NotFoundError(provider);
    if (/^Label '.*' does not have any scans\.$/s.test(error)) throw new SchemaError(provider, `${provider} answered for another number`);
    throw new IndeterminateError(provider, `${provider} refused the tracking request`);
  }
  const result = payload.result;
  if (!isRecord(result)) throw new SchemaError(provider, `${provider} returned a reply without its parcel`);
  if (normalizeTrackingNumber(text(result, 'LabelNumber', provider, 64)) !== number) {
    throw new SchemaError(provider, `${provider} answered for another number`);
  }
  const rows = result.Scans ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an invalid parcel history`);
  // A parcel coming from abroad can carry scans on other clocks.
  const zone = network.zone && result.IsInternationalJourney === false ? network.zone : null;
  // Oldest first, as the page receives them; it shows them the other way round.
  const events = rows.map((row) => eventOf(row, network, zone)).filter((event): event is CarrierEvent => event !== null).reverse();
  if (!events.length) throw new NoHistoryError(provider);

  const newest = events[0]!;
  // A label notice after pickup is no step back.
  const current = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const original = network.sscc ? normalizeTrackingNumber(text(result, 'OriginalLabelNumber', provider, 64)) : number;
  const priority = network.priority ? result.IsPriorityParcel : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time! }),
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    expected_delivery: etaOf(result, newest, rows, network),
    ...(typeof priority === 'boolean' ? { service_name: priority ? 'Priority Delivery' : 'Economy Delivery' } : {}),
    ...network.handoff?.(result),
    // Asked by its SSCC, the parcel keeps Aramex's own label.
    ...(original !== number && LABEL.test(original) ? { canonical_tracking_number: original } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The reply of Aramex Australia's tracking service for one number. */
export function parseAramexAu(payload: unknown, raw: string): CarrierResult {
  return parseAramex(payload, raw, AUSTRALIA);
}
