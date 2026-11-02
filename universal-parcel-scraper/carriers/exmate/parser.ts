import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { normalizeJapanPostNumber } from '../japan-post/adapter.js';
import { normalizeSagawaNumber } from '../sagawa/parser.js';
import { exmateStage } from './status.js';

export const PROVIDER = 'Exmate';
// A long history page is about fifteen kilobytes.
export const EXMATE_MAX_BYTES = 512 * 1024;

const NUMBER = /^EXK\d{8}J$/;
// The tracker's whole answer to a number it has no record of.
const NO_DATA = /^\s*No Data!*\s*$/i;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
// The country each scan names. Korea and Japan each keep one civil time.
const ZONES: Readonly<Record<string, string>> = { KOREA: 'Asia/Seoul', JAPAN: 'Asia/Tokyo' };
const SERVICE = /^Local Delivery Service\s*:\s*([A-Z0-9-]*)$/i;
// The local carriers the page links to, by their tracker's host, with the
// check their own adapter applies to the number.
const PARTNERS: ReadonlyMap<string, { carrier: string; normalize: (raw: string) => string }> = new Map([
  ['k2k.sagawa-exp.co.jp', { carrier: 'sagawa', normalize: normalizeSagawaNumber }],
  ['trackings.post.japanpost.jp', { carrier: 'japan-post', normalize: normalizeJapanPostNumber }],
]);
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** An Exmate number in capitals; anything else is not one its tracker reads at this address. */
export function normalizeExmateNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Exmate numbers are EXK, eight digits and J');
  return number;
}

function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Exmate answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** A scan's clock, to the minute: an instant where the scan names Korea or Japan, else the wall clock as shown. */
function scanClock(text: string, country: string): { wall: string; time?: string; local_time?: string } {
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = CLOCK.test(text) ? DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm', { zone: 'UTC' }) : null;
  if (!parsed?.isValid || parsed.toFormat('yyyy-MM-dd HH:mm') !== text) throw new SchemaError(PROVIDER, 'Exmate returned an invalid scan time');
  const wall = parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const zone = ZONES[country.toUpperCase()];
  const time = zone ? zonedTime(text, 'yyyy-MM-dd HH:mm', zone)?.iso : undefined;
  return { wall, ...(time ? { time } : { local_time: wall }) };
}

interface Scan { wall: string; index: number; key: string; event: CarrierEvent }

function projectRow(row: Cheerio<Element>, index: number): Scan {
  const cell = (name: string): string => {
    const found = row.children(`div.${name}`);
    if (found.length !== 1) throw new SchemaError(PROVIDER, 'Exmate returned an invalid scan');
    return found.text();
  };
  const country = clean(cell('g4'), 60);
  const { wall, ...clock } = scanClock(clean(cell('g1'), 40), country);
  // Exmate's own status, in Korean, and its English line; the local carrier's
  // scans carry that carrier's office and wording instead, or nothing.
  const code = clean(cell('g2'), 40);
  const line = clean(clean(cell('g3'), 500).replace(PHONE, ''), 300);
  const description = line || code;
  if (!description) throw new SchemaError(PROVIDER, 'Exmate returned a scan without wording');
  const staged = exmateStage(code, line);
  return { wall, index, key: JSON.stringify([wall, country, code, line]), event: {
    ...clock, ...(country ? { location: country } : {}), description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The local carrier the page names, when it links that carrier's tracker for
 * the number it shows and the carrier's adapter takes the number whole.
 */
function partnerHandoff($: CheerioAPI): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const lines = $('.delivery-wrap span').filter((_, span) => /^Local Delivery Service\b/i.test(clean($(span).text(), 200)));
  if (lines.length !== 1) return {};
  const line = lines.first();
  const links = line.find('a[href]');
  const label = line.clone();
  label.find('a').remove();
  const shown = SERVICE.exec(clean(label.text(), 120))?.[1];
  if (!shown || links.length !== 1) return {};
  let url: URL;
  try {
    url = new URL(links.attr('href')!);
  } catch {
    return {};
  }
  const partner = url.protocol === 'https:' ? PARTNERS.get(url.hostname) : undefined;
  if (!partner || ![...url.searchParams.values()].some((value) => normalizeTrackingNumber(value) === normalizeTrackingNumber(shown))) return {};
  try {
    return { delivery_carrier: partner.carrier, delivery_tracking_number: partner.normalize(shown) };
  } catch (error) {
    if (error instanceof InvalidInputError) return {};
    throw error;
  }
}

/**
 * The tracker's page for one number, `/pod/?exmno=`. It names the number
 * twice, lists the scans oldest first and names the local carrier in the
 * destination country with that carrier's number once it is known. A number
 * the tracker has no record of gets a bare `No Data!!`.
 */
export function parseExmate(html: string, rawNumber: string): CarrierResult {
  const number = normalizeExmateNumber(rawNumber);
  if (NO_DATA.test(html)) throw new NotFoundError(PROVIDER);
  const $ = load(html);
  const fields = $('input#exmno');
  const headings = $('.pop-top > p > span');
  if (fields.length !== 1 || headings.length !== 1) unexpected(html, 'Exmate returned a page without the number');
  const named = [fields.attr('value') ?? '', headings.text()].map((value) => normalizeTrackingNumber(clean(value, 64)));
  if (named.some((value) => !value)) throw new SchemaError(PROVIDER, 'Exmate returned a page without the number');
  if (named.some((value) => value !== number)) throw new IndeterminateError(PROVIDER, 'Exmate answered for another shipment');

  const list = $('.del-grap .grap > ul');
  if (list.length !== 1) throw new SchemaError(PROVIDER, 'Exmate returned a page without a history');
  const rows = list.children('li').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Exmate returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow($(row), index);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // The tracker keeps reading the local carrier's number after the delivery,
  // and the carrier issues that number again to a later parcel, whose scans
  // then follow: nothing after the first delivery is this parcel's.
  const delivery = scans.filter((scan) => scan.event.stage === 'delivered').sort((left, right) => left.wall.localeCompare(right.wall))[0];
  const own = delivery ? scans.filter((scan) => scan.wall <= delivery.wall) : scans;
  // Newest first. Korea and Japan share one offset, so wall clocks order the
  // scans; scans of the same minute take the later row first.
  const events = own.sort((left, right) => right.wall.localeCompare(left.wall) || right.index - left.index).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const deliveredAt = stage === 'delivered' ? current!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    // The number may already be another parcel's once this one is delivered.
    ...(stage === 'delivered' ? {} : partnerHandoff($)),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
