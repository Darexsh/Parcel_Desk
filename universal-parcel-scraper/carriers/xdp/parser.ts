import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, escapeRegExp } from '../../core/transport/index.js';
import { xdpStage } from './status.js';

export const PROVIDER = 'XDP';

// XDP prints consignment numbers such as ZDB, three letters and six digits;
// its tracker takes other letter-and-digit references too.
const NUMBER = /^(?=.*\d)[A-Z0-9]{8,20}$/;
// A leading zero printed before a ZDB consignment is not part of it: the tracker knows none with it.
const ZERO_PREFIXED = /^0(ZDB[A-Z]{3}\d{6})$/;
// The tracker's two notices: an unknown number or a wrong postcode, and a lookup without a postcode.
const ABSENT = 'Consignment not found for consignment number:';
const ASK_POSTCODE = 'Please confirm delivery or collection postcode for the consignment.';
const HEADER = ['Date/Time', 'Bar Code', 'Location', 'Status Type', 'Status Data'];
// "18 Jul 2024 11:19AM": a 24-hour clock with a meridiem that agrees with it.
const CLOCK = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2})(AM|PM)$/;
const TYPE = /^[A-Z][A-Z0-9 /&-]{0,39}$/;
// Messages XDP sent the recipient or the sender: they move nothing, and some name the recipient.
const MESSAGE = /(?:^|\s)(?:EMAIL|SMS)$|\bMESSAGE SENT$/;
// The scanning system's name around the status it reports: Spirit at the depots, DriverX and ScanX on the round.
const SYSTEM_STATUS = /^(?:Spirit|DriverX|ScanX) Status: "([^"]{1,200})"$/;
// Wording that goes on to name a person is cut before the name.
const PERSON = /\s+(?:sent to|signed by|signed for by|received by)\b.*$/i;
const LABELS = new Map([['CREATE', 'Order received'], ['PRINT', 'Label printed']]);
const WEIGHT = /^(\d{1,5}(?:\.\d{1,3})?)\s*KG$/i;
const SERVICE = /^[A-Z0-9][A-Z0-9 /&+-]{0,39}$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;

interface Row { local_time: string; type: string; description: string; index: number }

/** A consignment number as the tracker takes it: letters and digits, without a printed leading zero. */
export function normalizeXdpNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  const consignment = ZERO_PREFIXED.exec(number)?.[1] ?? number;
  if (!NUMBER.test(consignment)) throw new InvalidInputError(PROVIDER, 'XDP consignment numbers are 8 to 20 letters and digits');
  return consignment;
}

/** The delivery or collection postcode the tracker asks for with every consignment. */
export function normalizeXdpPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'the delivery postcode', 'XDP shows a consignment only with its delivery or collection postcode');
  if (!DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'XDP requires a valid delivery postcode');
  return postcode;
}

