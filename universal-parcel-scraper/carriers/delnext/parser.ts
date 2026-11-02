import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import type { CarrierId } from '../../generated/catalog.js';
import { delnextStage } from './status.js';

export const PROVIDER = 'Delnext';
// A page with a long history is under 200 kB, most of it the site's own markup.
export const DELNEXT_MAX_BYTES = 2 * 1024 * 1024;

const NUMBER = /^[A-Z0-9]{6,7}$/;
const CODE_LABEL = 'Código de rastreio:';
const PARTNER_LABEL = 'A sua encomenda será entregue por:';
const HISTORY_HEADING = 'Informação detalhada';
const ESTIMATE_LABEL = 'Entrega prevista entre:';
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}:\d{2}))?$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
const ECHO = /\btracking_code = "([^"]{0,64})";/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The estimate stays on the page after the parcel stops.
const STOPPED = new Set<Stage>(['delivered', 'returned', 'exception']);

/**
 * The delivery partners the page names, as their catalog carriers. Another
 * name, such as Delnext's own GLS Portugal account, stays in the wording only.
 */
const PARTNERS: ReadonlyMap<string, CarrierId> = new Map([['DPD DE', 'dpd-de'], ['DPD FR', 'dpd-fr'], ['MRW', 'mrw']]);

/** A Delnext tracking code: six or seven letters and digits, looked up in upper case. */
export function normalizeDelnextNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Delnext tracks six- or seven-character codes of letters and digits');
  return number;
}

/** A bot check in place of the tracker. The page itself loads reCAPTCHA for its login form. */
export function isDelnextChallenge(html: string): boolean {
  return /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform/i.test(html);
}

/** The site's own outage pages: its database unreachable, or its host's resource limit reached. */
export function isDelnextOutage(html: string): boolean {
  return /There seems to be a problem connecting to our database|Resource Limit Is Reached/i.test(html);
}

