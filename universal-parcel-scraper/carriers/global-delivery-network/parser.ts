import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { gdnStage } from './status.js';

export const PROVIDER = 'Global Delivery Network';
export const GDN_MAX_BYTES = 1_000_000;
const MAX_ROWS = 500;
// "2/15/2023 11:21:00 AM": the scan's wall clock, without a zone.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/;
// "AUCKLAND - NZ", "WHIPPANY, NJ - US": the place, then its country's code.
const PLACE = /^(.+?)\s+-\s+([A-Z]{2})$/;

/** The tracker's parcel numbers: twelve digits. */
export function normalizeGdnNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Global Delivery Network parcel numbers are twelve digits');
  return number;
}

export function gdnUrl(raw: string): string {
  return `https://pds.gdnparcel.com/pds_tracking.asp?track=${normalizeGdnNumber(raw)}`;
}

function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  if (!match) throw new SchemaError(PROVIDER, 'Global Delivery Network returned an unreadable scan clock');
  const [, month, day, year, hour, minute, second, half] = match;
  const hours = (Number(hour) % 12) + (half === 'PM' ? 12 : 0);
  const local = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}T${String(hours).padStart(2, '0')}:${minute}:${second}`;
  if (Number(hour) < 1 || Number(hour) > 12 || Number.isNaN(Date.parse(`${local}Z`))) {
    throw new SchemaError(PROVIDER, 'Global Delivery Network returned an invalid scan clock');
  }
  return local;
}

/**
 * The tracker's page for one parcel: its number, the recipient's address, a
 * partner's reference and the scans newest first, in a table. A number it
 * does not know gets a page that says it cannot locate the package. The
 * recipient, the address, the weight and the partner's reference are not kept.
 */
export function parseGdn(html: string, raw: string): CarrierResult {
  const number = normalizeGdnNumber(raw);
  if (html.length > GDN_MAX_BYTES) throw new SchemaError(PROVIDER, 'Global Delivery Network returned an excessive page');
  const $ = load(html);
  const field = (label: string) => {
    const inputs = $('label').filter((_, node) => clean($(node).text(), 100) === label).next('input');
    return inputs.length === 1 ? clean(inputs.attr('value'), 100) : null;
  };
  const parcel = field('Parcel Number:');
  if (parcel === null) {
    if (/Unable to locate the selected Package\./i.test($('h1').text())) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Global Delivery Network returned a page without its parcel');
  }
  if (normalizeTrackingNumber(parcel) !== number) throw new SchemaError(PROVIDER, 'Global Delivery Network answered for another parcel');
  const table = $('#logistics_article table');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Global Delivery Network returned a page without its history');
  const rows = table.find('tr').toArray().filter((row) => $(row).children('td').length > 0);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Global Delivery Network returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 500));
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Global Delivery Network returned an unreadable scan');
    const [clock, description, where] = cells as [string, string, string];
    if (!description) throw new SchemaError(PROVIDER, 'Global Delivery Network returned a scan without wording');
    const place = PLACE.exec(where);
    const location = place ? `${place[1]}, ${place[2]}` : '';
    const mapped = gdnStage(description);
    const classified = mapped ? { stage: mapped, source: 'carrier_map' } : classifyWording(description, 'in_transit');
    const event: CarrierEvent = { local_time: wallClock(clock), description, ...(location ? { location } : {}),
      ...(classified.source !== 'none' ? { stage: classified.stage, stage_source: classified.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page lists the scans newest first.
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = countryCode(field('Country:'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
