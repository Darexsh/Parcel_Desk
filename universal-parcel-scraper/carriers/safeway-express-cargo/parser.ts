import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { SHIPPED, safewayStage } from './status.js';

export const PROVIDER = 'Safe Way Express Cargo';
export const CARRIER = 'safeway-express-cargo';
// A page is about 60 kB, most of it the site's theme.
export const SAFEWAY_MAX_BYTES = 512 * 1024;

// The tracker looks a number up whole; only BH and eight digits are known, so any
// number of letters and digits is asked. Separators would ask for several numbers.
const NUMBER = /^(?=.*\d)[A-Z0-9]{6,30}$/;
// "2026-09-14": the day the parcel shipped, without a clock.
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const NOT_FOUND = /^Tracking Information Not Found$/i;
const NO_EVENTS = /^No tracking events available yet\.?$/i;
// Delivering carriers the page names, which know the parcel by its carrier tracking number.
const PARTNERS: readonly (readonly [RegExp, string])[] = [[/^Aramex$/i, 'aramex']];
const PARTNER_NUMBER = /^[A-Z0-9]{4,40}$/;

/** A number for Safe Way's tracker: letters and digits, upper case. */
export function normalizeSafewayNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Safe Way Express Cargo numbers are letters and digits');
  return number;
}

/** The answer's shipment information by label, "Carrier:" and the like, without the colon. */
function detailsOf($: CheerioAPI, info: Cheerio<Element>): Map<string, string> {
  const details = new Map<string, string>();
  for (const item of info.find('.shipment-info-section .detail-item').toArray()) {
    const label = clean($(item).children('span').first().text(), 80).replace(/:$/, '');
    if (!label) continue;
    if (details.has(label)) throw new SchemaError(PROVIDER, `Safe Way returned ${label} twice`);
    details.set(label, clean($(item).children('strong').first().text(), 120));
  }
  return details;
}

/** The shipped day as a scan; a value that is not a calendar day adds none. */
function shippedOf(value: string | undefined): CarrierEvent[] {
  const parts = DAY.exec(value ?? '');
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!day || Number(parts![1]) < 2000) return [];
  const staged = safewayStage(SHIPPED)!;
  return [{ local_time: day, description: SHIPPED, stage: staged.stage, stage_source: staged.source }];
}

/** The partner and its number, when the page names a carrier that delivers under its own number. */
function handOffOf(details: Map<string, string>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const partner = PARTNERS.find(([name]) => name.test(details.get('Carrier') ?? ''))?.[1];
  const reference = normalizeTrackingNumber(details.get('Carrier Tracking Number') ?? '');
  return partner && PARTNER_NUMBER.test(reference) && reference !== number
    ? { delivery_carrier: partner, delivery_tracking_number: reference } : {};
}

/**
 * The tracker's page for one number, `/track.php?awb=`, which its server
 * renders: the number over its status, its shipment information (the carrier,
 * the carrier's tracking number and the shipped day), its shipping details and
 * its timeline, or "Tracking Information Not Found". The status, the carrier's
 * number and the shipped day are kept; the shipping details are not.
 */
export function parseSafeway(html: string, raw: string): CarrierResult {
  const number = normalizeSafewayNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Safe Way answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const results = $('#trackingResults');
  if (results.length !== 1) throw new SchemaError(PROVIDER, 'Safe Way returned a page without results');
  const infos = results.find('.tracking-info');

  if (!infos.length) {
    if (!NOT_FOUND.test(clean(results.find('.tracking-alert h5').first().text(), 120))) {
      throw new SchemaError(PROVIDER, 'Safe Way returned an unexpected page');
    }
    // The answer does not name the number, but the search field above it repeats the one asked.
    if (normalizeTrackingNumber(clean($('input#trackingNumber').attr('value'), 64)) !== number) {
      throw new IndeterminateError(PROVIDER, 'Safe Way answered for another number');
    }
    throw new NotFoundError(PROVIDER, 'Safe Way has no shipment under this number');
  }
  if (infos.length !== 1) throw new SchemaError(PROVIDER, 'Safe Way returned several shipments');
  const info = infos.first();
  if (normalizeTrackingNumber(clean(info.find('.tracking-number strong').first().text(), 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Safe Way answered for another number');
  }
  // No answer has listed scans yet, so a timeline with any is a layout this parser does not know.
  const timeline = info.find('.tracking-timeline');
  if (timeline.length !== 1 || timeline.find('li').length || !NO_EVENTS.test(clean(timeline.children('p').text(), 120))) {
    throw new SchemaError(PROVIDER, 'Safe Way returned a timeline the adapter does not read');
  }

  const details = detailsOf($, info);
  const events = shippedOf(details.get('Shipped Date'));
  const handOff = handOffOf(details, number);
  const status = clean(info.find('.tracking-status strong').first().text(), 120);
  if (!status && !events.length && !handOff.delivery_carrier) throw new NoHistoryError(PROVIDER);
  const staged = (status ? safewayStage(status) : null) ?? (events[0] ? { stage: events[0].stage as Stage, source: events[0].stage_source! } : null);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: status || events[0]?.description || null,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...handOff,
    summary_only: true,
    events,
  };
}
