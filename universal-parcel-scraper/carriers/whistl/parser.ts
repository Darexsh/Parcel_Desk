import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { whistlQuiet, whistlStage } from './status.js';

export const PROVIDER = 'Whistl';
// A page with a long history is a few dozen kilobytes.
export const WHISTL_MAX_BYTES = 1_000_000;

// A Parcelhub shipment reference or a parcel's tracking number, in letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,40}$/;
// The page's heading for a reference it does not know.
const ABSENT = 'Unable to find shipment';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment|Attention Required)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;
// The site's error page, served with HTTP 500 when a lookup fails, even for a known shipment.
const FAILED = 'An error occurred while processing your request.';
const CARD = /^Tracking Number:\s*([A-Za-z0-9]{1,40})$/;
const STAMP = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/;
// The scan's place, "(depot - code)", after its wording; "( - )" names none.
const PLACED = /^(.*?) \(([^()]*) - ([^()]*)\)(?: |$)/;
// A note on the record naming the number the delivering carrier tracks the parcel by.
const FINAL_MILE = /^Final Mile Tracking Number changed to:\s*([A-Za-z0-9]{4,40})$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 200;

interface Row { event: CarrierEvent; code: string; index: number }

/** A reference as Whistl's tracker takes it: letters and digits, at least one digit. */
export function normalizeWhistlNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Whistl tracks references of letters and digits');
  return number;
}

