import { DateTime, IANAZone } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { WINIT_TABS, winitStage, winitTabStage } from './status.js';

export const PROVIDER = 'WINIT';
// A long history is a few dozen kilobytes.
export const WINIT_MAX_BYTES = 1024 * 1024;
// WINIT's order numbers: WO and ten to fourteen digits, with the package's
// letter or a two-letter suffix, and the older ID numbers.
const NUMBER = /^(?:ID\d{14}[A-Z]{2}|WO\d{10,14}[A-Z]{0,2})$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// A partner's scan can carry its offset from UTC instead of a zone.
const FIXED_OFFSET = /^(?:GMT|UTC)\s*([+-])(\d{1,2}):?(\d{2})$/i;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
// A US state with its ZIP code, as a partner names the town of a scan: the state stays.
const STATE_ZIP = /\b([A-Z]{2})[ ,;]+\d{5}(?:-\d{4})?\b/g;
// British and Canadian postcodes, and the four- or five-digit ones of other countries.
const POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|[A-Z]\d[A-Z] ?\d[A-Z]\d|\d{4,5})\b/g;
// Who took a delivered parcel, after the delivery's own words.
const RECEIVER = /\s*[,;:.\-–]\s*(?:signed(?: for)? by|signatory|received by|left with)\b[\s\S]*$/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// UTF-8 bytes read one by one as Latin-1, as some relayed UPS wording arrives ("Pointâ\u0084¢" for "Point™").
const MISREAD_UTF8 = /[Â-ô][\u0080-¿]{1,3}/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A WINIT order or package number, in capitals; anything else is a number WINIT's tracker is not asked for. */
export function normalizeWinitNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'WINIT numbers are WO and ten to fourteen digits, or ID, fourteen digits and two letters');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `WINIT returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** Wording whose UTF-8 was read as Latin-1, put right; anything else stays as it is. */
function repairMisreadUtf8(value: string): string {
  return value.replace(MISREAD_UTF8, (run) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(run, (char) => char.charCodeAt(0)));
    } catch {
      return run;
    }
  });
}

/**
 * A scan's wording: WINIT's English, else its Chinese, without phone
 * numbers, e-mail addresses or the name of whoever took the parcel. The
 * tracker shows the English as HTML.
 */
export function winitWording(row: Record<string, unknown>): string {
  const raw = textFromHtml(text(row, 'eventDescription', 2000), 1000) || textFromHtml(text(row, 'eventStatus', 1000), 1000);
  return clean(repairMisreadUtf8(raw).replace(RECEIVER, '').replace(EMAIL, '').replace(PHONE, '')
    .replace(/\s+([,，;；.。])/g, '$1'), 300).replace(/^[\s,，;；:]+|[\s,，;；:\-–]+$/g, '');
}

/** A partner's place for a scan, without the postcode it can carry, which can be the recipient's. */
function placeOf(location: string, partner: boolean): string {
  if (!partner) return location;
  return clean(location.replace(STATE_ZIP, '$1').replace(POSTCODE, ''), 120).replace(/^[\s,;-]+|[\s,;-]+$/g, '');
}

/**
 * A scan's clock. A partner's offset from UTC places its wall clock. A WINIT
 * warehouse scan carries the warehouse's zone, which places it too. A
 * partner's scan labelled with a zone keeps its wall clock: the label is the
 * warehouse's, also on scans in another country or zone.
 */
function clockOf(row: Record<string, unknown>, partner: boolean): { time: string } | { local_time: string } {
  const wall = WALL_CLOCK.exec(text(row, 'date', 32));
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  // Parsing in UTC checks the calendar digits only.
  const checked = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'WINIT returned an invalid scan time');
  }
  const label = text(row, 'timeZone', 64);
  const offset = FIXED_OFFSET.exec(label);
  if (offset && Number(offset[2]) <= 14 && Number(offset[3]) < 60) {
    const placed = DateTime.fromISO(`${local}${offset[1]}${offset[2]!.padStart(2, '0')}:${offset[3]}`, { setZone: true });
    if (placed.isValid) return { time: placed.toISO({ suppressMilliseconds: true }) };
  }
  if (!partner && label && IANAZone.isValidZone(label)) {
    const placed = firstOccurrence(DateTime.fromISO(local, { zone: label }));
    // A clock in the hour a change to summer time skips names no instant.
    if (placed.isValid && placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local) return { time: placed.toISO({ suppressMilliseconds: true }) };
  }
  return { local_time: local };
}

function projectRow(row: unknown): { key: string; event: CarrierEvent } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'WINIT returned an invalid scan');
  const description = winitWording(row);
  if (!description) return null;
  // S rows are WINIT's own scans; V rows are the partner's, relayed.
  const partner = text(row, 'type', 4).toUpperCase() !== 'S';
  const clock = clockOf(row, partner);
  const location = placeOf(text(row, 'location', 200), partner);
  const rawCode = text(row, 'eventCode', 32).toUpperCase();
  // The partner's codes are its own; only WINIT's are the scan's code here.
  const code = !partner && /^[A-Z0-9_-]{1,16}$/.test(rawCode) ? rawCode : null;
  const staged = winitStage(code, description);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock, description, location, code]), event };
}

/**
 * The partner's number, and the partner when the reply names one the catalog
 * knows whose rules take the number. A USPS routing barcode gives its
 * package identifier.
 */
function handoff(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  // The tracker links an untracked service's parcel to nothing.
  if (text(shipment, 'isTracked', 4).toUpperCase() !== 'Y') return {};
  const compact = normalizeTrackingNumber(text(shipment, 'trackingNo', 64)).toUpperCase();
  const reference = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number || NUMBER.test(reference)) return {};
  const name = text(shipment, 'standardCarrier', 80) || text(shipment, 'vendorName', 80) || text(shipment, 'carrierCode', 80);
  const partner = name ? carrierIdFromPartner(name, text(shipment, 'trackingUrl', 500)) : undefined;
  const named = partner && partner !== 'winit' && (detectCarrierMatch(reference).candidates as string[]).includes(partner);
  return { ...(named ? { delivery_carrier: partner } : {}), delivery_tracking_number: reference };
}

/** The tracker's tab for the shipment: the list that holds it, else its icon. */
function tabOf(data: Record<string, unknown>, shipment: Record<string, unknown>): string | undefined {
  const order = text(shipment, 'orderNo', 64);
  const listed = order && WINIT_TABS.find((tab) => Array.isArray(data[tab]) && (data[tab] as unknown[]).slice(0, MAX_ROWS)
    .some((row) => isRecord(row) && typeof row.orderNo === 'string' && row.orderNo === order));
  return listed || /^t-(\w{1,32})$/.exec(text(shipment, 'statusIcon', 40))?.[1];
}

/**
 * The shipment's stage: its tab where that says more than the scans. A
 * partner's scan of a parcel at a pickup point or on its way back is more
 * precise than the Delivered or Alert tab.
 */
function currentStage(tab: Stage | undefined, scanned: Stage | undefined): Stage | undefined {
  if (!tab || scanned === 'returned' || scanned === 'ready_for_pickup') return scanned ?? tab;
  return tab;
}

/**
 * The reply of the tracker's `getTracking` lookup for one number. The
 * lookup finds a shipment by its package number, its order number or its
 * partner's number, and lists a number it does not know with `findNoBl` N.
 * Each shipment counts only when its own package or order number is the one
 * asked; an order with several packages names no single parcel. Staff
 * logins, the recipient's town and postcode, and proof of delivery are not
 * read.
 */
export function parseWinit(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWinitNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'number') throw new SchemaError(PROVIDER, 'WINIT returned an invalid envelope');
  if (payload.status !== 1) throw new IndeterminateError(PROVIDER, 'WINIT did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.all)) throw new SchemaError(PROVIDER, 'WINIT returned a reply without its shipments');
  if (data.all.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'WINIT returned too many shipments');
  const rows = data.all.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'WINIT returned an invalid shipment');
    return row;
  });
  const own = (row: Record<string, unknown>) => [text(row, 'orderNo', 64), text(row, 'masterOrderNo', 64), text(row, 'trackingNo', 64)]
    .some((value) => value.toUpperCase() === number);
  const shipments = rows.filter((row) => !('unfindNo' in row) && own(row));
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'WINIT found several parcels for the number', { reason: 'several_parcels' });
  const shipment = shipments[0];
  if (!shipment) {
    if (rows.some((row) => text(row, 'unfindNo', 64).toUpperCase() === number && text(row, 'findNoBl', 4).toUpperCase() === 'N')) {
      throw new NotFoundError(PROVIDER);
    }
    throw new IndeterminateError(PROVIDER, 'WINIT answered for another number');
  }
  const trace = shipment.trace;
  if (trace !== null && trace !== undefined && !Array.isArray(trace)) throw new SchemaError(PROVIDER, 'WINIT returned a shipment with invalid scans');
  const list = (trace ?? []) as unknown[];
  if (list.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'WINIT returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  // The reply lists the scans oldest first; the result keeps the newest first.
  for (const row of [...list].reverse()) {
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const latest = events.find((event) => event.stage);
  const scanned = latest?.stage as Stage | undefined;
  const tabbed = winitTabStage(tabOf(data, shipment));
  const stage = currentStage(tabbed, scanned);
  const source = stage && stage !== scanned ? 'carrier_map' : latest?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const day = DAY.exec(text(shipment, 'estimateDeliveredTime', 32))?.[1];
  const eta = day && stage !== 'delivered' && stage !== 'returned' && DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
  const destination = text(shipment, 'destination', 80);
  const country = destination ? countryCode(destination) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: eta,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...handoff(shipment, number),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
