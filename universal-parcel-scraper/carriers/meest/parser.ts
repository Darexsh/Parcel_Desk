import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { CODE, meestStage } from './status.js';

export const PROVIDER = 'Meest';
// A long history is some tens of kilobytes.
export const MEEST_MAX_BYTES = 1_000_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 200;
// The tracker's clock, a wall time without an offset: "2026-01-10 19:27:14".
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// The page drops these two clocks as a day without a time.
const DAY_ONLY = new Set(['00:00:00', '00:00:01']);
// The page hides delivery attempts that could not confirm the recipient's details.
const HIDDEN_CODE = '1628';
// A partner feed's note of the final-mile carrier: "Delivery by BOXNOW with barcode 0000000000".
const PARTNER = /\b(?:to be delivered to|delivery by)\s+([A-Za-z][A-Za-z0-9 .&'-]{1,40}?)(?:\s+with barcode\s+([A-Z0-9]{4,40}))?\s*\.?$/i;

/**
 * Meest's tracker looks up its own numbers, the numbers other posts and the
 * sender gave a parcel and its partners' references, of many shapes. It takes
 * letters and digits only.
 */
export function normalizeMeestNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^[A-Z0-9]{6,40}$/.test(number) && /\d/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Meest tracks numbers of six to forty letters and digits');
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter(child => child.name === name && !child.uri);
}

function one(node: XmlNode, name: string): XmlNode {
  const found = children(node, name);
  if (found.length !== 1) throw new SchemaError(PROVIDER, `Meest returned a reply without one ${name}`);
  return found[0]!;
}

/** A field's text. A field the row lacks, or one with markup inside, is no text. */
function field(row: XmlNode, name: string): string {
  const found = children(row, name);
  if (found.length > 1 || found[0]?.children.length) throw new SchemaError(PROVIDER, `Meest returned a scan with a malformed ${name}`);
  return found[0]?.text ?? '';
}

/** Wording the page writes as HTML, with its escaped tags. */
function wording(row: XmlNode, ...names: string[]): string {
  for (const name of names) {
    const text = textFromHtml(field(row, name).replace(/&lt;/g, '<').replace(/&gt;/g, '>'), 300);
    if (text) return text;
  }
  return '';
}

/** A clock as a wall time, or a day when the page shows it without a time. The reply gives no offset. */
function wallClock(value: string): string | null {
  const match = CLOCK.exec(clean(value, 32));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (!calendarDay(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const date = `${year}-${month}-${day}`;
  return DAY_ONLY.has(`${hour}:${minute}:${second}`) ? date : `${date}T${hour}:${minute}:${second}`;
}

interface Row {
  readonly index: number;
  readonly local: string;
  readonly code: string;
  readonly description: string;
  readonly location: string;
  /** The parcel's own numbers on the row: Meest's, the sender's and the label's. */
  readonly own: readonly string[];
  readonly transit: string;
  readonly destination: string;
  readonly hidden: boolean;
}

function rowOf(item: XmlNode, index: number): Row {
  const local = wallClock(field(item, 'DateTimeAction'));
  const code = clean(field(item, 'StatusCode'), 8);
  if (!local || !CODE.test(code)) throw new SchemaError(PROVIDER, 'Meest returned a scan without its clock or code');
  const description = wording(item, 'ActionMessages_EN', 'ActionMessages', 'ActionMessages_RU');
  const city = clean(field(item, 'City_EN'), 80) || clean(field(item, 'City'), 80);
  const country = clean(field(item, 'Country_EN'), 80) || clean(field(item, 'Country'), 80);
  return {
    index,
    local,
    code,
    description,
    location: [city, country].filter(Boolean).join(', '),
    own: ['ShipmentNumber', 'ShipmentNumberSender', 'Barcode'].map(name => returnedTrackingNumber(field(item, name))),
    transit: returnedTrackingNumber(field(item, 'ShipmentNumberTransit')),
    destination: clean(field(item, 'CountryDel'), 8),
    // The page hides these, and the Chinese consolidator's own registration before Meest's.
    hidden: code === HIDDEN_CODE || (clean(field(item, 'AgentCode'), 40) === 'MCHINA' && field(item, 'ActionMessages').trim() === 'Зареєстровано'),
  };
}

function eventOf(row: Row): CarrierEvent {
  const stage = meestStage(row.code);
  return { local_time: row.local, ...(row.description ? { description: row.description } : {}),
    ...(row.location ? { location: row.location } : {}), provider_code: row.code,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/** The final-mile partner a partner feed names, newest first, and the number it gave the parcel. */
function partnerOf(rows: readonly Row[], number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const row of rows) {
    const match = PARTNER.exec(row.description);
    const partner = match && carrierIdFromPartner(match[1]!.trim());
    if (!partner || partner === 'meest') continue;
    const reference = match[2] ?? row.transit;
    const theirs = /^[A-Z0-9]{4,40}$/.test(reference) && reference !== number && !row.own.includes(reference);
    return { delivery_carrier: partner, ...(theirs ? { delivery_tracking_number: reference } : {}) };
  }
  return {};
}

/** The destination country every row that names one gives. */
function destinationOf(rows: readonly Row[]): string | undefined {
  const named = new Set(rows.map(row => row.destination).filter(Boolean));
  const [country] = named;
  return named.size === 1 && /^[A-Z]{2}$/.test(country!) ? country : undefined;
}

/**
 * The XML reply of the tracker's `get.php?what=tracking` lookup: an `errors`
 * code (000 for a lookup that ran) and a `result_table` with every row that
 * names the number, oldest first. An empty table is a number Meest does not
 * know, or one whose history it no longer keeps. Each row carries the
 * parcel's numbers, its clock, place, code and wording in Ukrainian, English
 * and Russian, and Meest's own rows a pickup branch's details; only the clock,
 * the place, the code and the wording are read, and the destination country
 * and final-mile partner a partner feed names.
 */
export function parseMeest(xml: string, raw: string): CarrierResult {
  const number = normalizeMeestNumber(raw);
  const root = xmlDocument(xml, MEEST_MAX_BYTES);
  if (!root || root.name !== 'return') throw new SchemaError(PROVIDER, 'Meest returned an unexpected tracking reply');
  const code = clean(one(one(root, 'errors'), 'code').text, 8);
  if (!/^\d{1,6}$/.test(code)) throw new SchemaError(PROVIDER, 'Meest returned a reply without its result code');
  if (code !== '000') throw new IndeterminateError(PROVIDER, `Meest's tracker answered with error ${code}`);
  const table = one(root, 'result_table');
  const items = children(table, 'items');
  if (items.length !== table.children.length || items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Meest returned an invalid tracking table');
  if (!items.length) throw new NotFoundError(PROVIDER);

  const rows = items.map(rowOf);
  // The tracker answers every row that names the number, a partner's reference included.
  if (!rows.every(row => row.own.includes(number) || row.transit === number)) {
    throw new SchemaError(PROVIDER, 'Meest answered for a different parcel');
  }
  // A number Meest notes only as a partner's or an earlier leg's reference
  // brings that partner's rows, not the parcel's history.
  if (!rows.some(row => row.own.includes(number))) {
    throw new IndeterminateError(PROVIDER, "Meest knows the number only as another carrier's reference");
  }
  const seen = new Set<string>();
  const shown = rows.filter(row => {
    if (row.hidden) return false;
    // Two feeds can report one scan twice.
    const identity = JSON.stringify([row.local, row.code, row.description, row.location]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (!shown.length) throw new NoHistoryError(PROVIDER);
  // Newest first; equal clocks keep the reverse of the reply's oldest-first order.
  shown.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : right.index - left.index));
  const events = shown.map(eventOf);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const destination = destinationOf(rows);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: null,
    last_update_local: String(newest.local_time),
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    ...partnerOf(shown, number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
