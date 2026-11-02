import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { expressOneQuiet, expressOneStage } from './status.js';

export const PROVIDER = 'Express One';

// The tracker's parcel IDs: twenty-four digits, and thirteen on some parcels.
const NUMBER = /^(?:\d{13}|\d{24})$/;
// The page's answer for a number it does not know, in English and Hungarian.
const ABSENT = new Set([
  'The requested package is currently unavailable in our system.',
  'A keresett csomag jelenleg nem elérhető a rendszerünkben.',
]);
// The heading over each history: the parcel's way to the recipient, and its way back.
const LEGS = new Map<string, 'outbound' | 'return'>([
  ['shipment history', 'outbound'], ['kiszállítás történet', 'outbound'],
  ['return history', 'return'], ['visszaküldés történet', 'return'],
]);
// The English page dates its days 23-09-2026, the Hungarian one 2026-09-23.
const DAY = /^(?:(\d{2})-(\d{2})-(\d{4})|(\d{4})-(\d{2})-(\d{2}))$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const CODE = /^[A-Z0-9]{2,4}$/;
// A hub scan ends with its place, "(HU - Budapest)".
const PLACE = /^(.*?)\s*\(([A-Z]{2}) - ([^()]{1,80})\)$/;
const MAX_ROWS = 300;
const MAX_EVENTS = 200;

type Selection = ReturnType<CheerioAPI>;
type Leg = 'outbound' | 'return';
interface Row { leg: Leg; local_time: string; code: string; description: string; location?: string; index: number }

/** A parcel ID as Express One's tracker takes it: thirteen or twenty-four digits. */
export function normalizeExpressOneNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Express One tracks thirteen- and twenty-four-digit parcel IDs');
  return number;
}

/** A day heading and a row's clock as one wall time. The page gives no offset. */
function wallClock(day: string, time: string): string | null {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  if (!date || !clock) return null;
  const [year, month, dayOfMonth] = date[3] ? [date[3], date[2]!, date[1]!] : [date[4]!, date[5]!, date[6]!];
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(dayOfMonth),
    hour: Number(clock[1]), minute: Number(clock[2]), second: Number(clock[3] ?? 0) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/** The number the page looked up, from its link to the other language. */
function lookedUp($: CheerioAPI): string | null {
  const links = $('.lang a[href*="setlang="]');
  if (links.length !== 1) return null;
  try {
    return new URL(links.attr('href') ?? '', 'https://tracking.expressone.hu/').searchParams.get('plc_number');
  } catch {
    return null;
  }
}

/** One history block's rows, oldest first as the page lists them. */
function rowsOf($: CheerioAPI, block: Selection, leg: Leg, start: number): Row[] {
  const rows: Row[] = [];
  let day = '';
  block.children().each((_, child) => {
    const node = $(child);
    if (node.hasClass('headline')) {
      day = clean(node.text(), 20);
      return;
    }
    if (!node.is('table')) return;
    node.find('tr').each((_, tr) => {
      const cells = $(tr).children('td');
      if (cells.length < 3) throw new SchemaError(PROVIDER, 'Express One returned a scan without its fields');
      const local = wallClock(day, clean(cells.eq(0).text(), 16));
      if (!local) throw new SchemaError(PROVIDER, 'Express One returned an invalid scan time');
      const code = clean(cells.eq(1).text(), 8);
      const text = clean(cells.eq(2).text(), 400);
      const place = PLACE.exec(text);
      const description = place ? place[1]! : text;
      if (!CODE.test(code) || !description) throw new SchemaError(PROVIDER, 'Express One returned a scan without its code or wording');
      rows.push({ leg, local_time: local, code, description, ...(place ? { location: `${place[3]!.trim()}, ${place[2]!}` } : {}),
        index: start + rows.length });
    });
  });
  return rows;
}

/**
 * Stages each row. A return leg is all return; DLS registers a parcel when
 * nothing but the sender's data came before it, and belongs to the hub's
 * handling after a scan there.
 */
function stageOf(row: Row, scanned: boolean): Stage | undefined {
  if (row.leg === 'return') return 'returned';
  if (row.code === 'DLS') return scanned ? 'in_transit' : 'registered';
  return expressOneStage(row.code);
}

/**
 * The tracker's page for one parcel: its scans, with the return leg's when the
 * parcel went back. The page shows no parcel field; it binds to the number its
 * link to the other language looks up. An unknown number returns HTTP 404 with
 * the form and a notice. The progress rail, the courier's arrival window and
 * the signature are never read.
 */
export function parseExpressOne(html: string, raw: string, status = 200): CarrierResult {
  const number = normalizeExpressOneNumber(raw);
  const $ = load(html);
  const shown = lookedUp($);
  if (shown === null) throw new IndeterminateError(PROVIDER, 'Express One did not return its tracking page');
  if (normalizeTrackingNumber(shown) !== number) throw new SchemaError(PROVIDER, 'Express One answered for a different number');
  const blocks = $('div.history');
  const notices = $('.alert-danger');
  if (status === 404 || !blocks.length) {
    const notice = clean(notices.find('p b').first().text(), 200);
    if (status === 404 && !blocks.length && notices.length === 1 && ABSENT.has(notice)
      && returnedTrackingNumber($('input#plc_number').val()) === number) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Express One did not return the parcel');
  }
  if (status !== 200) throw new IndeterminateError(PROVIDER, 'Express One did not return the parcel');

  const rows: Row[] = [];
  const legs = new Set<Leg>();
  blocks.each((_, element) => {
    const block = $(element);
    const leg = LEGS.get(clean(block.prevAll('h5').first().text(), 80).toLocaleLowerCase('hu-HU'));
    if (!leg || legs.has(leg)) throw new SchemaError(PROVIDER, 'Express One parcel history changed');
    legs.add(leg);
    rows.push(...rowsOf($, block, leg, rows.length));
    if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Express One returned too many scans');
  });
  if (!legs.has('outbound')) throw new SchemaError(PROVIDER, 'Express One parcel history changed');
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Oldest first, equal clocks in the page's order, to stage DLS by what came before it.
  rows.sort((left, right) => left.local_time < right.local_time ? -1 : left.local_time > right.local_time ? 1 : left.index - right.index);
  const scans: { event: CarrierEvent; quiet: boolean; index: number }[] = [];
  const seen = new Set<string>();
  let scanned = false;
  for (const row of rows) {
    const stage = stageOf(row, scanned);
    if (row.leg === 'outbound' && row.code !== 'PRE' && row.code !== 'DLS') scanned = true;
    const event: CarrierEvent = { local_time: row.local_time, description: row.description, provider_code: row.code,
      ...(row.location ? { location: row.location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const identity = JSON.stringify([row.leg, event.local_time, row.code, event.description, event.location ?? null]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push({ event, quiet: row.leg === 'outbound' && expressOneQuiet(row.code), index: row.index });
  }
  // Newest first; equal clocks keep the later row first.
  scans.reverse();
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  // A rescheduled day keeps the stage of the scan before it.
  const current = scans.find(({ quiet }) => !quiet)?.event;
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
  };
}
