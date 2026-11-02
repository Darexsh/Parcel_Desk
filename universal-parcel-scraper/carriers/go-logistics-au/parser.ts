import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { goLogisticsStage } from './status.js';

export const PROVIDER = 'GO Logistics';
export const CARRIER = 'go-logistics-au';
export const TIMEZONE = 'Australia/Sydney';
// A page is about 5 kB, more with a signature image.
export const GO_LOGISTICS_MAX_BYTES = 512 * 1024;

// Coupon and consignment numbers: ten digits in the public example, letters allowed.
const NUMBER = /^(?=.*\d)[A-Z0-9]{6,20}$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const MAX_EVENTS = 200;

/** A number for GO Logistics' tracker: six to twenty letters and digits. */
export function normalizeGoLogisticsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GO Logistics numbers are six to twenty letters and digits');
  return number;
}

/** The scans as the page lists them, oldest first: a wording, a day and a time on Sydney's clock. */
function scansOf($: CheerioAPI): CarrierEvent[] {
  const rows = $('.NTtrackInfo .NTitemLine').toArray();
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'GO Logistics returned an invalid history');
  return rows.map((row): CarrierEvent => {
    const history = $(row).find('.NTitemHistory').first().clone();
    // A delivery names its signatory and shows the signature, which are not kept.
    history.find('.NTsignedby, img, br').remove();
    const description = clean(history.text(), 200);
    const day = clean($(row).find('.NTitemDate').first().text(), 20);
    const clock = clean($(row).find('.NTitemTime').first().text(), 12);
    const time = day && clock ? zonedTime(`${day} ${clock}`, 'd MMM yyyy h:mm a', TIMEZONE, { locale: 'en' })?.iso : undefined;
    if (!description || !time) throw new SchemaError(PROVIDER, 'GO Logistics returned an invalid scan');
    const stage = goLogisticsStage(description);
    return { time, description, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  });
}

/**
 * The scans of the latest consignment under the number. A number used again
 * lists every consignment, oldest first: a delivery followed by a new start
 * closes the earlier one.
 */
function latestConsignment(scans: CarrierEvent[]): CarrierEvent[] {
  let start = 0;
  scans.forEach((scan, index) => {
    if (index > 0 && (scan.stage === 'registered' || scan.stage === 'accepted') && scans[index - 1]!.stage === 'delivered') start = index;
  });
  return scans.slice(start);
}

/**
 * The tracker's page `services.gologistics.com.au/track/iframe2.php?item={number}`.
 * It repeats the number asked as its heading, then lists the consignment's
 * scans, oldest first, each with a day, a time on Sydney's clock, the driver's
 * number and a wording; a delivery adds the signatory and the signature. A
 * number it holds no scan for has the heading alone. The wording and the clock
 * are kept.
 */
export function parseGoLogistics(html: string, raw: string): CarrierResult {
  const number = normalizeGoLogisticsNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GO Logistics answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const info = $('.NTtrackInfo');
  if (info.length !== 1) throw new SchemaError(PROVIDER, 'GO Logistics returned an unexpected page');
  const shown = clean(info.find('.NTtrackItemHeading').first().text(), 64);
  if (!shown) throw new SchemaError(PROVIDER, 'GO Logistics returned a page without the number asked');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'GO Logistics answered for another number');

  const events = latestConsignment(scansOf($))
    .sort((left, right) => Date.parse(left.time!) - Date.parse(right.time!))
    .reverse();
  const newest = events[0];
  if (!newest) throw new NotFoundError(PROVIDER, 'GO Logistics holds no scan for this number');
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    timezone: TIMEZONE,
    events,
  };
}
