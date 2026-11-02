import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { accepted } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, countryTimeZone, sharedClockZone, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { normalizeAustrianPostNumber } from '../austrian-post/adapter.js';
import { hermesAtStage } from './status.js';

export const PROVIDER = 'Hermes Austria';
// The page is about fifty kilobytes, most of it the site's frame.
export const HERMES_AT_MAX_BYTES = 1024 * 1024;

const ZONE = 'Europe/Vienna';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Hermes's numbers, among them Hermes Germany's H numbers, and Austrian Post's 22-digit barcodes.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,22}$/;
// "17.07.2026  07:49:00 Uhr"
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*Uhr$/;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|_Incapsula_Resource|captcha/i;
const MAINTENANCE = /<title>\s*Service nicht verf(?:ü|&uuml;)gbar/i;
const NOT_FOUND = /keine Sendung finden/i;
// The banner that offers to redirect the parcel on Austrian Post's site, with Austrian Post's number for it.
const POST_REDIRECT = /^https:\/\/www\.post\.at\/sendungsverfolgung\.php\/interaktion\?/;
// Scans that send the parcel back: a handover after one of them is to its sender.
const RETURNING = /^(?:Rücksendung\b|Sendung im Rückversand\b)/;

/** A number for the myHermes.at tracker; anything else is not one Hermes Austria's parcels carry. */
export function normalizeHermesAtNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hermes Austria numbers are eight to twenty-two letters and digits');
  return number;
}

/** The value of the details list's line under this label, without the label. */
function detail($: CheerioAPI, list: Cheerio<Element>, label: string): string | null {
  for (const item of list.children('li').toArray()) {
    const name = $(item).children('span.bold').first();
    if (clean(name.text(), 80) !== label) continue;
    return clean($(item).text(), 400).slice(clean(name.text(), 80).length).trim();
  }
  return null;
}

/** A cell's lines, as the page breaks them. */
function lines(cell: AnyNode, $: CheerioAPI): string[] {
  return ($(cell).html() ?? '').split(/<br\s*\/?>/i)
    .map((part) => clean(load(part, null, false).root().text(), 300)).filter(Boolean);
}

/**
 * A scan's place after `Ort:`: a country, or a town or a PaketShop with a
 * country, in either order. "undetermined" stands for no place; a PaketShop
 * whose number lost its closing bracket gets it back.
 */
function place(raw: string): { location: string; country: string | null } {
  const parts = raw.split(',').map((part) => clean(part, 120)).filter((part) => part && !/^undetermined$/i.test(part));
  let at = -1;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (countryCode(parts[index]!)) { at = index; break; }
  }
  const named = parts.filter((_, index) => index !== at)
    .map((part) => (part.split('(').length > part.split(')').length ? `${part})` : part));
  return { location: [...named, ...(at >= 0 ? [parts[at]!] : [])].join(', '), country: at >= 0 ? countryCode(parts[at]!) : null };
}

/**
 * A scan's clock. The page prints Vienna's wall clock: its Austrian scans
 * match the instants Austrian Post's tracker gives the same scans. A scan in a
 * country whose clock agrees with Vienna's at that moment, Germany for
 * instance, reads the same whichever of the two the page keeps, so it is read
 * in Vienna; any other keeps its wall clock.
 */
function scanClock(text: string, country: string | null): { time: string } | { local_time: string } {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !day || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    throw new SchemaError(PROVIDER, 'Hermes Austria returned an invalid scan time');
  }
  const wall = `${day}T${match[4]}:${match[5]}:${match[6]}`;
  const zone = country ? countryTimeZone(country) : null;
  const shared = zone ? sharedClockZone([ZONE, zone], wall) : null;
  const instant = shared ? zonedTime(wall, "yyyy-MM-dd'T'HH:mm:ss", shared) : null;
  return instant ? { time: instant.iso } : { local_time: wall };
}

/**
 * Austrian Post's number for the parcel, from the banner that offers to
 * redirect it on Austrian Post's site, when Austrian Post's adapter can look
 * that number up.
 */
