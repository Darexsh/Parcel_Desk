import { load } from 'cheerio';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber, uspsPackageIdentifier } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { a1PostScan } from './status.js';

export const PROVIDER = 'A1 POST';
// The page is about 40 kB, nearly all of it the site's own markup.
export const A1_POST_MAX_BYTES = 512 * 1024;
// A1 POST's server, whose clock its own rows carry, is in Bulgaria.
const SOFIA = 'Europe/Sofia';
// The tracker takes the partner's label number: any four to forty letters and digits, with a digit.
const NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
// "06.07.2026 10:41", a wall clock to the minute.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/;
// The row the tracker gives a number it does not know, in either language.
const NOT_FOUND = /^(?:Package not found|Пратката не е намерена)$/iu;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)|captcha/i;
// A US ZIP code ending a partner's row, the recipient's or the shipper's.
const ZIP = /,?\s+\d{5}(?:-\d{4})?$/;
const MAX_ROWS = 300;

/**
 * A number as the tracker looks it up. A USPS routing barcode opens with the
 * recipient's ZIP code, so only the package identifier after it is sent; one
 * without a clean identifier is refused.
 */
export function normalizeA1PostNumber(raw: string): string {
  const compact = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const number = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'A1 POST tracks four to forty letters and digits');
  return number;
}

/** A row's clock as an ISO wall time; the day must exist. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'A1 POST returned an invalid row time');
  return `${day}T${match![4]}:${match![5]}:00`;
}

interface PartnerLink { readonly name: string; readonly href: string }

/** A partner's number from its link, without the recipient's ZIP code a USPS routing barcode opens with. */
function linkNumber(value: string): string {
  const compact = normalizeTrackingNumber(clean(value, 64));
  const number = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return NUMBER.test(number) ? number : '';
}

/**
 * The carrier the page sends the parcel's tracking to, "Track at partner
 * website" and a link named after it. It is named only when the catalog knows
 * the name, the link is on that carrier's host if the catalog lists it, and the
 * link carries one number that carrier's rules offer. That number is the
 * delivery number when it is not the one asked.
 */
function partnerOf(link: PartnerLink | undefined, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  let url: URL | undefined;
  try {
    url = link ? new URL(link.href) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || !['https:', 'http:'].includes(url.protocol)) return {};
  const carrier = carrierIdFromPartner(link!.name, url.href);
  if (!carrier || carrier === 'a1-post') return {};
  const numbers = new Set([...url.searchParams.values()].map(linkNumber).filter(Boolean));
  const [delivery] = numbers;
  if (numbers.size !== 1 || !(detectCarrierMatch(delivery!).candidates as string[]).includes(carrier)) return {};
  return { delivery_carrier: carrier, ...(delivery !== number ? { delivery_tracking_number: delivery } : {}) };
}

/**
 * A1 POST's tracking page for one number, `track.php?t={number}`, which the
 * site renders on its server: a table of rows, newest first, each a clock and
 * a line of text, and for a parcel a partner carries a first row without a
 * clock that links to the partner's tracker. The page does not repeat the
 * number; it answers the one request, and looks up only the whole number. A
 * number it does not know gets one row, "Package not found", at the server's
 * current time.
 */
export function parseA1Post(html: string, raw: string): CarrierResult {
  const number = normalizeA1PostNumber(raw);
  const $ = load(html);
  const table = $('form#track #res table#ritm');
  if (table.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'A1 POST answered with a bot check');
    throw new SchemaError(PROVIDER, 'A1 POST returned a page without its tracking result');
  }
  const nodes = table.find('tr').toArray();
  if (nodes.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'A1 POST returned an oversized history');
  if (!nodes.length) throw new IndeterminateError(PROVIDER, 'A1 POST returned no rows for the number');

  let partner: PartnerLink | undefined;
  const rows: { clock: string; text: string }[] = [];
  for (const node of nodes) {
    const cells = $(node).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'A1 POST returned an invalid row');
    const clock = clean(cells.eq(0).text(), 40);
    if (!clock) {
      const links = cells.eq(1).find('a[href]');
      if (links.length !== 1 || partner) throw new SchemaError(PROVIDER, 'A1 POST returned a row without its time');
      partner = { name: clean(links.text(), 80), href: links.attr('href') ?? '' };
      continue;
    }
    const text = clean(cells.eq(1).text(), 500);
    if (!text) throw new SchemaError(PROVIDER, 'A1 POST returned a row without text');
    rows.push({ clock: wallClock(clock), text });
  }
  if (rows.some((row) => NOT_FOUND.test(row.text))) {
    if (rows.length === 1 && !partner) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'A1 POST returned a history with its not-found row');
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const { clock, text } of rows) {
    const key = JSON.stringify([clock, text]);
    if (seen.has(key)) continue;
    seen.add(key);
    const scan = a1PostScan(text.replace(ZIP, ''));
    // A1 POST's own rows and the Bulgarian office scans carry Sofia's clock.
    // A partner's scans abroad may carry their own place's, so they stay wall clocks.
    const time = scan.home ? isoTime(clock, SOFIA)?.iso : undefined;
    if (scan.home && !time) throw new SchemaError(PROVIDER, 'A1 POST returned an invalid row time');
    events.push({
      ...(time ? { time } : { local_time: clock }),
      description: scan.wording,
      ...(scan.place ? { location: scan.place } : {}),
      ...(scan.stage ? { stage: scan.stage.stage, stage_source: scan.stage.source } : {}),
    });
  }
  // A partner's link alone shows a parcel A1 POST knows but has not scanned.
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // The page lists the rows by their clocks, which can be several places', so its order stands.
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...partnerOf(partner, number),
    events,
  };
}
