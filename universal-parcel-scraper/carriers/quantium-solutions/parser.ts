import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { isRecord } from '../../core/types.js';
import { quantiumStage } from './status.js';

export const PROVIDER = 'Quantium Solutions';
// A long history is a few kilobytes.
export const QUANTIUM_MAX_BYTES = 512 * 1024;
// Ten digits for Malaysian shipments, and the UPU S10 layout: UQ…TH for Thai
// ones, and Singapore Post's numbers for the parcels Quantium carries under them.
const NUMBER = /^(?:\d{10}|[A-Z]{2}\d{9}[A-Z]{2})$/;
// A wall clock to the second, sometimes with a fraction, and no zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;

/** A number Quantium's tracker takes, in capitals; anything else is not one it issues. */
export function normalizeQuantiumNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Quantium Solutions numbers are ten digits, or two letters, nine digits and two letters');
  }
  return number;
}

/** An optional text field; anything but a string or null is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Quantium returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The whole numbers a field holds; the page prints several on separate lines. */
function numbers(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string' || value.length > 1_000) throw new SchemaError(PROVIDER, `Quantium returned an invalid ${key}`);
  return value.split(/[\r\n,;]+/).map((part) => normalizeTrackingNumber(part.trim())).filter(Boolean);
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![\p{L}\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![\p{L}\d])/gu;
// Who took the parcel, after a delivery remark ("Delivered to …", "Received by …").
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:by|to|signed|received)\b[\s\S]*$/i;
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\d]+/gu, '');

/**
 * A scan's wording as the page shows it: the milestone, then the remark
 * after a colon when it says more, as "IN TRANSIT: Customs Clearance
 * Begins". A delivery remark loses a clause naming who took the parcel, and
 * both lose phone numbers.
 */
export function quantiumWording(milestone: string, remark: string): { milestone: string; remark: string; description: string } {
  const own = clean(milestone.replace(PHONE, ''), 200);
  let note = clean(remark.replace(PHONE, ''), 300);
  if (quantiumStage(own, note)?.stage === 'delivered') note = note.replace(RECEIVER, '');
  note = note.replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  if (!note) return { milestone: own, remark: '', description: own };
  if (!own) return { milestone: '', remark: note, description: note };
  return { milestone: own, remark: note, description: squash(own).includes(squash(note)) ? own : `${own}: ${note}` };
}

/**
 * A scan's clock: the wall clock of whoever scanned it, to the second. The
 * reply names no zone, and one history runs from the shipper's country to
 * the recipient's, whose partner relays its own local clocks, so the clock
 * stays local.
 */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const local = match?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Quantium returned an invalid scan time');
  }
  return local;
}

interface Row { milestone: string; remark: string; clock: string }

/** The child elements' text of one `<history>` element, by name. */
function xmlRow(node: XmlNode): Row {
  const field = (name: string) => {
    const children = node.children.filter((child) => child.name === name);
    if (children.length > 1 || children.some((child) => child.children.length)) throw new SchemaError(PROVIDER, `Quantium returned an invalid ${name}`);
    return children[0]?.text ?? '';
  };
  return { milestone: field('status_desc'), remark: field('remark'), clock: field('status_date') };
}

/**
 * The history: an XML string of `<history_list>` with one `<history>` per
 * scan, which the page turns into a list, or already a list.
 */
function historyRows(shipment: Record<string, unknown>): Row[] {
  const history = shipment.history;
  if (history === null || history === undefined || history === '') return [];
  if (Array.isArray(history)) {
    if (history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Quantium returned an oversized history');
    return history.map((row) => {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Quantium returned an invalid scan');
      return { milestone: text(row, 'status_desc', 400), remark: text(row, 'remark', 600), clock: text(row, 'status_date', 40) };
    });
  }
  if (typeof history !== 'string') throw new SchemaError(PROVIDER, 'Quantium returned an invalid history');
  const root = xmlDocument(history, QUANTIUM_MAX_BYTES);
  if (root?.name !== 'history_list' || root.children.some((child) => child.name !== 'history')) {
    throw new SchemaError(PROVIDER, 'Quantium returned an invalid history');
  }
  if (root.children.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Quantium returned an oversized history');
  return root.children.map(xmlRow);
}

function scan(row: Row): { key: string; event: CarrierEvent } {
  const local = wallClock(clean(row.clock, 40));
  const { milestone, remark, description } = quantiumWording(row.milestone, row.remark);
  if (!description) throw new SchemaError(PROVIDER, 'Quantium returned a scan without wording');
  const staged = quantiumStage(milestone, remark);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, description.toLowerCase()]), event };
}

/** The recipient's country as an ISO code, else as the page names it. */
function destination(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const name = text(shipment, 'cnee_country_name', 80);
  const country = countryCode(text(shipment, 'cnee_country', 8)) ?? countryCode(name);
  return country ? { destination_country: country } : name ? { destination_country_name: name } : {};
}

/**
 * The shipment the tracker found for the number: the one whose order number
 * is the number asked, else the one whose tracking number is, as the page
 * prints them. The lookup also matches by those tracking numbers.
 */
function shipmentFor(rows: unknown[], number: string): Record<string, unknown> {
  const shipments = rows.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Quantium returned an invalid shipment');
    return row;
  });
  const own = shipments.filter((shipment) => numbers(shipment, 'order_no').includes(number));
  const bound = own.length ? own : shipments.filter((shipment) => numbers(shipment, 'co_loader_track_no').includes(number));
  if (bound.length > 1) throw new IndeterminateError(PROVIDER, 'Quantium answered with several shipments for the number');
  if (!bound.length) throw new IndeterminateError(PROVIDER, 'Quantium answered for another shipment');
  return bound[0]!;
}

/**
 * The reply of the tracking page's `general_sql` lookup for one number: a
 * list of the shipments it found, empty for a number it does not know, which
 * the page shows as "No record!". The reply also holds the shipper's and the
 * recipient's addresses, which the page does not show; they are never read.
 */
export function parseQuantium(payload: unknown, raw: string): CarrierResult {
  const number = normalizeQuantiumNumber(raw);
  if (!Array.isArray(payload)) {
    // The service's own error: a message and an exception, which the page shows as a failure.
    if (isRecord(payload) && typeof payload.Message === 'string') throw new IndeterminateError(PROVIDER, 'Quantium did not complete the lookup');
    throw new SchemaError(PROVIDER, 'Quantium returned an invalid envelope');
  }
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Quantium returned too many shipments');
  const shipment = shipmentFor(payload, number);

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of historyRows(shipment)) {
    const { key, event } = scan(row);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  const facts = destination(shipment);
  if (!events.length) {
    // A shipment without scans still has the page's current status.
    const { milestone, description } = quantiumWording(text(shipment, 'status_desc', 400), '');
    const staged = description ? quantiumStage(milestone, '') : null;
    if (!staged) throw new NoHistoryError(PROVIDER);
    const clock = text(shipment, 'status_date', 40);
    return {
      status: languageStageStatus(staged.stage),
      current_stage: staged.stage,
      current_stage_source: staged.source,
      last_status_text: description,
      last_update: null,
      ...(clock ? { last_update_local: wallClock(clock) } : {}),
      expected_delivery: null,
      ...facts,
      summary_only: true,
      events: [],
    };
  }
  // Newest first, as the page lists them; an oldest-first reply is turned
  // round. The clocks of different countries are not sorted against each other.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...facts,
    events: newestFirst,
  };
}