/** A row's date and clock as a wall time. The page gives no offset; its clocks are UK time. */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const hour = Number(match[4]);
  if (hour > 23 || (hour < 12) !== (match[6] === 'AM')) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${match[1]} ${match[2]} ${match[3]} ${match[4]}:${match[5]}`, 'd MMM yyyy HH:mm',
    { zone: 'UTC', locale: 'en-GB' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/** The text after one of the consignment block's labels, up to the next one. */
function labelled($: CheerioAPI, label: string): string {
  const found = $('#leftCol .xdp_content label').filter((_, node) => clean($(node).text(), 40) === label);
  if (found.length !== 1) return '';
  let text = '';
  for (let node = found[0]!.nextSibling; node && node.nodeType === 3; node = node.nextSibling) text += $(node).text();
  return clean(text, 80);
}

/** The notices beside the form, outside it. */
function notices($: CheerioAPI): string[] {
  return $('#leftCol .xdp_content > p').map((_, node) => clean($(node).text(), 300)).get().filter(Boolean);
}

/** Every barcode in a row names the requested consignment and a three-digit piece. */
function boundBarcodes(cell: string, number: string): boolean {
  if (!cell || /^all barcodes$/i.test(cell)) return true;
  const piece = new RegExp(`^${escapeRegExp(number)}\\d{3}$`);
  return cell.split(/[\s,]+/).filter(Boolean).every((code) => piece.test(code));
}

/** A row's wording: the system status without its system, a label for a bare type, no person's name. */
function wording(type: string, data: string): string {
  const reported = SYSTEM_STATUS.exec(data)?.[1] ?? data;
  const text = reported === '--' || !reported ? LABELS.get(type) ?? type : reported;
  const described = type === 'NEXT STOP' ? `Next stop: ${text}` : text;
  return described.replace(PERSON, '').trim();
}

/**
 * The legacy tracker's page for one consignment: its details and every scan,
 * newest first, each piece's scan on a row of its own. A consignment shows
 * only with its delivery or collection postcode, and an unknown number and a
 * wrong postcode get the same notice. The recipient's name, company and
 * postcode, the references, the depot and driver codes and the messages XDP
 * sent are never read.
 */
export function parseXdp(html: string, raw: string): CarrierResult {
  const number = normalizeXdpNumber(raw);
  const $ = load(html);
  // The date and its clock, and a consignment's pieces, sit on lines of their own.
  $('#leftCol br').replaceWith(' ');
  const field = $('form#trackform input#c');
  if (field.length !== 1) throw new IndeterminateError(PROVIDER, 'XDP did not return its tracking page');
  if (returnedTrackingNumber(field.attr('value')) !== number) {
    throw new SchemaError(PROVIDER, 'XDP answered for a different consignment');
  }

  const cells = $('#leftCol tr').toArray().map((tr) => $(tr).children('td'))
    .filter((tds) => tds.length === 5);
  if (!cells.length) {
    const shown = notices($);
    if (shown.length === 1 && shown[0]!.startsWith(ABSENT)
      && normalizeTrackingNumber(shown[0]!.slice(ABSENT.length)) === number) {
      throw new NotFoundError(PROVIDER, 'XDP knows no consignment with this number and postcode');
    }
    if (shown.length === 1 && shown[0] === ASK_POSTCODE) {
      throw new InputRequiredError(PROVIDER, 'the delivery postcode', 'XDP shows a consignment only with its delivery or collection postcode');
    }
    throw new IndeterminateError(PROVIDER, 'XDP did not return the consignment');
  }
  const header = cells[0]!.map((_, td) => clean($(td).text(), 40)).get();
  if (JSON.stringify(header) !== JSON.stringify(HEADER)) throw new SchemaError(PROVIDER, 'XDP consignment history changed');
  if (cells.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, 'XDP returned too many scans');

  const rows: Row[] = [];
  for (const [index, tds] of cells.slice(1).entries()) {
    const local = wallClock(clean($(tds[0]).text(), 40));
    if (!local) throw new SchemaError(PROVIDER, 'XDP returned an invalid scan time');
    const barcodes = clean($(tds[1]).text(), 2_000);
    if (!boundBarcodes(barcodes, number)) throw new SchemaError(PROVIDER, 'XDP answered for a different consignment');
    const type = clean($(tds[3]).text(), 60).toUpperCase();
    const data = clean($(tds[4]).text(), 300);
    if (!TYPE.test(type)) throw new SchemaError(PROVIDER, 'XDP returned a scan without its status type');
    if (MESSAGE.test(type)) continue;
    const description = wording(type, data);
    if (!description) throw new SchemaError(PROVIDER, 'XDP returned a scan without its wording');
    rows.push({ local_time: local, type, description, index });
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Oldest first; the page lists equal clocks newest first, so a later row is older.
  rows.sort((left, right) => left.local_time < right.local_time ? -1 : left.local_time > right.local_time ? 1 : right.index - left.index);
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let returning = false;
  for (const row of rows) {
    // A return label starts the way back: every later scan belongs to it.
    const outbound = xdpStage(row.type, row.description);
    const stage: Stage | undefined = returning && outbound && outbound !== 'exception' ? 'returned' : outbound;
    if (row.type === 'EXCEPTION' && /^return label created$/i.test(row.description)) returning = true;
    // A consignment of several pieces repeats each scan once per piece.
    const identity = JSON.stringify([row.local_time, row.type, row.description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push({ local_time: row.local_time, description: row.description, provider_code: row.type,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  // Newest first; equal clocks keep the later row first.
  events.reverse();
  const newest = events[0]!;
  const current = events.find((event) => event.stage)?.stage as Stage | undefined;
  const weight = WEIGHT.exec(labelled($, 'Weight'));
  const kilograms = weight ? Number(weight[1]) : 0;
  const service = labelled($, 'Service');
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current ? { current_stage: current, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(kilograms > 0 ? { weight_kg: kilograms } : {}),
    ...(SERVICE.test(service) && service.toUpperCase() !== 'N/A' ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
