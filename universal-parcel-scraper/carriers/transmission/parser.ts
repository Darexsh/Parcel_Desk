import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { transmissionMappedStage } from './status.js';

export const PROVIDER = 'TransMission';
// A shipment's page is about fifty kilobytes and grows by a table for each shipping unit.
export const TRANSMISSION_MAX_BYTES = 2 * 1024 * 1024;

// Every TransMission depot keeps Dutch time: the Netherlands, Belgium and Luxembourg share it.
const ZONE = 'Europe/Amsterdam';
// `T` or `P`, the two-digit depot and twelve digits; a shipping unit's barcode adds three.
const SHIPMENT = /^[TP]\d{14}$/;
const UNIT = /^[TP]\d{17}$/;
// Bot checks a firewall or CDN could put in place of the page.
export const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;
// The search form's notices, in Dutch and English.
const UNKNOWN_NUMBER = /^(?:Geen geldig zendingnummer|Invalid shipment number)$/i;
const OTHER_POSTCODE = /^(?:Zending niet gevonden voor postcode|Shipment not found for zipcode):?\s*(\S.*)$/i;
const NO_POSTCODE = /^(?:Postcode is verplicht|Zipcode is required)$/i;
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const WINDOW = /^(\d{2}-\d{2}-\d{4}) (\d{2}:\d{2}) - (\d{2}:\d{2})$/;
const AT = /^(\d{2}-\d{2}-\d{4}) (\d{2}:\d{2})$/;
// Wording that goes on to name the person who took the parcel is cut before the name.
const PERSON = /\s*[-,:]?\s*\b(?:ontvangen door|getekend door|received by|signed by)\b.*$/i;
const WEIGHT = /^\d{1,5}(?:\.\d{1,3})?$/;
const MAX_ROWS = 500;

/** The number asked, and the shipment it belongs to: a unit's barcode extends its shipment's number. */
export function normalizeTransmissionNumber(raw: string): { asked: string; shipment: string } {
  const asked = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (SHIPMENT.test(asked)) return { asked, shipment: asked };
  if (UNIT.test(asked)) return { asked, shipment: asked.slice(0, 15) };
  throw new InvalidInputError(PROVIDER, 'TransMission numbers are T or P and fourteen digits, or a shipping unit\'s seventeen');
}

/** The recipient's postcode, which the tracker asks for with every number, in capitals without spaces as it files it. */
export function normalizeTransmissionPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'postcode', 'TransMission shows a shipment only with the recipient\'s postcode');
  if (!DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'TransMission requires a valid recipient postcode');
  return postcode.replace(/ /g, '');
}

/**
 * The search form's answer when it does not send the browser on to the
 * shipment: the form again, holding the number asked, with a notice. A number
 * the tracker does not know is "not a valid shipment number"; a number it
 * knows under another postcode is "not found for postcode", followed by the
 * postcode asked.
 */
export function parseSearchReply(html: string, asked: string, postcode: string): never {
  const $ = load(html);
  const field = $('form input[name="shipment_id"]');
  if (field.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TransMission answered with a browser check');
    throw new SchemaError(PROVIDER, 'TransMission did not return its search form');
  }
  if (normalizeTrackingNumber(clean(field.attr('value') ?? '', 64)) !== asked) throw new SchemaError(PROVIDER, 'TransMission answered for another number');
  $('.alert br').replaceWith('\n');
  const notices = $('.alert p').text().split('\n').map((line) => clean(line, 200)).filter(Boolean);
  const notice = notices.length === 1 ? notices[0]! : '';
  if (UNKNOWN_NUMBER.test(notice)) throw new NotFoundError(PROVIDER, 'TransMission knows no shipment with this number');
  const other = OTHER_POSTCODE.exec(notice);
  if (other) {
    if (other[1]!.replace(/\s+/g, '').toUpperCase() !== postcode) throw new SchemaError(PROVIDER, 'TransMission answered for another postcode');
    throw new InputRequiredError(PROVIDER, 'postcode', 'TransMission has no shipment with this number for that postcode', { reason: 'postcode_mismatch' });
  }
  if (NO_POSTCODE.test(notice)) throw new InputRequiredError(PROVIDER, 'postcode', 'TransMission shows a shipment only with the recipient\'s postcode');
  throw new SchemaError(PROVIDER, notices.length ? 'TransMission answered with an unknown notice' : 'TransMission returned its search form without an answer');
}