/** The scan's date and time ("18/06/2026 12:43:52") as a wall clock. They carry no offset. */
function wallClock(stamp: string): string | null {
  if (!STAMP.test(stamp)) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(stamp, 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * The scan's wording and place from its cell. The cell's first line prints the
 * wording, the place when the scan has one and the signatory, each followed by
 * one space, so an empty place leaves two spaces after the wording. The
 * signatory and the lines after it are never read. A line that cannot be
 * split that way keeps only the scan's status label.
 */
function scanText(raw: string, label: string): { description: string; location?: string } {
  const lines = raw.split(/\r?\n/);
  const line = (lines.length > 1 && !lines[0]!.trim() ? lines[1]! : lines[0]!).replace(/^\s+/, '');
  const placed = PLACED.exec(line);
  if (placed) {
    const location = clean(placed[2], 200);
    return { description: clean(placed[1], 300) || label, ...(location ? { location } : {}) };
  }
  const end = line.indexOf('  ');
  return { description: (end >= 0 ? clean(line.slice(0, end), 300) : '') || label };
}

/** The text after a summary label ("Carrier:"), up to the next tag. */
function summaryValue($: CheerioAPI, label: string): string {
  const labels = $('main div.col-sm > b').filter((_, node) => clean($(node).text(), 40) === label);
  if (labels.length !== 1) return '';
  const next = labels.get(0)!.nextSibling;
  // A text node (DOM node type 3) holds the value.
  return next?.nodeType === 3 && 'data' in next ? clean(next.data, 80) : '';
}

function rowsOf($: CheerioAPI, card: ReturnType<CheerioAPI>): Row[] {
  const trs = card.find('table > tbody > tr');
  if (trs.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Whistl returned too many scans');
  const rows: Row[] = [];
  const seen = new Set<string>();
  trs.each((index, tr) => {
    const cells = $(tr).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Whistl history columns changed');
    const code = clean(cells.eq(1).text(), 80);
    const local = wallClock(clean(cells.eq(3).text(), 40));
    if (!code || !clean(cells.eq(0).text(), 40) || !local) throw new SchemaError(PROVIDER, 'Whistl returned a scan without its status or clock');
    const { description, location } = scanText(cells.eq(2).text(), code);
    const event: CarrierEvent = { local_time: local, description, provider_code: code, ...(location ? { location } : {}) };
    // A scan can come twice with the same clock, status, wording and place.
    const identity = JSON.stringify([local, code, description, location ?? null]);
    if (seen.has(identity)) return;
    seen.add(identity);
    rows.push({ event, code, index });
  });
  return rows;
}

/**
 * Whistl's tracker page for one shipment reference or tracking number: the
 * shipment's reference as its heading, the carrier and service, and for each
 * parcel its tracking number and scans, newest first. The tracker finds a
 * shipment by its reference or by a parcel's tracking number, so the page
 * must name the requested number as one of them. Sender's and recipient's
 * references, signatories and comments are never read.
 */
export function parseWhistl(html: string, rawNumber: string): CarrierResult {
  const number = normalizeWhistlNumber(rawNumber);
  const $ = load(html);
  const headings = $('main div.border-bottom > h3');
  if (headings.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Whistl answered with a block page');
    if (clean($('main p').first().text(), 80) === FAILED) throw new IndeterminateError(PROVIDER, 'Whistl could not look the reference up');
    throw new SchemaError(PROVIDER, 'Whistl did not return a tracking page');
  }
  const heading = clean(headings.text(), 80);
  const cards = $('main div.card');
  if (heading === ABSENT) {
    if (cards.length) throw new SchemaError(PROVIDER, 'Whistl returned parcels under its not-found heading');
    throw new NotFoundError(PROVIDER);
  }
  const reference = normalizeTrackingNumber(heading);
  const parcels = cards.toArray().map((node) => {
    const card = $(node);
    const shown = CARD.exec(clean(card.children('h5.card-header').text(), 80));
    if (!shown) throw new SchemaError(PROVIDER, 'Whistl returned a parcel without its tracking number');
    return { number: normalizeTrackingNumber(shown[1]!), card };
  });
  // The parcel the number names, or the only parcel of the shipment it names.
  const matching = parcels.filter((parcel) => parcel.number === number);
  if (matching.length > 1) throw new SchemaError(PROVIDER, 'Whistl returned the parcel twice');
  if (!matching.length && reference !== number) throw new SchemaError(PROVIDER, 'Whistl answered for a different number');
  if (!matching.length && parcels.length > 1) {
    throw new IndeterminateError(PROVIDER, 'Whistl found several parcels for the shipment reference; each has its own tracking number');
  }
  const parcel = matching[0] ?? parcels[0];
  if (!parcel) throw new NoHistoryError(PROVIDER);

  const rows = rowsOf($, parcel.card);
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; equal clocks keep the page's order.
  rows.sort((left, right) => left.event.local_time! < right.event.local_time! ? 1
    : left.event.local_time! > right.event.local_time! ? -1 : left.index - right.index);

  // Oldest first: an acceptance after the parcel moved on is part of its way,
  // and a delivery once it was sent back reaches its sender.
  let moved = false;
  let returning = false;
  for (const { event, code } of [...rows].reverse()) {
    const classified = whistlStage(code, event.description!);
    if (!classified) continue;
    let stage: Stage = classified.stage;
    if (stage === 'accepted' && moved) stage = 'in_transit';
    if (stage === 'delivered' && returning) stage = 'returned';
    if (!['registered', 'accepted', 'exception', 'pending'].includes(stage)) moved = true;
    if (stage === 'returned') returning = true;
    Object.assign(event, { stage, stage_source: classified.source });
  }

  const events = rows.map(({ event }) => event);
  const newest = events[0]!;
  // A note or request keeps the stage of the scan before it.
  const current = rows.find(({ code }) => !whistlQuiet(code))?.event;
  const stage = current?.stage as Stage | undefined;

  // The carrier the shipment travels with. Whistl's own parcel names a final-mile
  // number when another carrier delivers it abroad; another carrier's parcel
  // carries that carrier's tracking number.
  const carrierName = summaryValue($, 'Carrier:');
  const service = summaryValue($, 'Service:');
  const own = carrierName.toLocaleLowerCase('en-GB') === 'whistl';
  const partner = carrierName && !own ? carrierIdFromPartner(carrierName) : undefined;
  const finalMile = own ? events.map((event) => FINAL_MILE.exec(event.description!)?.[1]).find(Boolean) : undefined;
  const downstream = own ? finalMile && normalizeTrackingNumber(finalMile) : parcel.number;
  const delivery = downstream && downstream !== number && !(own && downstream === parcel.number) ? downstream : undefined;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(own && parcel.number !== number ? { canonical_tracking_number: parcel.number } : {}),
    ...(partner && partner !== 'whistl' ? { delivery_carrier: partner } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
