import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { oneWorldExpressStage } from './status.js';

export const PROVIDER = 'One World Express';
// A parcel's page is about 50 kB, most of it the page's own markup.
export const ONE_WORLD_EXPRESS_MAX_BYTES = 1024 * 1024;
// OWE and twelve digits, as One World Express labels its own parcels.
const NUMBER = /^OWE\d{12}$/;
// The page's notice for a number SmartTrack has no parcel for.
const NOT_FOUND = 'No Tracking available.';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden|Request Rejected)|requested URL was rejected|_cf_chl_opt|cf-turnstile|captcha/i;
// A partner's number in the parcel's Tracking Number box.
const PARTNER_NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
// The parcel image the page offers, a file named after the parcel's number.
const IMAGE = /showsorterImage\(\s*'(?:[^'/]*\/)*([^'/.]+)\.[a-z]{3,4}'/i;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Who took a delivered parcel, after the delivery's own words.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:signed(?: for)? by|signatory|received by)\b[\s\S]*$/i;
const MAX_ROWS = 600;

/** A One World Express number in capitals; anything else is not one it issues. */
export function normalizeOneWorldExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'One World Express numbers are OWE and twelve digits');
  return number;
}

/** A cell's text without links, buttons, icons and images, phone numbers or e-mail addresses. */
function cellText(cell: Cheerio<AnyNode>, maxLength: number): string {
  const copy = cell.clone();
  copy.find('a, button, i, img, script, style').remove();
  return clean(clean(copy.text(), 2000).replace(EMAIL, '').replace(PHONE, ''), maxLength)
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

/** A scan's description, without who signed for the parcel. */
export function oneWorldExpressWording(text: string): string {
  return clean(text.replace(RECEIVER, '').replace(EMAIL, '').replace(PHONE, '').replace(/\s+([,;:.])/g, '$1'), 300)
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

/** "Thursday, February 26, 2026", a day heading; the weekday must fit the date. */
function day(heading: string): string {
  // UTC only checks the calendar fields; the clock keeps no offset.
  const parsed = DateTime.fromFormat(heading, 'cccc, LLLL d, yyyy', { zone: 'UTC', locale: 'en-US' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'One World Express returned an invalid scan date');
  return parsed.toISODate();
}

/** The value in each of the shipment's boxes, by the label under it. */
function boxes($: CheerioAPI, body: Cheerio<AnyNode>): Map<string, string> {
  const values = new Map<string, string>();
  body.find('.dashboard-stat2 .number').each((_, box) => {
    const label = clean($(box).children('small').text(), 60).toLowerCase();
    if (label) values.set(label, clean($(box).find('h3').text(), 120));
  });
  return values;
}

/**
 * The history table: a header row, then each day's heading and that day's
 * scans, each a clock, a place, a description and SmartTrack's Status label,
 * newest first.
 */
function scans($: CheerioAPI, table: Cheerio<AnyNode>): CarrierEvent[] {
  const rows = table.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'One World Express returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let date = '';
  for (const row of rows) {
    const headings = $(row).children('th');
    const cells = $(row).children('td');
    if (!headings.length && !cells.length) continue;
    if (headings.length === 1 && !cells.length) {
      date = day(clean(headings.text(), 60));
      continue;
    }
    // The column headings: Date, Location, Description, Status.
    if (headings.length === 4 && !cells.length) continue;
    if (cells.length !== 4 || headings.length || !date) throw new SchemaError(PROVIDER, 'One World Express returned an invalid scan');
    const clock = CLOCK.exec(clean(cells.eq(0).text(), 16));
    if (!clock) throw new SchemaError(PROVIDER, 'One World Express returned an invalid scan time');
    const local = `${date}T${clock[1]}:${clock[2]}:00`;
    const location = cellText(cells.eq(1), 120);
    const label = cellText(cells.eq(3), 64);
    const description = oneWorldExpressWording(cellText(cells.eq(2), 400)) || label;
    if (!description) throw new SchemaError(PROVIDER, 'One World Express returned a scan without wording');
    const key = JSON.stringify([local, location, description, label]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = oneWorldExpressStage(label, description);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(label ? { provider_code: label } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/**
 * SmartTrack's page for one number, `tracking.php?tracking_number={number}`.
 * A parcel's page puts the number asked back in its search field, shows the
 * shipment's boxes and lists its scans. A number SmartTrack does not know
 * gets only its notice. The parcel's own number shows nowhere else, except in
 * the name of the parcel image when there is one.
 */
export function parseOneWorldExpress(html: string, raw: string): CarrierResult {
  const number = normalizeOneWorldExpressNumber(raw);
  const $ = load(html);
  const body = $('div.portlet-body');
  if (body.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'One World Express answered with a block page');
    throw new SchemaError(PROVIDER, 'One World Express did not return its tracking page');
  }
  const tables = body.find('table').filter((_, table) => /Tracking Events/i.test($(table).children('thead').text()));
  if (!tables.length) {
    const notice = clean(body.children('p').text(), 200);
    if (notice === NOT_FOUND && !body.find('input[name="tracking_number"]').length) throw new NotFoundError(PROVIDER);
    if (notice) throw new IndeterminateError(PROVIDER, 'One World Express answered with another notice');
    throw new SchemaError(PROVIDER, 'One World Express returned a page without its history');
  }
  if (tables.length > 1) throw new SchemaError(PROVIDER, 'One World Express returned several histories');

  const fields = body.find('input[name="tracking_number"]');
  if (fields.length !== 1) throw new SchemaError(PROVIDER, 'One World Express returned a parcel without the number asked');
  if (returnedTrackingNumber(fields.attr('value')).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'One World Express answered for another number');
  }
  const image = IMAGE.exec(body.find('[onclick*="showsorterImage"]').attr('onclick') ?? '')?.[1]?.toUpperCase();
  if (image && NUMBER.test(image) && image !== number) throw new IndeterminateError(PROVIDER, 'One World Express answered for another parcel');

  const events = scans($, tables.first());
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const values = boxes($, body);
  const reference = returnedTrackingNumber(values.get('order # (hawb)') ?? '').toUpperCase();
  // The Tracking Number box holds the number of the carrier that delivers the parcel.
  const partner = returnedTrackingNumber(values.get('tracking number') ?? '').toUpperCase();
  const handoff = partner !== number && partner !== reference && PARTNER_NUMBER.test(partner) ? partner : '';
  const service = values.get('service name') ?? '';
  const destination = values.get('destination country') ?? '';
  const country = destination ? countryCode(destination) : null;

  // Clocks are several countries' and keep no zone, so the page's order stands.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...(handoff ? { delivery_tracking_number: handoff } : {}),
    events,
  };
}
