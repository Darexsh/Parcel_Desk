import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { ecomStage } from './status.js';

export const PROVIDER = 'Ecom Logistics';
export const CARRIER = 'ecom-logistics';
// A page is about 60 kB, and 90 kB for a number it does not know.
export const ECOM_MAX_BYTES = 1024 * 1024;

// Letters and digits, such as E, two digits, a letter and seven digits.
const NUMBER = /^(?=.*\d)[A-Z0-9]{8,30}$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const MAX_EVENTS = 200;

/** A number for Ecom Logistics' tracker: eight to thirty letters and digits. */
export function normalizeEcomNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Ecom Logistics numbers are letters and digits');
  return number;
}

/** The tracking history, newest first: each scan gives its wording, its instant with an offset and at times a place. */
function eventsOf($: CheerioAPI): CarrierEvent[] {
  const lists = $('ol.track-history');
  if (lists.length > 1) throw new SchemaError(PROVIDER, 'Ecom Logistics returned several histories');
  const rows = lists.children('li.track-event').toArray();
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Ecom Logistics returned an invalid history');
  const events = rows.map((row): CarrierEvent => {
    const description = clean($(row).find('.track-event__title').first().text(), 300);
    const clocks = $(row).find('time[datetime]');
    const time = clocks.length === 1 ? explicitOffsetTime(clocks.attr('datetime') ?? '')?.iso : undefined;
    if (!description || !time) throw new SchemaError(PROVIDER, 'Ecom Logistics returned an invalid scan');
    // The place follows the clock and a separator the page hides from screen readers.
    const location = clean(clocks.parent().children('span:not([aria-hidden])').first().text(), 160);
    const staged = ecomStage(description);
    return {
      time,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  // Newest first; the page lists them so, and a stable sort keeps scans of one instant in its order.
  return events.sort((left, right) => Date.parse(right.time!) - Date.parse(left.time!));
}

/**
 * The page `shipecom.com/track/{number}`, which the server renders. Its result
 * section names a state (`delivered`, `not_found`) and repeats the number
 * asked. A known parcel has a status heading, a progress rail, the delivery
 * time, the destination's postal code prefix and the tracking history. A number
 * it does not know comes with HTTP 404, the state `not_found` and no history.
 * Only the history is kept.
 */
export function parseEcom(html: string, raw: string): CarrierResult {
  const number = normalizeEcomNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Ecom Logistics answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const result = $('main section[data-track-result]');
  if (result.length !== 1) throw new SchemaError(PROVIDER, 'Ecom Logistics returned an unexpected page');
  const shown = clean(result.find('p .track-code').first().text(), 64);
  if (!shown) throw new SchemaError(PROVIDER, 'Ecom Logistics returned a page without the number asked');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'Ecom Logistics answered for another number');
  const state = result.attr('data-track-result');
  if (state === 'not_found') {
    if ($('ol.track-history').length) throw new SchemaError(PROVIDER, 'Ecom Logistics returned an unexpected page');
    throw new NotFoundError(PROVIDER, 'Ecom Logistics does not know this number');
  }
  if (!state || !/^[a-z_]{1,40}$/.test(state)) throw new SchemaError(PROVIDER, 'Ecom Logistics returned a page without its state');

  const events = eventsOf($);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    events,
  };
}
