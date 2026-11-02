import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { newDeliveryDay, viadiretaStage } from './status.js';

export const PROVIDER = 'ViaDireta';
export const CARRIER = 'viadireta';
// A shipment's page is under fifty kilobytes, most of it the site's menus, forms and footer.
export const VIADIRETA_MAX_BYTES = 1_000_000;

// VD and twelve digits; VDVD, a date and six digits; VD and ten digits, the example its form shows.
const NUMBER = /^VD(?:\d{10}|\d{12}|VD\d{12})$/;
// "30-09-2026 18:55:44": a movement's wall clock, to the second.
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
// A firewall's, CDN's or bot check's page in place of the tracker's. The tracker itself loads
// reCAPTCHA for its contact forms, so that is no sign of one.
const BLOCKED = /_cf_chl_opt|cf-turnstile|challenge-platform|_Incapsula_Resource|h-captcha|requested URL was rejected|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 - Forbidden)/i;
const MAX_ROWS = 300;
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/** A number ViaDireta's tracker opens; anything else is not one it issues. */
export function normalizeViadiretaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'ViaDireta numbers are VD and twelve digits, or VDVD and twelve digits');
  }
  return number;
}

/** A movement's date and second as one wall time. The page gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = match ? DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed?.isValid || parsed.year < 2000 || parsed.toFormat('dd-MM-yyyy HH:mm:ss') !== text) {
    throw new SchemaError(PROVIDER, 'ViaDireta returned an invalid movement time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The day a movement sets the next delivery for, when it is a real day no earlier than the newest movement. */
function deliveryDay(wording: string, newest: string): string | null {
  const fields = newDeliveryDay(wording);
  if (!fields) return null;
  const [day, month, year] = fields;
  const parsed = DateTime.fromObject({ year, month, day }, { zone: 'UTC' });
  const iso = parsed.isValid && parsed.day === day && parsed.month === month ? parsed.toISODate() : null;
  return iso && iso >= newest.slice(0, 10) ? iso : null;
}

/**
 * ViaDireta's tracking page for one number, `/tracking?codigo={number}`,
 * which its server renders. Its form keeps the number asked. A shipment it
 * shows gets a card with the number, a summary and the last update, then
 * its movements, newest first, each a wall clock and a wording.
 *
 * Any number the page cannot show, a made-up one included, gets an error
 * notice to try again later. The page's own comment beside it says its API
 * returned an unexpected error, so the notice is no evidence the shipment is
 * missing: it stays inconclusive. The summary, which follows the language
 * asked, and the contact forms are not read.
 */
export function parseViadireta(html: string, raw: string): CarrierResult {
  const number = normalizeViadiretaNumber(raw);
  const $ = load(html);
  const inputs = $('form input#codigo[name="codigo"]');
  if (inputs.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ViaDireta answered with a bot check');
    throw new SchemaError(PROVIDER, 'ViaDireta did not return its tracking page');
  }
  const asked = normalizeTrackingNumber(inputs.attr('value') ?? '');
  if (!asked) throw new SchemaError(PROVIDER, 'ViaDireta did not look up the number');
  if (asked !== number) throw new IndeterminateError(PROVIDER, 'ViaDireta answered for another shipment');

  const cards = $('.tracking-status-card');
  if (!cards.length) {
    // The same notice answers a number the tracker does not hold and a lookup that failed behind it.
    if ($('.alert.alert-error').length) throw new IndeterminateError(PROVIDER, 'ViaDireta could not show the shipment');
    throw new SchemaError(PROVIDER, 'ViaDireta returned its tracking page without a shipment or a notice');
  }
  if (cards.length > 1) throw new IndeterminateError(PROVIDER, 'ViaDireta answered for several shipments');
  // "Envio Nº VD…" or "Shipment No. VD…": the number is the card's last word.
  const shown = clean(cards.find('.ts-cod').text(), 120).split(' ').pop() ?? '';
  if (!shown) throw new SchemaError(PROVIDER, 'ViaDireta returned a shipment card without its number');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'ViaDireta answered for another shipment');

  const timelines = $('.tracking-timeline');
  if (timelines.length > 1) throw new SchemaError(PROVIDER, 'ViaDireta returned several histories');
  const rows = timelines.children('.tl-item');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ViaDireta returned an oversized history');

  const seen = new Set<string>();
  const movements: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.each((index, element) => {
    const times = $(element).find('.tl-time');
    const wordings = $(element).find('.tl-desc');
    if (times.length !== 1 || wordings.length !== 1) throw new SchemaError(PROVIDER, 'ViaDireta returned an invalid movement');
    const description = clean(wordings.text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'ViaDireta returned a movement without wording');
    const local = wallClock(clean(times.text(), 40));
    const identity = JSON.stringify([local, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = viadiretaStage(description);
    movements.push({ local, index, event: {
      local_time: local,
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  if (!movements.length) throw new NoHistoryError(PROVIDER);
  // Newest first; of equal clocks, the row higher on the page is the newer.
  movements.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = movements.map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The newest movement that sets a delivery day gives the estimate, until the parcel is delivered.
  const scheduled = stage && FINAL.has(stage) ? undefined : events.find((event) => newDeliveryDay(event.description!));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: scheduled ? deliveryDay(scheduled.description!, newest.local_time!) : null,
    events,
  };
}
