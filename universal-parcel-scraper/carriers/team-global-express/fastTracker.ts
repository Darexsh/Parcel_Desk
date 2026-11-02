import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { PROVIDER } from './parser.js';
import { fastTrackerStage } from './status.js';

/** New Zealand's tracker, NZ National Networks' Fast Tracker: one page that searches and opens an item. */
export const TGE_NZ_TRACKER = 'https://fasttracker.teamglobalexp.co.nz/fast-tracker.aspx';
// A consignment of several items is about 12 kB, an item's page about 16 kB.
export const TGE_NZ_MAX_BYTES = 512 * 1024;
// A New Zealand consignment: the sender's four letters and seven digits. Its
// label prints five more digits after them, which the search does not take.
const CONSIGNMENT = /^[A-Z]{4}\d{7}$/;
const LABEL = /^([A-Z]{4}\d{7})\d{5}$/;
// The id a result row opens its item's page with.
const ITEM_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const CLOCK = /^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}$/;
const ESTIMATE = /^\d{2}\/\d{2}\/\d{4}$/;
const WEIGHT = /^\d{1,6}(?:\.\d{1,3})?$/;
const ZONE = 'Pacific/Auckland';
// Bot checks Azure's front door could put in place of the page.
const CHALLENGE = /<title>\s*(?:Access Denied|Request blocked|403 Forbidden)|captcha/i;
// Each item has a page of its own; a consignment past this many is read by its first ones.
export const MAX_ITEM_PAGES = 10;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** The consignment Fast Tracker searches for a number of New Zealand's layout, or null for another number. */
export function fastTrackerConsignment(number: string): string | null {
  return CONSIGNMENT.test(number) ? number : LABEL.exec(number)?.[1] ?? null;
}

/** The search for one consignment, as the page's track box sends it. */
export function fastTrackerSearchUrl(consignment: string): string {
  const url = new URL(TGE_NZ_TRACKER);
  url.searchParams.set('fasttracker_action', 'search');
  url.searchParams.set('ConsignmentNumber', consignment);
  return url.toString();
}

/** The page of one item, by the id its row in the search carries. */
export function fastTrackerItemUrl(id: string): string {
  if (!ITEM_ID.test(id)) throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid item id');
  const url = new URL(TGE_NZ_TRACKER);
  url.searchParams.set('ConsignmentDetailId', id);
  return url.toString();
}

/** A page without what Fast Tracker's own page has: a browser check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Team Global Express answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** One item of a consignment the search found: its number (`{consignment}-NN`), its page's id and its weight. */
export interface FastTrackerItem { number: string; id: string; kilograms: number | null }

/**
 * The search's answer for one consignment: a row per item, which links the
 * item's page, or a notice that names the number when nothing matched. The
 * search matches whole numbers only.
 */
