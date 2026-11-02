import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import { evriStatus } from './status.js';

export const PROVIDER = 'Evri International';

/**
 * Evri International's names for the carriers that deliver its parcels, as its
 * Carrier field prints them, by lower-case label. A label names one catalog
 * network; one missing here gives no delivery partner. OSM Worldwide hands its
 * parcels to USPS, whose barcode Carrier Tracking holds.
 */
const PARTNERS: ReadonlyMap<string, string> = new Map([
  ['smart kargo - osm expedited', 'usps'],
  ['paack 48h', 'paack'],
  ['colis prive', 'colis-prive'],
  ['hermes hsi courier', 'hermes-de'],
  ['gls italy', 'gls-it'],
  ['dhl connect', 'dhl'],
  ['spring tracked', 'spring-gds'],
  ['cross border connect speedx', 'speedx'],
  ['mondial point relais delivery pudo', 'mondial-relay'],
]);

/** The catalog id of the carrier an Evri International Carrier label names, if the table maps it. */
export function evriPartner(label: string): string | undefined {
  return PARTNERS.get(label.trim().toLowerCase());
}

export function normalizeEvriNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{16}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Evri requires a 16-character tracking number');
  }
  return number;
}

// A row's comment can state the delivery estimate, month first: "Estimated delivery date is: 10-30-2026".
const ESTIMATE = /\bestimated delivery date is:?\s*(?:(\d{1,2})-(\d{1,2})-(\d{4})|(\d{4})-(\d{2})-(\d{2}))\b/i;

/** The delivery estimate a comment states, as a calendar day. Nothing else in a comment is read. */
function commentEstimate(comment: string): string | null {
  const match = ESTIMATE.exec(comment);
  if (!match) return null;
  const [month, day, year] = match[1] ? [match[1], match[2], match[3]] : [match[5], match[6], match[4]];
  const date = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day) }, { zone: 'UTC' });
  return date.isValid ? date.toISODate() : null;
}

function wallTime(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) throw new SchemaError(PROVIDER, 'Evri returned an invalid event date');
  // Validate calendar values without claiming that the provider's international
  // wall clocks are UTC, or assigning one country's timezone to another leg.
  const date = DateTime.fromFormat(raw, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!date.isValid) throw new SchemaError(PROVIDER, 'Evri returned an invalid event date');
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export interface EvriInternationalShipment {
  /** The Evri barcode, in both the heading and the System Tracking field. */
  system: string;
  /** The Carrier Tracking field: the delivering carrier's number, or the Evri barcode again. */
  carrierTracking: string;
  /** The Carrier field as printed. */
  carrierLabel: string;
  result: CarrierResult;
}

/**
 * Parse only the response to this number's POST. The tracker finds a parcel by
 * its Evri barcode or by its delivery partner's number, so the requested number
 * must be one of the two. Callers decide which one they asked by. Empty results
 * carry no identifier.
 */
