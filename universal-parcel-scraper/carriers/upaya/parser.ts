import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeUpayaNumber } from './number.js';
import { upayaMappedStage, upayaStage } from './status.js';

export { normalizeUpayaNumber } from './number.js';

export const PROVIDER = 'Upaya';
// A history of thirty scans is about twenty kilobytes; an unknown code's reply is a few hundred bytes.
export const UPAYA_MAX_BYTES = 512 * 1024;
// The page shows every scan on Nepal's clock.
const NEPAL_ZONE = 'Asia/Kathmandu';
// Firewall and bot check pages, which could stand in for the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
// A scan's line and its hub, as the page joins them: "Failed pickup · Kathmandu Hub".
const META_SEPARATOR = /\s+·\s+/;
const MAX_ROWS = 300;

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** Whether a reply is a firewall's or a bot check's rather than the tracker's. */
export function isUpayaBlockPage(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** Whether a code the reply shows is the whole code asked, with or without its hyphen. */
function sameCode(shown: unknown, number: string): boolean {
  const code = clean(shown, 64);
  return Boolean(code) && normalizeTrackingNumber(code) === normalizeTrackingNumber(number);
}

/** A scan's instant on Nepal's clock, from the UTC time the page puts in its `datetime`. */
function instant(value: string | undefined): { iso: string; at: number } {
  const parsed = explicitOffsetTime(value, 40);
  const iso = parsed ? DateTime.fromMillis(parsed.timestamp, { zone: NEPAL_ZONE }).toISO({ suppressMilliseconds: true }) : null;
  if (!parsed || !iso) invalid('Upaya returned an invalid scan time');
  return { iso, at: parsed.timestamp };
}

/** A scan's wording: its heading, then its own line unless that repeats the heading, as "Pickup Process: Failed pickup". */
export function upayaWording(title: string, detail: string): string {
  if (!detail) return title;
  if (!title || detail.toLowerCase().startsWith(title.toLowerCase())) return detail;
  return `${title}: ${detail}`;
}

/** One element of `selector` inside `scope`, or none; more is a changed page. */
function single(scope: Cheerio<AnyNode>, selector: string, what: string): Cheerio<AnyNode> {
  const found = scope.find(selector);
  if (found.length > 1) invalid(`Upaya repeated a scan's ${what}`);
  return found;
}

interface Row { title: string; parts: string[]; time: { iso: string; at: number } }

/** The timeline's scans as the page lists them, newest first. */
function rows($: CheerioAPI, result: Cheerio<AnyNode>): Row[] {
  const items = result.find('.uot-timeline > .uot-timeline__item').toArray();
  if (items.length > MAX_ROWS) invalid('Upaya returned an oversized history');
  return items.map((node) => {
    const item = $(node);
    const title = clean(single(item, '.uot-timeline__title', 'heading').text(), 120);
    const parts = clean(single(item, '.uot-timeline__meta', 'line').text(), 300).split(META_SEPARATOR).map((part) => clean(part, 160)).filter(Boolean);
    const clock = single(item, 'time.uot-timeline__time', 'time');
    if (!clock.length) invalid('Upaya returned a scan without its time');
    return { title, parts, time: instant(clock.attr('datetime')) };
  });
}

/**
 * The scans' events. A line of two parts is the scan's own wording and its
 * hub; anything between them is left out. A line of one part is a hub when
 * another scan or the result's own hub names it, as on a cancellation, and
 * the scan's wording otherwise.
 */
function events(scans: readonly Row[], hub: string): CarrierEvent[] {
  const places = new Set([hub, ...scans.filter((row) => row.parts.length > 1).map((row) => row.parts.at(-1)!)].filter(Boolean));
  const seen = new Set<string>();
  const list: { at: number; event: CarrierEvent }[] = [];
  for (const row of scans) {
    const placeOnly = row.parts.length === 1 && places.has(row.parts[0]!);
    const detail = placeOnly ? '' : row.parts[0] ?? '';
    const location = placeOnly ? row.parts[0]! : row.parts.length > 1 ? row.parts.at(-1)! : '';
    const description = upayaWording(row.title, detail);
    if (!description) invalid('Upaya returned a scan without its wording');
    const key = JSON.stringify([row.time.at, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = upayaStage(description);
    list.push({ at: row.time.at, event: {
      time: row.time.iso,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // The page lists the newest first; a list the other way round is turned round.
  if (list.length > 1 && list[0]!.at < list.at(-1)!.at) list.reverse();
  return list.map(({ event }) => event);
}

/**
 * The result fragment of one tracking code: a summary with the code, the
 * current status and facts such as the service, the sender and the receiver,
 * the timeline newest first, and the hub that handles the parcel with its
 * contacts. Only the status, the service, the scans and their hubs are kept.
 */
function parseResult(html: string, number: string): CarrierResult {
  const $ = load(html);
  const results = $('[data-uot-result]');
  if (!results.length) {
    if (isUpayaBlockPage(html)) throw new ChallengeError(PROVIDER, 'Upaya answered with a block page');
    invalid('Upaya did not return its tracking result');
  }
  if (results.length > 1) throw new IndeterminateError(PROVIDER, 'Upaya listed several shipments for the code');
  const result = results.first();
  const shown = result.find('.uot-summary [data-uot-copy-value]');
  if (shown.length !== 1) invalid('Upaya returned a result without its code');
  if (!sameCode(shown.attr('data-uot-copy-value'), number)) throw new IndeterminateError(PROVIDER, 'Upaya answered for another shipment');

  const status = clean(result.find('.uot-summary .uot-status').first().text(), 120);
  const facts = new Map(result.find('.uot-facts .uot-fact').toArray()
    .map((fact) => [clean($(fact).children('dt').text(), 60).toLowerCase(), clean($(fact).children('dd').text(), 120)]));
  const service = facts.get('service') ?? '';
  const hub = clean(result.find('.uot-hub .uot-hub__name').first().text(), 160);

  const history = events(rows($, result), hub);
  const newest = history[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  // The summary's status decides when the map knows it; otherwise the newest scan with a stage.
  const summary = upayaMappedStage(status);
  const scanned = history.find((event) => event.stage);
  // A scan's stage comes from upayaStage, so it is one of the stages.
  const stage = summary ?? scanned?.stage as Stage | undefined;
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  const deliveredAt = stage === 'delivered' ? history.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(service ? { service_name: service } : {}),
    events: history,
  };
}

/**
 * The reply of the tracking page's `upaya-tracking/v1/track` lookup for one
 * code: `ok`, the code it found and the result as HTML, or `ok: false` with an
 * error and a notice. `uot_not_found` is the page's "No order found for this
 * tracking code", and `invalid_code` its "That does not look like a tracking
 * code". The result must show the whole code asked.
 */
export function parseUpaya(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeUpayaNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') invalid('Upaya returned an invalid reply');
  if (!payload.ok) {
    if (typeof payload.error !== 'string') invalid('Upaya returned a failure without its reason');
    if (payload.error === 'uot_not_found') throw new NotFoundError(PROVIDER);
    if (payload.error === 'invalid_code') throw new InvalidInputError(PROVIDER, 'Upaya does not read the code as a tracking code', { reason: 'wrong_number' });
    throw new IndeterminateError(PROVIDER, 'Upaya did not complete the lookup');
  }
  if (typeof payload.code !== 'string' || typeof payload.html !== 'string') invalid('Upaya returned a result without its code');
  if (!sameCode(payload.code, number)) throw new IndeterminateError(PROVIDER, 'Upaya answered for another shipment');
  return parseResult(payload.html, number);
}