export function parseFastTrackerSearch(html: string, consignment: string): FastTrackerItem[] {
  const $ = load(html);
  const notice = $('#noResultP');
  const table = $('#consTable_divConsignments');
  if (notice.length && !table.length) {
    if (!clean(notice.text(), 300).toUpperCase().includes(consignment)) throw new IndeterminateError(PROVIDER, 'Team Global Express answered for another search');
    throw new NotFoundError(PROVIDER);
  }
  if (table.length !== 1) unexpected(html, 'Team Global Express returned a search reply without its results');
  const rows = table.find('tr').filter((_, row) => $(row).find('td').length > 0);
  if (!rows.length || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Team Global Express returned a search reply without its items');
  const item = new RegExp(`^${consignment}-\\d{1,4}$`);
  const items = rows.map((_, row) => {
    const cells = $(row).find('td');
    const link = cells.first().find('a');
    const href = link.attr('href') ?? '';
    const id = /[?&]ConsignmentDetailId=([^&#]+)/i.exec(href)?.[1] ?? '';
    const weight = clean(cells.eq(5).text(), 16);
    return { number: clean(link.text(), 40).toUpperCase(), id, kilograms: WEIGHT.test(weight) ? Number(weight) : null };
  }).get();
  if (items.some(({ number, id }) => !number || !id)) throw new SchemaError(PROVIDER, 'Team Global Express returned an item without its number or page');
  const own = items.filter(({ number }) => item.test(number));
  if (!own.length) throw new IndeterminateError(PROVIDER, 'Team Global Express answered for another consignment');
  if (own.some(({ id }) => !ITEM_ID.test(id))) throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid item id');
  return own;
}

/** One item's page as read: its scans, newest first, its service and its estimate. */
export interface FastTrackerItemPage { events: CarrierEvent[]; service: string; estimate: string | null }

/** A scan's clock, `dd/MM/yy HH:mm`, New Zealand's. */
function scanTime(value: string): string {
  const day = CLOCK.test(value) ? DateTime.fromFormat(value, 'dd/MM/yy HH:mm', { zone: 'UTC' }) : null;
  const parsed = day?.isValid && day.toFormat('dd/MM/yy HH:mm') === value ? zonedTime(value, 'dd/MM/yy HH:mm', ZONE) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Team Global Express returned an invalid scan time');
  return parsed.iso;
}

/**
 * The page of one item. It names the item, its service and estimate, and its
 * scans, oldest first, with their wording, time and branch. Where it came
 * from and goes to, the references, the receiver who signed and the signature
 * are not kept.
 */
export function parseFastTrackerItem(html: string, item: FastTrackerItem): FastTrackerItemPage {
  const $ = load(html);
  const named = $('#ConsignmentDetails_lblConsignment');
  if (named.length !== 1) unexpected(html, 'Team Global Express returned an item page without its item');
  if (clean(named.text(), 40).toUpperCase() !== item.number) throw new IndeterminateError(PROVIDER, 'Team Global Express answered for another item');
  const rows = $('td[id^="ConsignmentDetails_repEvents_eventDescription_"]').closest('tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Team Global Express returned an oversized history');
  const events = rows.toArray().map((row): CarrierEvent => {
    const cells = $(row).find('td');
    const description = clean(cells.eq(0).text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'Team Global Express returned a scan without wording');
    const location = clean(cells.eq(3).text(), 80);
    const staged = fastTrackerStage(description);
    const event: CarrierEvent = {
      time: scanTime(clean(cells.eq(1).text(), 32)),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return event;
  }).reverse();
  const estimate = clean($('#ConsignmentDetails_lblEDDVal').text(), 16);
  const day = ESTIMATE.test(estimate) ? DateTime.fromFormat(estimate, 'dd/MM/yyyy', { zone: 'UTC' }) : null;
  return { events, service: clean($('#ConsignmentDetails_lblService').text(), 80), estimate: day?.isValid ? day.toISODate() : null };
}

/**
 * A consignment from its items' pages. Their scans are kept together, newest
 * first, a scan its items share once. The consignment is delivered once every
 * item read is; until then a delivered item leaves it in transit.
 */
export function fastTrackerResult(number: string, consignment: string, items: readonly FastTrackerItem[], pages: readonly FastTrackerItemPage[]): CarrierResult {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const event of pages.flatMap((page) => page.events)) {
    const key = JSON.stringify([event.time, event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; of two scans at one minute, the one read first stays first.
  const order = new Map(events.map((event, index) => [event, index]));
  events.sort((left, right) => Date.parse(right.time!) - Date.parse(left.time!) || order.get(left)! - order.get(right)!);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  let stage = current?.stage as Stage | undefined;
  const itemStage = (page: FastTrackerItemPage) => page.events.find((event) => event.stage)?.stage;
  if (stage === 'delivered' && pages.some((page) => itemStage(page) !== 'delivered')) stage = 'in_transit';
  const source = stage && stage !== current?.stage ? 'carrier_map' : current?.stage_source;
  const service = pages.map((page) => page.service).find(Boolean);
  const estimate = pages.map((page) => page.estimate).find(Boolean) ?? null;
  const kilograms = items.every((item) => item.kilograms !== null) ? items.reduce((sum, item) => sum + item.kilograms!, 0) : 0;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' ? null : estimate,
    timezone: ZONE,
    ...(service ? { service_name: service } : {}),
    ...(kilograms > 0 ? { weight_kg: Math.round(kilograms * 1000) / 1000 } : {}),
    destination_country: 'NZ',
    ...(consignment !== number ? { canonical_tracking_number: consignment } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS || items.length > pages.length ? { history_truncated: true } : {}),
  };
}
