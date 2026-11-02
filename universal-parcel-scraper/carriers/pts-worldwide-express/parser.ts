import { DateTime } from 'luxon';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { ptsStage, ptsSummary } from './status.js';

export const PROVIDER = 'PTS Worldwide Express';
export const CARRIER = 'pts-worldwide-express';
// A long history is under twenty kilobytes.
export const PTS_MAX_BYTES = 512 * 1024;
// The zone PTS's pages show every scan in.
const ZONE = 'Europe/Istanbul';
// Its waybills, and the fourteen-digit numbers starting 9001 seen on one shipper's parcels.
const NUMBER = /^(?:\d{10}|9001\d{10})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CODE = /^[0-9A-Z]{1,8}$/;
// A place the reply leaves empty with a dash.
const NO_PLACE = /^-*$/;
const MAX_ROWS = 300;

/** A number PTS's tracker takes, without spaces; anything else is not one it issues. */
export function normalizePtsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PTS numbers are ten digits, or fourteen digits starting 9001');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PTS returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock as PTS's pages show it, in Istanbul. The reply gives each
 * scan an offset, but the scans it relays from partners abroad are their wall
 * clocks stored as Istanbul's, so no scan keeps an instant.
 */
function wallClock(value: string): string {
  const at = INSTANT.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  if (!at?.isValid) throw new SchemaError(PROVIDER, 'PTS returned an invalid scan time');
  return at.setZone(ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function scan(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PTS returned an invalid scan');
  const description = text(row, 'statusText', 300);
  if (!description) throw new SchemaError(PROVIDER, 'PTS returned a scan without wording');
  const code = text(row, 'statusCode', 16).toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'PTS returned an invalid status code');
  const local = wallClock(text(row, 'statusDate', 40));
  const place = text(row, 'location', 120);
  const location = NO_PLACE.test(place) ? '' : place;
  const staged = ptsStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description.toLowerCase(), location]), event };
}

/** A partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(raw: string): string {
  const compact = normalizeTrackingNumber(raw).toUpperCase();
  const reference = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return /^[A-Z0-9]{4,40}$/.test(reference) ? reference : '';
}

/**
 * Whether the number has the partner's shape: one of the partner's detection
 * rules offers it or, for a partner whose rules claim no shape at all, such as
 * HepsiJET, which tracks its merchants' own codes, the partner's own tracking
 * link in the reply opens that number.
 */
function partnerShape(partner: string, reference: string, link: string): boolean {
  if ((detectCarrierMatch(reference).candidates as string[]).includes(partner)) return true;
  if (CARRIER_DEFINITIONS[partner as CarrierId]?.detectionRules.length !== 0) return false;
  const linked = parseTrackingInput(link);
  return linked.source === 'link' && linked.carrier === partner && linked.trackingNumber === reference;
}

/**
 * The carrier that delivers in the destination country and its number. The
 * partner is named when its name and link give one catalog carrier whose shape
 * the number has; the number stays without a partner otherwise. Its link is
 * never followed.
 */
function partner(shipment: Record<string, unknown>, own: readonly string[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = partnerNumber(text(shipment, 'lastMileAgentTrackingNumber', 64));
  if (!reference) return {};
  const link = text(shipment, 'lastMileAgentTrackingUrl', 500);
  const carrier = carrierIdFromPartner(text(shipment, 'lastMileAgentName', 80), link);
  const named = carrier && carrier !== CARRIER && partnerShape(carrier, reference, link);
  return {
    ...(named ? { delivery_carrier: carrier } : {}),
    // The number asked or PTS's own is no second reference.
    ...(own.includes(reference) ? {} : { delivery_tracking_number: reference }),
  };
}

/** The destination as an ISO code. */
function destination(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country'> {
  const country = countryCode(text(shipment, 'destinationCountryCode', 8));
  return country ? { destination_country: country } : {};
}

/**
 * The reply of `tracking-api.pts.net/tracking` for one number, the lookup
 * PTS's tracking page at tracking.pts.net makes: `response` with the
 * shipment, or `errors` with the code `T404` for a number it does not know.
 * The shipment must be PTS's number asked or, for a parcel its partner
 * delivers under the number asked, carry that number as the partner's.
 */
export function parsePts(payload: unknown, raw: string): CarrierResult {
  const number = normalizePtsNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'PTS returned an invalid envelope');
  const shipment = payload.response;
  if (!isRecord(shipment)) {
    if (!Array.isArray(payload.errors)) throw new SchemaError(PROVIDER, 'PTS returned an invalid envelope');
    const codes = payload.errors.map((error) => (isRecord(error) ? clean(error.code, 16) : ''));
    if (codes.length === 1 && codes[0] === 'T404') throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'PTS did not complete the lookup');
  }
  const own = text(shipment, 'ptsNo', 64).toUpperCase();
  if (!own) throw new SchemaError(PROVIDER, 'PTS returned a shipment without its number');
  const alias = own !== number && partnerNumber(text(shipment, 'lastMileAgentTrackingNumber', 64)) === number;
  if (own !== number && !alias) throw new IndeterminateError(PROVIDER, 'PTS answered for another shipment');

  const rows: unknown = shipment.trackingHistory ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'PTS returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PTS returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  // The reply lists the scans oldest first; the result has them newest first.
  for (const row of [...(rows as unknown[])].reverse()) {
    const { key, event } = scan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }

  const summary = ptsSummary(text(shipment, 'status', 40));
  const facts = {
    ...destination(shipment),
    ...partner(shipment, [number, own]),
    // A parcel asked by its partner's number has PTS's own, as the page shows it.
    ...(alias && NUMBER.test(own) ? { canonical_tracking_number: own } : {}),
  };
  if (!events.length) {
    // A parcel its partner delivers can have no scans of PTS's: the page shows its status alone.
    if (!summary) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(summary.stage),
      current_stage: summary.stage,
      current_stage_source: 'carrier_map',
      last_status_text: summary.label,
      provider_code: summary.code,
      last_update: null,
      expected_delivery: null,
      ...facts,
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = (scanned?.stage ?? summary?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...facts,
    events,
  };
}
