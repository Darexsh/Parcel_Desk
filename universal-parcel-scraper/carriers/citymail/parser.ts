import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { citymailStage } from './status.js';

export const PROVIDER = 'CityMail';
// A page is under ten kilobytes.
export const CITYMAIL_MAX_BYTES = 256 * 1024;
// CityMail delivers in Sweden only, and its tracker gives no zone.
const ZONE = 'Europe/Stockholm';

// The parcel reference from CityMail's SMS or email: its own BCM references and
// the references of senders such as Amazon. Letters and digits, with a digit.
const REFERENCE = /^(?=[A-Z]*\d)[A-Z0-9]{8,35}$/;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The notice for a reference the tracker has nothing for; it names the reference.
const NOT_FOUND = /^Ingen spårningsinformation hittades för den angivna referensen\b/;
// The Swedish postcode before the town on a delivery scan, which is the recipient's.
const POSTCODE = /^\d{3} ?\d{2}\s+(?=\S)/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
const MAX_ROWS = 200;

/** A parcel reference in upper case, as the tracker matches it; anything else is not one CityMail gives out. */
export function normalizeCitymailNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!REFERENCE.test(number)) throw new InvalidInputError(PROVIDER, 'CityMail parcel references are eight to thirty-five letters and digits');
  return number;
}

const blocked = (html: string) => BLOCKED.test(html.slice(0, 64_000));

function unexpected(html: string, message: string): never {
  if (blocked(html)) throw new ChallengeError(PROVIDER, 'CityMail answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** The labelled values beside the status: each bold label, then the text up to the next one. */
function details($: CheerioAPI, form: Cheerio<Element>): Map<string, string> {
  const fields = new Map<string, string>();
  form.find('.col-md-3').each((_, column) => {
    let label = '';
    $(column).contents().each((_, node) => {
      if ($(node).is('b')) {
        label = clean($(node).text(), 60);
        fields.set(label, '');
      } else if (label && node.nodeType === 3) {
        fields.set(label, clean(`${fields.get(label)} ${$(node).text()}`, 200));
      }
    });
  });
  return fields;
}

/** A scan's clock: CityMail's wall clock to the minute, read in Stockholm. */
function scanTime(text: string): string {
  // Luxon rolls 24:00 over to the next day.
  const clock = CLOCK.test(text) && Number(text.slice(11, 13)) < 24 ? zonedTime(text, 'yyyy-MM-dd HH:mm', ZONE) : null;
  if (!clock) throw new SchemaError(PROVIDER, 'CityMail returned an invalid scan time');
  return clock.iso;
}

function scan(description: string, clock: string, place = ''): CarrierEvent {
  if (!description) throw new SchemaError(PROVIDER, 'CityMail returned a scan without wording');
  const location = clean(place, 120).replace(POSTCODE, '');
  const staged = citymailStage(description);
  return {
    time: scanTime(clock),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The estimated delivery day, which the page shows until the parcel arrives. */
function estimate(value: string | undefined): string | null {
  if (!value) return null;
  if (!DAY.test(value) || !DateTime.fromISO(value, { zone: 'UTC' }).isValid) throw new SchemaError(PROVIDER, 'CityMail returned an invalid delivery estimate');
  return value;
}

/**
 * The tracker's page for one reference, `tracking.citymail.se/?search=`. A
 * parcel it knows comes with its current status, the sender, the product, the
 * reference it was booked under and its scans, newest first. A reference it
 * has nothing for gets a notice naming it. Both must name the reference asked.
 */
export function parseCitymail(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCitymailNumber(rawNumber);
  const $ = load(html);
  const form = $('form#MainForm');
  const searched = clean(form.find('input#search').attr('value') ?? '', 64);
  if (form.length !== 1 || !searched) unexpected(html, 'CityMail returned an unexpected page');
  if (normalizeTrackingNumber(searched) !== number) throw new IndeterminateError(PROVIDER, 'CityMail answered for another reference');

  const notice = form.find('h3').filter((_, heading) => NOT_FOUND.test(clean($(heading).text(), 300)));
  if (notice.length) {
    if (normalizeTrackingNumber(clean(notice.find('span').first().text(), 64)) !== number) {
      throw new IndeterminateError(PROVIDER, 'CityMail answered for another reference');
    }
    throw new NotFoundError(PROVIDER);
  }

  const current = clean(form.find('h4.green').first().text(), 200);
  if (!current) unexpected(html, 'CityMail returned a page without a parcel');
  const fields = details($, form);
  const original = fields.get('Ursprunglig paketreferens');
  if (!original) throw new SchemaError(PROVIDER, 'CityMail returned a parcel without its reference');
  if (normalizeTrackingNumber(original) !== number) throw new IndeterminateError(PROVIDER, 'CityMail answered for another parcel');

  const rows = form.find('table tr').toArray().filter((row) => $(row).children('td').length > 0);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CityMail returned an oversized history');
  const scans = rows.map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'CityMail returned an invalid scan');
    const event = scan(clean(cells.eq(0).text(), 200), clean(cells.eq(1).text(), 32), cells.eq(2).text());
    return { event, at: DateTime.fromISO(event.time!).toMillis() };
  });
  // Newest first, as the page lists them; scans of the same minute keep the page's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((left, right) => right.at - left.at).map(({ event }) => event);
  // A parcel without scans still has its current status and when it was set.
  const summaryOnly = !events.length;
  if (summaryOnly) events.push(scan(current, fields.get('Tidpunkt') ?? ''));

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  // The service point's name is the place of the scan that left the parcel there.
  const point = events.find((event) => event.stage === 'ready_for_pickup')?.location;
  const atPoint = point && (stage === 'ready_for_pickup' || (stage === 'delivered' && lastMovement(events) === 'ready_for_pickup'));
  const sender = fields.get('Avsändare');
  const product = fields.get('Produktkod');
  const expected = estimate(fields.get('Beräknat leveransdatum'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : expected,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(sender ? { sender_name: sender } : {}),
    ...(product ? { service_name: product } : {}),
    ...(atPoint ? { pickup_point: point } : {}),
    timezone: ZONE,
    ...(summaryOnly ? { summary_only: true } : {}),
    events,
  };
}
