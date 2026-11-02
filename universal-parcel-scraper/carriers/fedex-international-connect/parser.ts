import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { carrierLinkRules, matchesDomain } from '../../core/catalog/linkRules.js';
import { normalizeTrackingNumber, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { ficStage } from './status.js';

export const PROVIDER = 'FedEx International Connect';
export const CARRIER = 'fedex-international-connect';
export const FIC_MAX_BYTES = 512 * 1024;

// Three letters for the shipper, four digits, the country it sends from and eleven digits.
const NUMBER = /^[A-Z]{3}\d{4}[A-Z]{2}\d{11}$/;
const NO_RECORD = 'Sorry we have no record of your reference on file at this time';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "22nd Nov 2025 15:10:00", on the clock of the place that scanned it.
const CLOCK = /^(\d{1,2})(?:st|nd|rd|th) ([A-Za-z]{3}) (\d{4}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const HANDOVER = /^RECEIVED BY PARTNER CARRIER$/i;

/** An FIC tracking number; the tracker's other keys, a partner's number or a shipper's reference, are not asked. */
export function normalizeFicNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'FedEx International Connect numbers are three letters, four digits, a country code and eleven digits');
  }
  return number;
}

function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  const day = match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'FedEx International Connect returned an invalid scan clock');
  return `${day}T${match![4]}:${match![5]}:${match![6]}`;
}

/**
 * From "RECEIVED BY PARTNER CARRIER" on, the scans without a place are the
 * partner's, on its clock, and the destination's zone stands in for it: a
 * Dutch post's scans for Hungary came on Central European summer time, and the
 * London time of FIC's British hub before them put them an hour late. They are
 * read in the destination's zone when it keeps one clock, and otherwise stay
 * local.
 */
function partnerClocks(events: CarrierEvent[], destination: string | null): CarrierEvent[] {
  const zone = countryTimeZone(destination);
  const handover = events.filter((event) => HANDOVER.test(event.description!)).map((event) => event.local_time!).sort()[0];
  if (!zone || !handover) return events;
  return events.map((event) => {
    if (event.location || event.local_time! < handover) return event;
    const time = firstOccurrence(DateTime.fromISO(event.local_time!, { zone })).toISO({ suppressMilliseconds: true });
    return time ? { ...event, time, time_zone: zone, time_zone_basis: 'destination' } : event;
  });
}

/** The label and value pairs of the parcel's details table. */
function detailFields($: CheerioAPI, table: Cheerio<AnyNode>): Map<string, Cheerio<AnyNode>> {
  const fields = new Map<string, Cheerio<AnyNode>>();
  table.find('th').each((_, th) => {
    const label = clean($(th).text(), 60).replace(/:$/, '');
    if (!label) return;
    if (fields.has(label)) throw new SchemaError(PROVIDER, 'FedEx International Connect returned ambiguous parcel details');
    fields.set(label, $(th).next('td'));
  });
  return fields;
}

/**
 * The partner that delivers the parcel and its number: the carrier whose own
 * tracker the "View More Tracking" button opens for the number the page names
 * as the parcel's tracking number. A link to another site, such as PostNord's
 * DirectLink for a post's number, names none.
 */
function partner(fields: Map<string, Cheerio<AnyNode>>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const number = normalizeTrackingNumber(clean(fields.get('Tracking Number')?.text() ?? '', 64));
  const onclick = fields.get('Carrier')?.find('input').attr('onclick') ?? '';
  const link = /window\.open\('([^']{1,2000})'/.exec(onclick)?.[1]?.replaceAll('\\/', '/');
  if (!link || !/^[A-Z0-9]{4,40}$/.test(number)) return {};
  let host: string;
  try { host = new URL(link).hostname.toLowerCase(); } catch { return {}; }
  const match = parseTrackingInput(link);
  if (match.source !== 'link' || match.confidence !== 'high' || match.carrier === 'unknown' || match.carrier === CARRIER
    || normalizeTrackingNumber(match.trackingNumber).toUpperCase() !== number
    || !carrierLinkRules(match.carrier).some((rule) => rule.domains.some((domain) => matchesDomain(host, domain)))) return {};
  return { delivery_carrier: match.carrier, delivery_tracking_number: number };
}

/**
 * The tracker's page for one number: a "Shipment Details" block headed with
 * the number asked, then the parcel's "Shipment History", newest first. Only a
 * parcel whose FIC tracking number is the whole number asked is read. The
 * shipper's reference and the partner's local number are not read.
 */
export function parseFic(html: string, raw: string): CarrierResult {
  const number = normalizeFicNumber(raw);
  const $ = load(html);
  const blocks = $('div.BodyBlock');
  const details = blocks.filter((_, block) => /^Shipment Details\b/.test(clean($(block).children('h4').first().text(), 120)));
  if (details.length !== 1) throw new SchemaError(PROVIDER, 'FedEx International Connect returned no single parcel');
  const heading = clean(details.children('h4').first().text(), 120).replace(/^Shipment Details\s*#?\s*/, '');
  if (normalizeTrackingNumber(heading) !== number) throw new SchemaError(PROVIDER, 'FedEx International Connect returned a different parcel');
  const table = details.find('table.display-ml');
  if (!table.length) {
    if (clean(details.text(), 1_000).endsWith(NO_RECORD)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'FedEx International Connect returned no parcel details');
  }
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'FedEx International Connect returned ambiguous parcel details');
  const fields = detailFields($, table);
  if (normalizeTrackingNumber(clean(fields.get('FIC Tracking Number')?.text() ?? '', 64)) !== number) {
    throw new SchemaError(PROVIDER, 'FedEx International Connect returned a different parcel');
  }
  const histories = blocks.filter((_, block) => clean($(block).children('h4').first().text(), 60) === 'Shipment History');
  if (histories.length > 1) throw new SchemaError(PROVIDER, 'FedEx International Connect returned ambiguous histories');
  const rows = histories.find('tr').filter((_, row) => $(row).children('td').length > 0);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'FedEx International Connect returned an oversized history');
  const parsed: CarrierEvent[] = [];
  const seen = new Set<string>();
  rows.each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'FedEx International Connect returned an incomplete scan row');
    const description = clean(cells.eq(1).text(), 300);
    const code = clean(cells.eq(2).text(), 8);
    if (!description || (code && !/^\d{1,4}$/.test(code))) throw new SchemaError(PROVIDER, 'FedEx International Connect returned an incomplete scan');
    const local = wallClock(clean(cells.eq(0).text(), 40));
    const location = clean(cells.eq(3).text(), 120);
    // A scan a partner reports twice is listed as two rows; it is one scan.
    const key = JSON.stringify([local, code, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const stage = ficStage(code || null, description);
    parsed.push({ local_time: local, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
  });
  if (!parsed.length) throw new NoHistoryError(PROVIDER);
  const country = countryCode(clean(fields.get('Destination')?.text() ?? '', 60));
  const events = partnerClocks(parsed, country);
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const service = clean(fields.get('Service')?.text() ?? '', 80);
  const weight = /^(\d{1,4}(?:\.\d{1,3})?) kg$/i.exec(clean(fields.get('Weight')?.text() ?? '', 20))?.[1];
  return {
    status: staged ? languageStageStatus(staged.stage as Stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(weight && Number(weight) > 0 ? { weight_kg: Number(weight) } : {}),
    ...(country ? { destination_country: country } : {}),
    ...partner(fields),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