/** A day and clock of the page as Dutch time, or null when they are not one. */
function wallClock(day: string, clock: string): DateTime | null {
  const date = DAY.exec(day);
  const time = CLOCK.exec(clock);
  if (!date || !time) return null;
  const local = `${date[3]}-${date[2]}-${date[1]}T${time[1]}:${time[2]}:${time[3] ?? '00'}`;
  // Parsing in UTC checks the calendar digits; Luxon would roll 24:00 or 30 February over.
  if (DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) return null;
  return firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
}

const iso = (time: DateTime) => time.toISO({ suppressMilliseconds: true })!;
const labelled = ($: CheerioAPI, tag: string, label: RegExp) =>
  $(tag).filter((_, node) => label.test(clean($(node).text(), 60))).first();

/** Each depot the progress rail names, with its town: the last line of its address. */
function depotTowns($: CheerioAPI): Map<string, string> {
  const towns = new Map<string, string>();
  $('[id="progressbar"] .CellComment').each((_, node) => {
    const code = clean($(node).children('h6').first().text(), 16);
    const lines = $(node).children('p.gray-500').first().text().split('\n').map((line) => clean(line, 100)).filter(Boolean);
    if (/^\d{1,8}$/.test(code) && lines.length) towns.set(code, lines.at(-1)!);
  });
  return towns;
}

/** A unit's scan history: the cells of each row under the columns the page names. */
function historyRows($: CheerioAPI, unit: Cheerio<AnyNode>): Array<Record<'day' | 'clock' | 'depot' | 'code' | 'status', string>> {
  const heading = unit.find('h4').filter((_, node) => /^(?:Historie|History)$/i.test(clean($(node).text(), 20))).first();
  const table = heading.parent().find('table').first();
  const columns = table.find('thead th').map((_, node) => clean($(node).text(), 40)).get();
  const at = (name: RegExp) => columns.findIndex((column) => name.test(column));
  const day = at(/^(?:Datum|Date)$/i);
  const clock = at(/^(?:Tijd|Time)$/i);
  const status = at(/^Status$/i);
  const depot = at(/^Depot$/i);
  const code = at(/^(?:Zoek code|Search code)$/i);
  if (!table.length || day < 0 || clock < 0 || status < 0) throw new SchemaError(PROVIDER, 'TransMission changed its scan history');
  return table.find('tbody tr').toArray().map((row) => {
    const cells = $(row).children('td').map((_, node) => clean($(node).text(), 300)).get();
    return { day: cells[day] ?? '', clock: cells[clock] ?? '', status: cells[status] ?? '',
      depot: depot < 0 ? '' : cells[depot] ?? '', code: code < 0 ? '' : cells[code] ?? '' };
  });
}

/** The total weight of the units read, when the page gives each one. */
function weightOf($: CheerioAPI, barcodes: ReadonlySet<string> | null): number | null {
  const table = labelled($, 'h4:not(.modal-title)', /^(?:Verzendeenheden|Shipping units)$/i).parent().find('table').first();
  const columns = table.find('thead th').map((_, node) => clean($(node).text(), 40)).get();
  const barcode = columns.indexOf('Barcode');
  const weight = columns.findIndex((column) => /^(?:Gewicht|Weight) \(kg\)$/i.test(column));
  if (barcode < 0 || weight < 0) return null;
  let total = 0;
  let units = 0;
  for (const row of table.find('tbody tr').toArray()) {
    const cells = $(row).children('td').map((_, node) => clean($(node).text(), 64)).get();
    if (barcodes && !barcodes.has(normalizeTrackingNumber(cells[barcode] ?? ''))) continue;
    if (!WEIGHT.test(cells[weight] ?? '')) return null;
    total += Number(cells[weight]);
    units += 1;
  }
  return units && total > 0 ? Math.round(total * 1000) / 1000 : null;
}

/** The delivery box: when the parcel was delivered, or when it is expected. */
function deliveryBox($: CheerioAPI): Pick<CarrierResult, 'delivered_at' | 'expected_delivery' | 'expected_delivery_from'> {
  const box = labelled($, 'h6', /^(?:Aflevering|Delivery)$/i).parent();
  const label = clean(box.children('h4').first().text(), 40);
  const value = clean(box.children('h6').eq(1).text(), 60);
  const delivered = AT.exec(value);
  if (delivered && /^(?:Afgeleverd op|Delivered on)$/i.test(label)) {
    const time = wallClock(delivered[1]!, delivered[2]!);
    return time ? { delivered_at: iso(time) } : {};
  }
  const window = WINDOW.exec(value);
  if (window && /^(?:Geschat tussen|Estimated between)$/i.test(label)) {
    const from = wallClock(window[1]!, window[2]!);
    const to = wallClock(window[1]!, window[3]!);
    return from && to && from < to ? { expected_delivery_from: iso(from), expected_delivery: iso(to) } : {};
  }
  const day = DAY.exec(value.split(' ')[0] ?? '');
  if (day && /^(?:Verwacht op|Expected on):?$/i.test(label)) {
    const date = wallClock(day[0], '00:00');
    return date ? { expected_delivery: date.toISODate()! } : {};
  }
  return {};
}