/** The scan's wall clock: the page gives a day and a time to the minute, without a zone. */
function wallClock(day: string, time: string): string {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  // UTC only checks the calendar fields; the clock keeps no offset.
  const parsed = date && clock && (!date[4] || date[4] === time) ? DateTime.fromObject({ year: Number(date[3]),
    month: Number(date[2]), day: Number(date[1]), hour: Number(clock[1]), minute: Number(clock[2]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat('dd/MM/yyyy HH:mm') !== `${day.slice(0, 10)} ${time}`) {
    throw new SchemaError(PROVIDER, 'Delnext returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** A scan's own line, without the system's note under it, the delivery proof button or the date-change notice after it. */
function wording(cell: Cheerio<AnyNode>): string {
  const line = cell.children('p').first().clone();
  line.find('span.text-muted, button, script, style').remove();
  return clean(line.text(), 400);
}

/** The day the tracker expects to deliver, while the parcel still moves and the day is not behind the scans. */
function estimate($: CheerioAPI, stage: Stage | undefined, newest: string | undefined): string | null {
  if (!stage || STOPPED.has(stage)) return null;
  const text = $('section.product-tracking-area .status-short-details').toArray()
    .map((node) => clean($(node).text(), 80)).find((value) => value.startsWith(ESTIMATE_LABEL));
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text?.slice(ESTIMATE_LABEL.length).trim() ?? '');
  const day = date ? DateTime.fromObject({ year: Number(date[3]), month: Number(date[2]), day: Number(date[1]) }, { zone: 'UTC' }) : null;
  const iso = day?.isValid ? day.toISODate() : null;
  return iso && (!newest || iso >= newest.slice(0, 10)) ? iso : null;
}

/**
 * The partner the page says delivers the parcel, with its number. The number
 * sits in a hidden notice whose partner name must match the visible one, and
 * it must be of the partner's own shape; the notice often holds a stale name
 * or a placeholder.
 */
function handoff($: CheerioAPI, partner: string | undefined, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const carrier = partner ? PARTNERS.get(partner.toUpperCase()) : undefined;
  if (!partner || !carrier) return {};
  const notice = $('.back_office_message_modal_body').first();
  const named = notice.find('strong').first();
  if (clean(named.text(), 60).toUpperCase() !== partner.toUpperCase()) return {};
  const line = clean(named.parent().text(), 300);
  const reference = /e o número de tracking é ([A-Za-z0-9]{4,40})$/.exec(line)?.[1]?.toUpperCase();
  if (!reference || reference === number || !detectCarrierMatch(reference).candidates.includes(carrier)) return {};
  return { delivery_carrier: carrier, delivery_tracking_number: reference };
}

interface Row { event: CarrierEvent; dated: boolean }

/**
 * The tracker's page for one code: a header naming the code and, for a parcel
 * a partner delivers, that partner; a progress bar; then the scans, newest
 * first, each with a day, a time, a place and a line. An unknown code gets
 * the empty search page instead, whose script still holds the code asked.
 */
export function parseDelnext(html: string, raw: string): CarrierResult {
  const number = normalizeDelnextNumber(raw);
  const $ = load(html);
  const info = $('section.track-info');
  if (info.length !== 1) {
    if ($('.tracking-code-empty').length) {
      const echo = ECHO.exec(html)?.[1];
      if (echo === undefined) throw new SchemaError(PROVIDER, 'Delnext returned a search page without the code asked');
      if (echo.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Delnext answered for another parcel');
      throw new NotFoundError(PROVIDER);
    }
    if (isDelnextChallenge(html)) throw new ChallengeError(PROVIDER, 'Delnext answered with a browser check');
    if (isDelnextOutage(html)) throw new MaintenanceError(PROVIDER, 'Delnext tracking is temporarily unavailable');
    throw new SchemaError(PROVIDER, 'Delnext returned a page without a tracking answer');
  }

  let code: string | undefined;
  let partner: string | undefined;
  for (const box of info.find('.tracking-details-box-content').toArray()) {
    const title = clean($(box).find('.tracking-title').first().text(), 120);
    if (title === CODE_LABEL) code = clean($(box).find('.tracking-details').first().text(), 40).toUpperCase();
    else if (title.startsWith(PARTNER_LABEL)) partner = clean(title.slice(PARTNER_LABEL.length), 60) || undefined;
  }
  if (code === undefined) throw new SchemaError(PROVIDER, 'Delnext changed its tracking header');
  if (code !== number) throw new IndeterminateError(PROVIDER, 'Delnext answered for another parcel');

  const heading = $('h3').filter((_, node) => clean($(node).text(), 60) === HISTORY_HEADING);
  if (heading.length !== 1) throw new SchemaError(PROVIDER, 'Delnext returned no history section');
  const items = heading.parent().find('.feed-item');
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Delnext returned an oversized history');

  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const item of items.toArray()) {
    const cells = $(item).children('.feed-item-left').children('p');
    const right = $(item).children('.feed-item-right');
    if (cells.length !== 3 || right.length !== 1) throw new SchemaError(PROVIDER, 'Delnext history rows changed');
    const day = clean(cells.eq(0).text(), 40);
    const time = clean(cells.eq(1).text(), 16);
    const place = clean(cells.eq(2).text(), 120);
    const description = wording(right);
    if (!description) throw new SchemaError(PROVIDER, 'Delnext returned a scan without wording');
    // A cancelled parcel's only line has a dash for its day, time and place.
    const dated = !(day === '-' && time === '-');
    const event: CarrierEvent = {
      ...(dated ? { local_time: wallClock(day, time) } : {}),
      ...(place && place !== '-' ? { location: place } : {}),
      description,
    };
    const key = JSON.stringify([event.local_time, event.location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = delnextStage(description);
    if (staged) Object.assign(event, { stage: staged.stage, stage_source: staged.source });
    rows.push({ event, dated });
  }

  // Newest first; scans of the same minute keep the page's order.
  const events = rows.filter((row) => row.dated).map((row) => row.event)
    .sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  // A line without a day above the scans is the parcel's state, as for a cancelled parcel.
  const summary = rows[0] && !rows[0].dated && rows[0].event.stage ? rows[0].event : undefined;
  const newest = events.find((event) => event.stage);
  // The page lists scans of one minute in no fixed order: a delivery or a
  // return at the newest scan's minute ends the parcel, whatever comes first.
  const decider = summary ?? (newest && events.find((event) => event.local_time === newest.local_time
    && (event.stage === 'delivered' || event.stage === 'returned'))) ?? newest;
  const partnerFields = handoff($, partner, number);

  if (!events.length) {
    if (decider) {
      const stage = decider.stage as Stage;
      return { status: languageStageStatus(stage), current_stage: stage, current_stage_source: decider.stage_source!,
        last_status_text: decider.description!, last_update: null, expected_delivery: null, ...partnerFields, summary_only: true, events: [] };
    }
    // A parcel a partner delivers has no scans of Delnext's own: the page names the partner instead.
    if (partner) {
      return { status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
        last_status_text: `${PARTNER_LABEL} ${partner}`, last_update: null, expected_delivery: null, ...partnerFields,
        summary_only: true, events: [] };
    }
    throw new NoHistoryError(PROVIDER);
  }

  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source! } : {}),
    last_status_text: (decider ?? events[0]!).description!,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: estimate($, stage, events[0]!.local_time),
    ...partnerFields,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