function austrianPostLeg($: CheerioAPI, plugin: Cheerio<Element>): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const link of plugin.find('a[href]').toArray()) {
    const href = $(link).attr('href') ?? '';
    if (!POST_REDIRECT.test(href)) continue;
    const number = normalizeTrackingNumber(clean(new URL(href).searchParams.get('pnum1'), 64));
    if (accepted(() => normalizeAustrianPostNumber(number))) return { delivery_carrier: 'austrian-post', delivery_tracking_number: number };
  }
  return {};
}

/**
 * The tracker's page for one number, `/sendungsverfolgung/trackingnummer/{number}/`,
 * which the site renders on its server. For a parcel it holds it lists the
 * parcel's numbers, the recipient's country and the scans, newest first, each
 * with its time, its wording and its place. For a number it holds nothing for
 * it says so under the form; the form alone is no answer.
 */
export function parseHermesAt(html: string, rawNumber: string): CarrierResult {
  const number = normalizeHermesAtNumber(rawNumber);
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hermes Austria answered with a bot check');
  if (MAINTENANCE.test(html.slice(0, 64_000))) throw new MaintenanceError(PROVIDER, 'Hermes Austria\'s tracker is down for maintenance');
  const $ = load(html);
  const plugin = $('div.tx-webservices');
  if (plugin.length !== 1) throw new SchemaError(PROVIDER, 'Hermes Austria returned a page without the tracker');
  const details = plugin.find('ul.sendungsdetailliste');
  if (!details.length) {
    if (plugin.find('.headline5').toArray().some((node) => NOT_FOUND.test($(node).text()))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Hermes Austria showed no answer for the number');
  }
  if (details.length !== 1) throw new SchemaError(PROVIDER, 'Hermes Austria returned several parcels');
  // One parcel can carry several numbers, as a Hermes Germany H number beside Hermes's parcel number.
  const numbers = (detail($, details, 'Sendungsnummer(n):') ?? '').split(/[;,\s]+/).filter(Boolean).map(normalizeTrackingNumber);
  if (!numbers.length) throw new SchemaError(PROVIDER, 'Hermes Austria returned a parcel without its number');
  if (!numbers.includes(number)) throw new IndeterminateError(PROVIDER, 'Hermes Austria answered for another parcel');

  const table = plugin.find('table.sendungsstatus');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Hermes Austria returned a parcel without its history');
  const rows = table.find('tr').toArray().filter((row) => $(row).children('td').length);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Hermes Austria returned an oversized history');
  const scans: Array<{ wall: string; event: CarrierEvent }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cells = $(row).children('td').toArray();
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'Hermes Austria returned an invalid history row');
    // The wording, then the place after `Ort:`.
    const cell = lines(cells[1]!, $);
    const description = cell.find((line) => !line.startsWith('Ort:')) ?? '';
    const { location, country } = place(cell.find((line) => line.startsWith('Ort:'))?.slice(4) ?? '');
    const clock = scanClock(clean($(cells[0]).text(), 64), country);
    // A row without a wording says nothing about the parcel.
    if (!description) continue;
    const wall = 'time' in clock ? clock.time.slice(0, 19) : clock.local_time;
    const key = [wall, description, location].join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = hermesAtStage(description);
    scans.push({ wall, event: {
      ...clock, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first, as the page lists them; the page's clocks are one wall clock.
  scans.sort((a, b) => (a.wall < b.wall ? 1 : a.wall > b.wall ? -1 : 0));
  const events = scans.map(({ event }) => event);
  for (const [index, event] of events.entries()) {
    if (event.stage === 'delivered' && events.slice(index + 1).some((older) => RETURNING.test(older.description ?? ''))) event.stage = 'returned';
  }
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const deliveredAt = stage === 'delivered' && typeof current!.time === 'string' ? current!.time : null;
  // The recipient's country only: an address with more in it is never kept.
  const destination = countryCode(detail($, details, 'Empfängeradresse:') ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description ?? null,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.time === 'string' ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...austrianPostLeg($, plugin),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
