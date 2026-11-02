import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type ClassifiedStatus } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { classifyAramexStatus, isAramexNote } from './status.js';

export function normalizeAramexNumber(raw: string): string {
  const number = raw.replace(/[\s.-]/g, '');
  if (!/^\d{10,12}$/.test(number)) throw new InvalidInputError('Aramex', 'Aramex requires a ten- to twelve-digit shipment number');
  return number;
}

export function aramexDetailUrl(html: string, number: string): string {
  const requested = normalizeAramexNumber(number);
  const $ = load(html);
  const matches = $('a.shipment-card').filter((_, card) => clean($(card).find('.shipment-num h5').text(), 64) === requested);
  if (!matches.length) {
    if ($('.track-shipment-list h5').toArray().some(e => clean($(e).text(), 300) === 'No results found with current selection, please enter a different tracking number.')) {
      throw new NotFoundError('Aramex');
    }
    throw new SchemaError('Aramex', 'Aramex did not return the requested shipment card');
  }
  if (matches.length !== 1) throw new SchemaError('Aramex', 'Aramex returned ambiguous shipment cards');
  const url = new URL(matches.attr('href') ?? '', 'https://www.aramex.com');
  if (url.origin !== 'https://www.aramex.com' || url.pathname !== '/track/details' || !url.searchParams.get('q') || url.username || url.password || url.hash) {
    throw new SchemaError('Aramex', 'Aramex returned an invalid detail link');
  }
  return url.href;
}

export function aramexDetailRedirect(location: string, original: string): string {
  const bound = new URL(original);
  const url = new URL(location, bound);
  if (url.origin !== bound.origin || !/^\/[a-z]{2}\/en\/track\/details$/.test(url.pathname)
    || url.search !== bound.search || url.username || url.password || url.hash) {
    throw new SchemaError('Aramex', 'Aramex returned an invalid detail redirect');
  }
  return url.href;
}

export function parseAramex(html: string, number: string): CarrierResult {
  const requested = normalizeAramexNumber(number);
  const $ = load(html);
  const identifiers = $('.shipment-info .shipment-num h5');
  if (identifiers.length !== 1 || clean(identifiers.text(), 64) !== requested) throw new SchemaError('Aramex', 'Aramex returned a different shipment detail');
  const tables = $('table.collected');
  if (tables.length !== 1 || !tables.find('th.col-activity').length) throw new SchemaError('Aramex');
  const rows = tables.find('tr');
  if (rows.length > 500) throw new SchemaError('Aramex', 'Aramex returned excessive shipment history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  rows.each((_, row) => {
    if (!$(row).children('td').length) return;
    if ($(row).find('td.activity').length !== 1) throw new SchemaError('Aramex', 'Aramex returned an incomplete scan row');
    const description = clean($(row).find('td.activity').text(), 500);
    if (!description) throw new SchemaError('Aramex', 'Aramex returned a scan with no description');
    const day = clean($(row).find('.date-time .date').text(), 32);
    const clock = clean($(row).find('.date-time .time').text(), 16);
    // Parsing in UTC validates the calendar digits only. The resulting wall
    // time carries no offset because this cross-border portal does not give one.
    const clockText = [day, clock].filter(Boolean).join(' ');
    const parsed = DateTime.fromFormat(clockText, 'dd MMM yy HH:mm', { locale: 'en', zone: 'UTC' });
    const local = parsed.isValid ? parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) : null;
    const location = [clean($(row).find('.addr .city').text(), 120), clean($(row).find('.addr .country').text(), 80)].filter(Boolean).join(', ');
    const key = `${local ?? clockText}\u0000${description}\u0000${location}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mapped = classifyAramexStatus(description);
    events.push({ description, ...(location ? { location } : {}), ...(local ? { local_time: local } : clockText ? { provider_time_text: clockText } : {}), ...(mapped ? { stage: mapped.stage } : {}) });
  });
  if (!events.length) throw new IndeterminateError('Aramex', 'Aramex returned no shipment history');
  const latest = events[0]!;
  // Contact notes, payments and checks stage nothing; the newest other scan
  // gives the status.
  const mapped = currentStatus(events.find((event) => !isAramexNote(event.description ?? ''))?.description ?? '');
  const service = detail($, 'Shipment Type');
  // The weight covers the whole shipment, so it is read only for a single item.
  const weight = detail($, 'Number of Items') === '1' ? weightKg(detail($, 'Weight')) : null;
  // The progress rail names the destination's country and city; only the country is kept.
  const destinations = $('.dest-info .country');
  const destination = destinations.length === 1 ? clean(destinations.text(), 80) : '';
  const code = destination ? countryCode(destination) : null;
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time ?? null,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(code ? { destination_country: code } : destination ? { destination_country_name: destination } : {}),
    events: events.slice(0, 100) };
}

function currentStatus(description: string): ClassifiedStatus | undefined {
  const mapped = classifyAramexStatus(description);
  if (mapped) return mapped;
  const worded = classifyWording(description);
  return worded.source === 'none' ? undefined : { status: languageStageStatus(worded.stage), stage: worded.stage };
}

/** The value beside one of the page's labelled shipment details, such as "Shipment Type". */
function detail($: ReturnType<typeof load>, title: string): string {
  const values = $('.shipment-details-title').filter((_, element) => clean($(element).text(), 40) === title)
    .map((_, element) => clean($(element).siblings('.shipment-details-data').first().text(), 80)).get();
  return values.length === 1 ? values[0]! : '';
}

/** "0.5 KG" or "0.15 LB" in kilograms, to the gram; anything else is not read. */
function weightKg(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(KG|LB)$/i.exec(value);
  const amount = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isFinite(amount) || amount <= 0) return null;
  const grams = Math.round((match[2]!.toUpperCase() === 'LB' ? amount * 0.45359237 : amount) * 1000);
  return grams > 0 ? grams / 1000 : null;
}