interface Scan { event: CarrierEvent; at: number; order: number }

/**
 * The tracker's page for one shipment (`/tt/{number}/{postcode}`): its number,
 * the status above the progress rail, the delivery box, and each shipping
 * unit's scans, each with its depot, search code and status. The rail names
 * the depots' towns. A unit's barcode reads that unit's scans; a shipment
 * number reads every unit's, once each. The sender, recipient, references,
 * order numbers, unit descriptions and the name of whoever took the parcel
 * are never read.
 */
export function parseTransmissionPage(html: string, raw: string): CarrierResult {
  const { asked, shipment } = normalizeTransmissionNumber(raw);
  const $ = load(html);
  $('br').replaceWith('\n');
  const label = labelled($, 'p', /^(?:Zendingnummer|Shipment number)$/i);
  if (!label.length) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TransMission answered with a browser check');
    throw new SchemaError(PROVIDER, 'TransMission did not return the shipment page');
  }
  if (normalizeTrackingNumber(clean(label.next('h4').text(), 64)) !== shipment) throw new SchemaError(PROVIDER, 'TransMission answered for another shipment');

  const units = $('div.modal[id^="unit_detail_"]').toArray().map((node) => $(node));
  const unitAsked = asked !== shipment;
  const read = unitAsked ? units.filter((unit) => normalizeTrackingNumber(clean(unit.find('.modal-title').first().text(), 64)) === asked) : units;
  if (unitAsked && !read.length) throw new SchemaError(PROVIDER, 'TransMission did not list the shipping unit asked');
  const towns = depotTowns($);
  const scans: Scan[] = [];
  const seen = new Set<string>();
  let rows = 0;
  for (const unit of read) {
    for (const row of historyRows($, unit)) {
      if (++rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'TransMission returned too many scans');
      const time = wallClock(row.day, row.clock);
      if (!time) throw new SchemaError(PROVIDER, 'TransMission returned an invalid scan time');
      const description = row.status.replace(PERSON, '');
      if (!description) throw new SchemaError(PROVIDER, 'TransMission returned a scan without its status');
      if (row.code && !/^\d{1,4}$/.test(row.code)) throw new SchemaError(PROVIDER, 'TransMission returned an invalid search code');
      // Units repeat the shipment's scans, and a delivery is logged twice, under 39 and 0, on one clock.
      const identity = JSON.stringify([iso(time), row.depot, description]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const stage = transmissionMappedStage(row.code || null, description);
      const town = row.depot ? towns.get(row.depot) : undefined;
      scans.push({ at: time.toMillis(), order: scans.length, event: { time: iso(time), ...(town ? { location: town } : {}), description,
        ...(stage ? { stage, stage_source: 'carrier_map' } : {}), ...(row.code ? { provider_code: row.code } : {}) } });
    }
  }
  // Newest first; the page lists a unit's scans newest first, so an earlier row is newer on one clock.
  const events = scans.sort((left, right) => right.at - left.at || left.order - right.order).map(({ event }) => event);

  const headline = clean($('.bg-blue-50 h2').first().text(), 200);
  const sentence = clean($('.bg-blue-50 .text-center > p').first().text(), 300);
  const box = deliveryBox($);
  const scanned = events.find((event) => event.stage)?.stage as Stage | undefined;
  // A shipment the page shows without a scan has been announced.
  const stage = scanned ?? transmissionMappedStage(null, headline) ?? transmissionMappedStage(null, sentence) ?? (events.length ? undefined : 'registered');
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time ?? box.delivered_at : undefined;
  const weight = weightOf($, unitAsked ? new Set([asked]) : null);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]?.description ?? (headline || sentence || null),
    last_update: events[0]?.time ?? null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(stage !== 'delivered' && box.expected_delivery ? { expected_delivery: box.expected_delivery } : {}),
    ...(stage !== 'delivered' && box.expected_delivery_from ? { expected_delivery_from: box.expected_delivery_from } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
