import { load, type Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isValidDhlIdentcode } from '../../core/detection/identcode.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { normalizeAustrianPostNumber } from '../austrian-post/adapter.js';
import { logoixStage } from './status.js';

export const PROVIDER = 'LogoiX';
export const LOGOIX_ZONE = 'Europe/Berlin';
// A page is about 25 kilobytes.
export const LOGOIX_MAX_BYTES = 512 * 1024;
// The tracker asks for a pause between lookups; its notice counts down ten seconds.
export const LOGOIX_WAIT_MS = 10_000;

const NUMBER = /^LIX\d{10}$/;
// A placeholder, not a parcel: the tracker answers it with scans of unrelated parcels.
const PLACEHOLDER = 'LIX0000000000';
const HEADING = /^Verlauf der Sendung(?:\s+(\S+))?$/;
// An unknown number, and a number whose history the tracker no longer has.
const NOT_FOUND = /^(?:unbekannte Sendungsnummer|keine Daten gefunden)$/i;
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;
const PARTNER = /^LogoiX Transportpartner:\s*(.+?)\s+Lieferanten-Paketnummer:\s*(\S+)$/;
const DHL = /^DHL(?: Deutschland| Paket)?$/i;
const AUSTRIAN_POST = /^(?:Österreichische|Oesterreichische) Post(?: AG)?$/i;
const WAIT = /Bitte warten Sie einige Sekunden, bevor Sie eine neue Abfrage starten/;
const WAIT_SECONDS = /\bwaittime\s*=\s*(\d{1,3})\s*;/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
const HIDDEN = /display\s*:\s*none/i;
// The warning in the row the page hides; shown, it is the tracker flagging the lookup.
const FLAGGED = /NICHT AUTORISIERTE ABFRAGE/i;
const MAX_ROWS = 200;

/** A LogoiX number in capitals; anything else is not one LogoiX issues. */
export function normalizeLogoixNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || number === PLACEHOLDER) throw new InvalidInputError(PROVIDER, 'LogoiX numbers are LIX and ten digits');
  return number;
}

/** The tracker's notice asking for a pause before the next lookup, with the wait it counts down. */
export function waitNotice(html: string): RateLimitedError | null {
  if (!WAIT.test(html)) return null;
  const seconds = Number(WAIT_SECONDS.exec(html)?.[1] ?? NaN);
  return new RateLimitedError(PROVIDER, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : LOGOIX_WAIT_MS,
    'LogoiX asked for a pause before the next lookup');
}

function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'LogoiX answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** A cell's text, a line break read as a space. */
function cellText(cell: Cheerio<Element>, maxLength: number): string {
  const copy = cell.clone();
  copy.find('br').replaceWith(' ');
  return clean(copy.text(), maxLength);
}

/** A scan's clock: LogoiX's wall clock to the minute, read in Freilassing's zone. */
function scanTime(text: string): { time: string; at: number } {
  const parts = CLOCK.exec(text);
  // Luxon rolls 24:00 over to the next day.
  const parsed = parts && Number(parts[4]) < 24 ? zonedTime(text, 'dd.MM.yyyy HH:mm', LOGOIX_ZONE) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'LogoiX returned an invalid scan time');
  return { time: parsed.iso, at: parsed.timestamp };
}

/**
 * The transport partner's own number, when the partner tracks it: a DHL
 * Identcode whose check digit holds, or a number Austrian Post's adapter takes
 * whole. Other partners give no hand-off.
 */
function partnerHandoff(partner: string, reference: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const number = normalizeTrackingNumber(reference);
  if (DHL.test(partner)) return isValidDhlIdentcode(number) ? { delivery_carrier: 'dhl', delivery_tracking_number: number } : {};
  if (!AUSTRIAN_POST.test(partner)) return {};
  try {
    return { delivery_carrier: 'austrian-post', delivery_tracking_number: normalizeAustrianPostNumber(number) };
  } catch (error) {
    if (error instanceof InvalidInputError) return {};
    throw error;
  }
}

