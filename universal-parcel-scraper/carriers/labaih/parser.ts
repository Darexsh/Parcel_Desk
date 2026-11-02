import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { labaihStage } from './status.js';

export const PROVIDER = 'LaBaih';
// A page is about 110 kB, most of it inline icons.
export const LABAIH_MAX_BYTES = 1_000_000;

const NUMBER = /^\d{14}$/;
// The heading over the shipment: the number, then the shop's own reference.
const TITLE = /^Shipment Tracking - (\d{14})(?:\s+-.*)?$/;
// A scan's wall clock, without a zone: "2026-01-02 13:45:06".
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|<title>\s*(?:Just a moment|Attention Required!|Access Denied)/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A failed attempt's reason as the page words it, from the courier's list: letters only.
const REASON = /^[\p{L}][\p{L}\s'’/&().,-]{0,79}$/u;
const MAX_ROWS = 300;

/** A LaBaih number: fourteen digits, which begin with the date and time it was created. */
export function normalizeLabaihNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'LaBaih numbers are fourteen digits');
  return number;
}

/** A challenge or block page in place of the tracker. */
export function assertNotChallenged(html: string): void {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'LaBaih answered with a browser check');
}

/**
 * A scan's wording. A failed attempt's reason follows a colon and can go on,
 * after another colon, with the recipient's district or city as given:
 * "Unsuccessful Delivery: Wrong Customer District: …". Only the reason is
 * kept, and only when it is words; phone numbers are dropped.
 */
export function labaihWording(text: string): string {
  const [head = '', reason = ''] = clean(text, 500).split(':').map((part) => clean(part, 500));
  const label = clean(head.replace(PHONE, ''), 160).replace(/[\s,;\-–]+$/, '');
  return REASON.test(reason) ? `${label}: ${reason}` : label;
}

/** A scan's wall clock in `local_time` form, checked against the calendar. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[1]) < 2015) throw new SchemaError(PROVIDER, 'LaBaih returned an invalid scan time');
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

interface Scan { event: CarrierEvent; clock: string; index: number }

/**
 * The tracker's English page for one number, `track.mylabaih.com/track/en/?cn=`,
 * which the site renders on its server: a heading with the number and the shop's
 * reference, the shop, a progress rail, then the history, newest first. Each
 * scan has a wording, a wall clock without a zone and, for an arrival at a
 * distribution centre, its city. An unknown number is a redirect the adapter
 * reads before this. The shop, its reference and the rail are not kept.
 */
export function parseLabaih(html: string, raw: string): CarrierResult {
  const number = normalizeLabaihNumber(raw);
  assertNotChallenged(html);
  const $ = load(html);
  const titles = $('.shipper-details h1');
  if (titles.length === 0) throw new SchemaError(PROVIDER, 'LaBaih returned a page without a shipment');
  if (titles.length > 1) throw new SchemaError(PROVIDER, 'LaBaih returned several shipments');
  const shown = TITLE.exec(clean(titles.text(), 200))?.[1];
  if (!shown) throw new SchemaError(PROVIDER, 'LaBaih returned a shipment without its number');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'LaBaih answered for another shipment');

  const lists = $('.shipment-details .collapsible');
  if (lists.length !== 1) throw new SchemaError(PROVIDER, 'LaBaih returned a page without its history');
  const rows = lists.find('.list-update').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'LaBaih returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const headings = $(row).find('h3');
    const metas = $(row).find('.up-meta');
    if (headings.length !== 1 || metas.length !== 1) throw new SchemaError(PROVIDER, 'LaBaih returned an invalid scan');
    const description = labaihWording(headings.text());
    if (!description) throw new SchemaError(PROVIDER, 'LaBaih returned a scan without its wording');
    const location = clean(metas.find('strong').text(), 80);
    const meta = metas.clone();
    meta.find('strong').remove();
    const clock = wallClock(clean(meta.text(), 60));
    const staged = labaihStage(description);
    const event: CarrierEvent = {
      local_time: clock,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, clock, index });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Newest first; scans at the same second keep the page's order.
  const events = scans.sort((left, right) => (left.clock < right.clock ? 1 : left.clock > right.clock ? -1 : left.index - right.index))
    .map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
