import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cjBranch } from '../cj-logistics/parser.js';
import { cjStage } from '../cj-logistics/status.js';
import { gsPostboxStage } from './status.js';

export const PROVIDER = 'GS Postbox';
// A page with a long history is under twenty kilobytes.
export const GS_POSTBOX_MAX_BYTES = 256 * 1024;
// The tracking page's own check: digits only, at most thirteen; its older form asked for ten or more.
const NUMBER = /^\d{10,13}$/;
// The data the page renders, which the server writes on one line of its script.
const DATA = /^\s*var trackingInfo = (\{.*\});\s*$/m;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|AwsWafIntegration|awswaf\.com|captcha/i;
// The page's codes: a parcel it shows, and a number it has no record of.
const FOUND = 200;
const UNKNOWN = 100;
// GS Networks carries half-price parcels itself; CJ Logistics carries home delivery.
const OWN_NETWORK = 'GS_NETWORKS';
const CJ_NETWORK = 'DAEHAN_EXPRESS';
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
// Every scan of those two networks is made in a store, a centre or a branch in Korea.
const ZONE = 'Asia/Seoul';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Scans that leave a delivery standing when they are recorded after it.
const BEFORE_DELIVERY = new Set<Stage>(['accepted', 'in_transit', 'out_for_delivery']);

/** A number for GS Postbox's tracker; anything but ten to thirteen digits is not one it issues. */
export function normalizeGsPostboxNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GS Postbox numbers are ten to thirteen digits');
  return number;
}

/** A required text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GS Postbox returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The data the page renders for the number in its address, without running its scripts. */
function pageData(page: string): Record<string, unknown> {
  const match = DATA.exec(page);
  if (!match) {
    if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GS Postbox answered with a browser check');
    throw new SchemaError(PROVIDER, 'GS Postbox returned a page without its tracking data');
  }
  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'GS Postbox returned tracking data that is not JSON', { cause });
  }
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'GS Postbox returned invalid tracking data');
  return data;
}

/**
 * A scan's `transTime`, the wall clock to the second with no zone. Scans of
 * GS Networks and CJ Logistics are read on Korean time; another network's
 * keep their wall clock.
 */
function scanClock(row: Record<string, unknown>, korean: boolean): { time: string } | { local_time: string } {
  const value = text(row, 'transTime', 32);
  // Parsing in UTC checks the calendar digits only; Luxon would roll 24:00 over to the next day.
  const valid = CLOCK.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") === value;
  if (!valid) throw new SchemaError(PROVIDER, 'GS Postbox returned an invalid scan time');
  if (!korean) return { local_time: value };
  const parsed = zonedTime(value, "yyyy-MM-dd'T'HH:mm:ss", ZONE);
  if (!parsed) throw new SchemaError(PROVIDER, 'GS Postbox returned an invalid scan time');
  return { time: parsed.iso };
}

interface Network {
  /** The catalog carrier that carries the parcel under the same number, when not GS Networks. */
  partner: string | undefined;
  korean: boolean;
  stage: (code: string, wording: string) => ClassifiedWording | null;
  place: (name: string) => string;
}

function networkOf(type: string, name: string): Network {
  // CJ Logistics' scans keep its codes and branch names, as on its own tracker.
  if (type === CJ_NETWORK) return { partner: 'cj-logistics', korean: true, stage: cjStage, place: cjBranch };
  const own = type === OWN_NETWORK;
  const named = own ? undefined : carrierIdFromPartner(name);
  return { partner: named === 'gs-postbox' ? undefined : named, korean: own, stage: gsPostboxStage, place: (place) => place };
}

function projectRow(row: Record<string, unknown>, network: Network): { key: string; clock: string; event: CarrierEvent } {
  const code = text(row, 'transCode', 16).toUpperCase();
  const description = text(row, 'transKind');
  if (!description) throw new SchemaError(PROVIDER, 'GS Postbox returned a scan without wording');
  const clock = scanClock(row, network.korean);
  const location = network.place(text(row, 'transWhere', 120));
  const staged = network.stage(code, description);
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock, code, description, location]), clock: String(row.transTime), event };
}

/**
 * The store the parcel waits at: where it arrived for collection, when that is
 * its last movement and nothing but the collection followed.
 */
function pickupPoint(events: readonly CarrierEvent[], stage: Stage | undefined): string | null {
  if (stage !== 'ready_for_pickup' && stage !== 'delivered') return null;
  const moved = events.find((event) => event.stage && event.stage !== 'delivered');
  return moved?.stage === 'ready_for_pickup' && moved.location ? moved.location : null;
}

/**
 * The tracking page `GET /invoice/tracking.do?invoice_no=` renders for one
 * number. Its script holds `trackingInfo`: the page's code, the number, the
 * service, the network that carries the parcel and its scans, oldest first.
 * Code 100 is a number the tracker has no record of; any other code but 200
 * is a parcel the page cannot show. The sender, the recipient and the goods
 * are not read.
 */
export function parseGsPostboxPage(page: string, raw: string): CarrierResult {
  const number = normalizeGsPostboxNumber(raw);
  const data = pageData(page);
  if (typeof data.code !== 'number') throw new SchemaError(PROVIDER, 'GS Postbox returned tracking data without its code');
  if (typeof data.invoiceNo !== 'string') throw new SchemaError(PROVIDER, 'GS Postbox returned tracking data without its number');
  if (normalizeTrackingNumber(data.invoiceNo) !== number) throw new IndeterminateError(PROVIDER, 'GS Postbox answered for another number');
  if (data.code === UNKNOWN) throw new NotFoundError(PROVIDER);
  if (data.code !== FOUND) throw new IndeterminateError(PROVIDER, 'GS Postbox did not complete the lookup');
  const rows = data.trackingDetails;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'GS Postbox returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GS Postbox returned an oversized history');
  const network = networkOf(text(data, 'carrierType', 40), clean(data.carrierName, 40));

  const seen = new Set<string>();
  const scans: { clock: string; index: number; event: CarrierEvent }[] = [];
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GS Postbox returned an invalid scan');
    const scan = projectRow(row, network);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push({ clock: scan.clock, index, event: scan.event });
  });
  // The page shows the record of a parcel without scans as having no delivery status yet.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; on equal clocks, the later row first.
  scans.sort((left, right) => (left.clock < right.clock ? 1 : left.clock > right.clock ? -1 : right.index - left.index));
  const events = scans.map(({ event }) => event);

  const staged = events.filter((event) => event.stage);
  const delivery = staged.find((event) => event.stage === 'delivered');
  // A scan of an earlier step recorded after the delivery leaves the delivery standing.
  const current = delivery && BEFORE_DELIVERY.has(staged[0]!.stage as Stage) ? delivery : staged[0] ?? events[0]!;
  const stage = current.stage as Stage | undefined;
  const service = clean(data.serviceName, 40);
  const pickup = pickupPoint(events, stage);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.stage_source ?? 'carrier_map' } : {}),
    last_status_text: current.description!,
    last_update: current.time ?? null,
    ...(current.local_time ? { last_update_local: current.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current.time ? { delivered_at: current.time } : {}),
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(service ? { service_name: service } : {}),
    ...(network.partner ? { delivery_carrier: network.partner } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
