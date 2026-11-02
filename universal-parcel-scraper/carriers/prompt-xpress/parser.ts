import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { promptXpressStage } from './status.js';

export const PROVIDER = 'Prompt Xpress';
/** The visibility portal the tracking page on promptxpress.lk links a found parcel to, which looks up `trackingNo` on the server. */
export const PROMPT_XPRESS_PORTAL = 'https://web.promptxpress.lk/PublicTracking/TrackingStatus';
// A page is about thirty kilobytes; a delivered one can hold its proof of delivery as an image.
export const PROMPT_XPRESS_MAX_BYTES = 4 * 1024 * 1024;

// MC, NC or RP and eight digits, or SP and eight or nine: the layouts its tracking pages and customers give.
const NUMBER = /^(?:(?:MC|NC|RP)\d{8}|SP\d{8,9})$/;
// The portal's notice for a number it holds nothing under, which names the number.
const NOT_FOUND = /^No tracking data was found for \S+\s*\.$/;
// What the portal shows in place of a status, a branch or a clock it does not have.
const NO_STATUS = /^(?:Status unavailable|Awaiting search)$/i;
const NO_BRANCH = /^-?$/;
const NO_CLOCK = /^No timestamp available yet\.?$/i;
// The newest movement's clock, as "Feb 27, 2026 10:34 AM".
const CLOCK = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Firewall and bot check pages, which could stand in for the portal.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

/** A Prompt Xpress tracking number. Anything else is not one the portal is asked for. */
export function normalizePromptXpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Prompt Xpress numbers are MC, NC, RP or SP followed by eight digits, or SP followed by nine');
  }
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An element's text, with a space where its elements meet so that their words stay apart. */
function textOf(element: Cheerio<AnyNode>, limit = 200): string {
  const spaced = element.clone();
  spaced.find('*').append(' ');
  return clean(spaced.text(), limit);
}

/** A number as the page shows it, compared whole: a value too long to be one number is kept as it is. */
function shown(value: string): string {
  return value.length > 64 ? value : normalizeTrackingNumber(value);
}

/**
 * The newest movement's clock as a wall clock. The portal names no zone and
 * runs on a cloud host, so whether it shows Sri Lanka's clock or the server's
 * is not established, and no offset is assigned.
 */
function wallClockOf(text: string): string {
  const match = CLOCK.exec(text);
  const month = match ? MONTHS.indexOf(match[1]!) + 1 : 0;
  const day = match && month ? calendarDay(Number(match[3]), month, Number(match[2])) : null;
  const hour = match ? Number(match[4]) : 0;
  const minute = match ? Number(match[5]) : 60;
  if (!match || !day || hour < 1 || hour > 12 || minute > 59) invalid('Prompt Xpress returned an invalid update time');
  return `${day}T${String((hour % 12) + (match[6] === 'PM' ? 12 : 0)).padStart(2, '0')}:${match[5]}:00`;
}

/** The figures over the result, by their labels: what each shows in bold and the line under it. */
function figuresOf($: CheerioAPI): Map<string, { value: string; note: string }> {
  const figures = new Map<string, { value: string; note: string }>();
  for (const node of $('.hero-kpis .hero-kpi').toArray()) {
    const figure = $(node);
    const label = textOf(figure.children('.mini-label'), 60);
    if (figures.has(label)) invalid('Prompt Xpress repeated a figure of its result');
    figures.set(label, { value: textOf(figure.children('strong'), 200), note: textOf(figure.children('p'), 200) });
  }
  return figures;
}

/**
 * The page `web.promptxpress.lk/PublicTracking/TrackingStatus?trackingNo=`
 * renders for one number, which the tracking page on promptxpress.lk links a
 * found parcel to. It shows the newest movement only: its status, the branch
 * it happened at and its clock, over a count of the scans it does not list.
 * A number it holds nothing under gets the notice "No tracking data was found
 * for" and the number. The proof of delivery is not read.
 */
export function parsePromptXpress(html: string, rawNumber: string): CarrierResult {
  const number = normalizePromptXpressNumber(rawNumber);
  const $ = load(html);
  const field = $('form.search-panel input[name="trackingNo"]');
  if (field.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Prompt Xpress answered with a block page');
    invalid('Prompt Xpress did not return its tracking portal');
  }
  const asked = shown(field.attr('value') ?? '');
  const board = $('.visibility-board');
  if (board.length !== 1) invalid('Prompt Xpress returned its portal without its result');
  const heading = shown(textOf(board.children('.tracking-main'), 100));
  const notices = $('.feedback');
  if (notices.length) {
    const notice = textOf(notices, 300);
    if (notices.length > 1 || !NOT_FOUND.test(notice)) throw new IndeterminateError(PROVIDER, 'Prompt Xpress could not answer for the number');
    if ($('.page-content').length) invalid('Prompt Xpress listed a shipment under its notice');
    const named = shown(textOf(notices.find('strong'), 100));
    if (named !== number || asked !== number || heading !== number) throw new IndeterminateError(PROVIDER, 'Prompt Xpress answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (asked !== number || heading !== number) throw new IndeterminateError(PROVIDER, 'Prompt Xpress answered for another number');
  // The page repeats the number beside the summary and the proof of delivery.
  const references = [...$('.tracking-badge').toArray().map((badge) => textOf($(badge), 100)), ...$('.pod-meta-card').toArray()
    .filter((card) => textOf($(card).children('span'), 60) === 'Tracking Reference').map((card) => textOf($(card).children('strong'), 100))];
  if (references.some((reference) => shown(reference) !== number)) {
    throw new IndeterminateError(PROVIDER, 'Prompt Xpress answered for another number');
  }

  const status = textOf(board.children('.visibility-status'), 120);
  if (!status || NO_STATUS.test(status)) invalid('Prompt Xpress returned a shipment without its status');
  const figures = figuresOf($);
  const branch = figures.get('Current Branch')?.value;
  const clock = figures.get('Update Freshness')?.note;
  if (branch === undefined || clock === undefined) invalid('Prompt Xpress returned a shipment without its branch or its update');
  const local = NO_CLOCK.test(clock) ? null : wallClockOf(clock);
  const staged = promptXpressStage(status);
  const location = NO_BRANCH.test(branch) ? '' : branch;
  const events: CarrierEvent[] = local ? [{
    local_time: local,
    ...(location ? { location } : {}),
    description: status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  }] : [];
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: status,
    last_update: null,
    ...(local ? { last_update_local: local } : {}),
    expected_delivery: null,
    summary_only: true,
    events,
  };
}