interface Scan { at: number; index: number; event: CarrierEvent }

/**
 * The tracker's page for one parcel, `tnt.pl?q=`. Its heading names the
 * number; the line under it names the service and the number again. A parcel
 * comes with LogoiX's own scans, oldest first, and the transport partner with
 * its own number once LogoiX has handed the parcel over. The page then loads
 * the partner's history in a second request, which is not made. A number the
 * tracker does not know, or no longer has, gets a notice under the heading.
 */
export function parseLogoix(html: string, rawNumber: string): CarrierResult {
  const number = normalizeLogoixNumber(rawNumber);
  const wait = waitNotice(html);
  if (wait) throw wait;
  const $ = load(html);
  const headings = $('h1').filter((_, heading) => HEADING.test(clean($(heading).text(), 120)));
  if (!headings.length) unexpected(html, 'LogoiX returned a page without a shipment');
  if (headings.length > 1) throw new IndeterminateError(PROVIDER, 'LogoiX answered for several shipments');
  const heading = headings.first();
  const named = HEADING.exec(clean(heading.text(), 120))?.[1];
  if (!named) throw new SchemaError(PROVIDER, 'LogoiX returned a page without the number');
  if (normalizeTrackingNumber(named) !== number) throw new IndeterminateError(PROVIDER, 'LogoiX answered for another shipment');

  // The service and the number again, as in `Schalterversand LIX…`.
  const subtitle = clean(heading.nextAll('h3').first().text(), 120);
  const references = subtitle.match(/\bLIX\d+\b/gi) ?? [];
  if (references.some((reference) => reference.toUpperCase() !== number)) throw new IndeterminateError(PROVIDER, 'LogoiX answered for another shipment');
  const service = clean(subtitle.replace(/\bLIX\d+\b/gi, ''), 80);

  const notice = heading.nextAll('b').first();
  if (notice.length && NOT_FOUND.test(clean(notice.text(), 120))) throw new NotFoundError(PROVIDER);

  const table = heading.nextAll('table.tnttable').first();
  if (!table.length) unexpected(html, 'LogoiX returned a page without a history');
  const rows = table.find('tr').toArray()
    .filter((row) => !HIDDEN.test($(row).attr('style') ?? '') && !$(row).children('td').toArray().every((cell) => HIDDEN.test($(cell).attr('style') ?? '')));
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'LogoiX returned an oversized history');

  const scans: Scan[] = [];
  const partners: { partner: string; reference: string }[] = [];
  rows.forEach((row, index) => {
    const cells = $(row).children('td');
    const clock = cells.length ? clean(cells.eq(0).text(), 40) : '';
    const text = cells.length > 1 ? cellText(cells.eq(1), 300) : '';
    if (cells.length > 2) throw new SchemaError(PROVIDER, 'LogoiX returned an invalid scan');
    if (FLAGGED.test(text)) throw new ChallengeError(PROVIDER, 'LogoiX flagged the lookup as unauthorized');
    // A row without a clock is the layout's spacer, the transport partner or a note; none is a scan.
    if (!clock) {
      const partner = PARTNER.exec(text);
      if (partner) partners.push({ partner: clean(partner[1], 80), reference: partner[2]! });
      return;
    }
    if (!text) throw new SchemaError(PROVIDER, 'LogoiX returned a scan without wording');
    const { time, at } = scanTime(clock);
    const staged = logoixStage(text);
    scans.push({ at, index, event: {
      time, description: text, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Newest first; the page lists scans oldest first, so scans of the same minute take the later row first.
  const events = scans.sort((left, right) => right.at - left.at || right.index - left.index).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time : undefined;
  // One partner number binds the hand-off; several leave it open.
  const handoff = new Set(partners.map(({ reference }) => reference)).size === 1
    ? partnerHandoff(partners[0]!.partner, partners[0]!.reference) : {};
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(service ? { service_name: service } : {}),
    ...handoff,
    timezone: LOGOIX_ZONE,
    events,
  };
}
