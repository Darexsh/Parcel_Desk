import { load } from 'cheerio';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { dhlEcommerceUkStage, statusForStage } from './status.js';

const PROVIDER = 'DHL eCommerce UK';
const ZONE = 'Europe/London';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const PANEL = '#MainContent_psTrackMyParcel_';
const NOT_FOUND = 'We are unable to find a match for the shipment number you have entered.';

/** A fourteen-digit shipment number, or the nine-digit return number that starts with 9. */
export function normalizeDhlEcommerceUkNumber(raw: string): string {
  const number = raw.trim().replace(/[\s.-]/g, '');
  if (!/^(?:\d{14}|9\d{8})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'DHL eCommerce UK tracking requires a fourteen-digit shipment number');
  }
  return number;
}

/** `06th October 2026`, with an optional weekday in front. */
function day(text: string): string | undefined {
  const match = /(\d{1,2})(?:st|nd|rd|th) ([A-Z][a-z]+) (\d{4})$/.exec(text);
  return match ? zonedTime(`${match[1]!.padStart(2, '0')} ${match[2]} ${match[3]}`, 'dd MMMM yyyy', ZONE, { locale: 'en' })?.iso.slice(0, 10) : undefined;
}

/** A sentence names the number asked for or no number at all; it is kept without it. */
function sentence(text: string, number: string): string | undefined {
  const named = text.match(/\d{7,}/g) ?? [];
  if (named.length > 1 || (named.length === 1 && named[0] !== number)) return undefined;
  return clean(text.replace(number, ' ').replace(/\s+/g, ' '), 200) || undefined;
}

export function parseDhlEcommerceUk(html: string, rawNumber: string): CarrierResult {
  const number = normalizeDhlEcommerceUkNumber(rawNumber);
  const $ = load(html);
  const notice = $(`${PANEL}ctl01`);
  const status = $(`${PANEL}divStatus`);
  // Without the tracker's own notice element the page is something else: a block or a redesign.
  if (notice.length !== 1) throw new IndeterminateError(PROVIDER, 'DHL eCommerce UK did not return its tracking page');
  if (!status.length) {
    const hidden = /display\s*:\s*none/i.test(notice.attr('style') ?? '');
    if (!hidden && clean(notice.text(), 600).startsWith(NOT_FOUND)) throw new NotFoundError(PROVIDER);
    // The page comes back empty when it did not look the number up.
    throw new IndeterminateError(PROVIDER, 'DHL eCommerce UK returned no answer for the shipment');
  }
  const headline = clean(status.find('h3').first().text(), 300);
  if (status.length !== 1 || !headline.startsWith(`Your shipment ${number} `) || !sentence(headline, number)) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce UK returned a different shipment');
  }
  // The photo panel reuses the journey's layout; only the block under this heading is the history.
  const journey = $('div.parcel-journey').filter((_, node) => clean($(node).find('h4').first().text(), 60) === "Your parcel's journey");
  if (journey.length !== 1) throw new SchemaError(PROVIDER, 'DHL eCommerce UK returned no parcel journey');
  const rows = journey.find('table tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DHL eCommerce UK returned too many scans');
  const header = rows.first().children('td, th').map((_, node) => clean($(node).text(), 20)).get();
  if (header.join('|') !== 'Date|Time|Message') throw new SchemaError(PROVIDER, 'DHL eCommerce UK tracking columns changed');
  const events: (CarrierEvent & { stage?: Stage })[] = [];
  for (const row of rows.slice(1).toArray()) {
    const cells = $(row).children('td');
    const description = cells.length === 3 ? sentence(clean(cells.eq(2).text(), 400), number) : undefined;
    if (!description) throw new SchemaError(PROVIDER, 'DHL eCommerce UK returned an invalid scan');
    const date = day(clean(cells.eq(0).text(), 40));
    const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clean(cells.eq(1).text(), 10));
    // The network runs in one zone, so a row's clock is a British one.
    const time = date && clock ? zonedTime(`${date} ${clock[0]}`, 'yyyy-MM-dd HH:mm', ZONE)?.iso : undefined;
    const stage = dhlEcommerceUkStage(description);
    events.push({ description, ...(time ? { time } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'DHL eCommerce UK returned no parcel history');
  // Rows are newest first. A depot scan can follow a delivery scan, and the
  // page then shows the parcel at the depot again, so the newest row decides.
  const latest = events[0]!;
  // A refused shipment goes back through the depot, and only the headline says
  // it is returning to the sender.
  const stage = /\bhas now been returned to the sender\b/i.test(headline) ? 'returned' : latest.stage;
  const due = /^Your shipment is due to be delivered on (.+)$/.exec(clean($(`${PANEL}LO_02_pnlSecondaryDesc`).text(), 200))?.[1];
  const planned = due ? day(due) : undefined;
  return {
    status: stage ? statusForStage(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description ?? null,
    last_update: latest.time ?? null,
    // The page keeps a planned day after it has passed, and for a returning shipment.
    expected_delivery: planned && stage !== 'delivered' && stage !== 'returned' && (!latest.time || planned >= latest.time.slice(0, 10)) ? planned : null,
    ...(stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