export function parseEvriInternational(html: string, requested: string): EvriInternationalShipment {
  const $ = load(html);
  if (/just a moment|verify.*human|captcha/i.test($('title').text())
    || $('.g-recaptcha, .h-captcha, input[name="captcha"]').length) throw new ChallengeError(PROVIDER);
  $('script, style, noscript').remove();
  const form = $('main form[action="/track"][method="POST"]');
  const headings = $('main h2');
  const detailsHeading = headings.filter((_, heading) => clean($(heading).text()).startsWith('Shipment Details #'));
  const historyHeading = headings.filter((_, heading) => clean($(heading).text()) === 'Shipment History');
  const input = form.find('input[name="tracking_number"]');
  // GlobalEco clears the form input for not-found. The exact POST scopes this
  // negative outcome; reject a nonempty input that names a different parcel.
  if (!detailsHeading.length && !historyHeading.length && form.length === 1
    && input.length === 1 && ['', requested].includes(input.attr('value') ?? '!')
    && headings.filter((_, heading) => clean($(heading).text()) === 'Parcel not found').length === 1) {
    throw new NotFoundError(PROVIDER);
  }
  if (detailsHeading.length !== 1 || historyHeading.length !== 1) {
    throw new SchemaError(PROVIDER, 'Evri returned missing or ambiguous shipment details');
  }
  const details = detailsHeading.closest('.card');
  const fields = new Map<string, string>();
  details.find('.form-group').each((_, field) => {
    const label = $(field).children('strong');
    if (label.length !== 1) throw new SchemaError(PROVIDER, 'Evri returned invalid shipment details');
    const key = clean(label.text());
    if (fields.has(key)) throw new SchemaError(PROVIDER, 'Evri returned ambiguous shipment details');
    fields.set(key, clean($(field).clone().children('strong').remove().end().text(), 250));
  });
  // The form input can hold the partner's number instead of the one asked.
  // Bind to the independent result fields, never the echoed search input.
  const system = fields.get('System Tracking:') ?? '';
  const carrierTracking = fields.get('Carrier Tracking:') ?? '';
  if (!/^[A-Z0-9]{16}$/.test(system) || clean(detailsHeading.text()) !== `Shipment Details #${system}`
    || ![system, carrierTracking].includes(requested)) {
    throw new SchemaError(PROVIDER, 'Evri returned a different shipment');
  }
  const history = historyHeading.closest('.card');
  const table = history.find('table');
  if (details[0] === history[0] || table.length !== 1
    || table.find('thead th').map((_, cell) => clean($(cell).text())).get().join('|') !== 'Date/Time|Event|Location|Comments') {
    throw new SchemaError(PROVIDER, 'Evri returned an invalid history table');
  }
  const rows = table.find('tbody > tr');
  if (!rows.length || rows.length > 500) throw new SchemaError(PROVIDER, 'Evri returned incomplete tracking history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let estimate: string | null = null;
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length !== 4 || cells.filter('[colspan], [rowspan]').length) throw new SchemaError(PROVIDER, 'Evri returned an invalid event row');
    const time = wallTime(clean(cells.eq(0).text(), 64));
    const description = clean(cells.eq(1).text(), 500);
    const location = clean(cells.eq(2).text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Evri returned an empty event');
    // Rows come newest first: the newest estimate stands.
    estimate ??= commentEstimate(clean(cells.eq(3).text(), 500));
    const key = JSON.stringify([time, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const status = evriStatus(description);
    events.push({ local_time: time, description, ...(location ? { location } : {}), ...(status ? { stage: status.stage } : {}) });
  }
  // Already newest-first on the portal. Do not sort local clocks across legs.
  const latest = events[0]!;
  const description = fields.get('Current Status:');
  if (!description) throw new SchemaError(PROVIDER, 'Evri returned no current status');
  const status = evriStatus(description);
  const weight = /^(\d+(?:\.\d+)?)\s*kg$/.exec(fields.get('Weight:') ?? '');
  const finished = ['delivered', 'returned'].includes(status?.stage ?? '') || ['delivered', 'returned'].includes(latest.stage ?? '');
  const weightKg = weight ? Number(weight[1]) : NaN;
  return {
    system, carrierTracking, carrierLabel: fields.get('Carrier:') ?? '',
    result: {
      status: status?.status ?? 'unknown', ...(status ? { current_stage: status.stage } : {}),
      last_status_text: description, last_update: null, last_update_local: latest.local_time,
      expected_delivery: finished ? null : estimate,
      ...(Number.isFinite(weightKg) && weightKg > 0 ? { weight_kg: weightKg } : {}),
      events: events.slice(0, 100),
    },
  };
}

/**
 * The carrier delivering the parcel and its own number, when the Carrier label
 * maps to a catalog network and that network's detection fits the whole Carrier
 * Tracking value. The Evri barcode repeated there names no partner number.
 */
export function deliveryPartner(shipment: EvriInternationalShipment): { carrier: string; number: string } | undefined {
  const carrier = evriPartner(shipment.carrierLabel);
  const number = shipment.carrierTracking;
  if (!carrier || number === shipment.system || !/^[A-Z0-9]{4,40}$/.test(number)
    || !(detectCarrierMatch(number).candidates as string[]).includes(carrier)) return undefined;
  return { carrier, number };
}

/** Evri's own lookup: the reply must be the parcel with this Evri barcode. */
export function parse(html: string, trackingNumber: string): CarrierResult {
  const number = normalizeEvriNumber(trackingNumber);
  const shipment = parseEvriInternational(html, number);
  if (shipment.system !== number) throw new SchemaError(PROVIDER, 'Evri returned a different shipment');
  const partner = deliveryPartner(shipment);
  return {
    ...shipment.result,
    ...(partner ? { delivery_carrier: partner.carrier, delivery_tracking_number: partner.number } : {}),
  };
}
