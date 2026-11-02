import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { pflogisticsNumber } from './number.js';
import { pflogisticsStage } from './status.js';

export const PROVIDER = 'Parcel Freight Logistics';
export const PFLOGISTICS_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|captcha-delivery|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|verify (?:that )?you are human/i;
const NOT_FOUND = "We couldn't find your tracking number";

/** A clock rendered for timezone=UTC; a clock with its own offset keeps it. */
function scanTime(raw: string): { iso: string; timestamp: number } {
  const parts = CLOCK.exec(raw);
  const parsed = DateTime.fromISO(parts ? `${parts[1]}T${parts[2]}${parts[3] ?? 'Z'}` : '', { setZone: true });
  if (!parts || !parsed.isValid || parsed.toFormat('yyyy-MM-dd HH:mm:ss') !== `${parts[1]} ${parts[2]}`) {
    throw new SchemaError(PROVIDER, 'PFL returned an invalid scan clock');
  }
  return { iso: parsed.toISO({ suppressMilliseconds: true }), timestamp: parsed.toMillis() };
}

/**
 * The server-rendered parcel result, requested with timezone=UTC. The result
 * names the whole reference and its first row is a scan, followed by the
 * remaining history inside expand-box; the progress rail is not history.
 */
export function parsePflogistics(html: string, raw: string): CarrierResult {
  const number = pflogisticsNumber(raw);
  if (html.length > PFLOGISTICS_MAX_BYTES) throw new SchemaError(PROVIDER, 'PFL returned an oversized tracking page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PFL answered with a browser check');
  const $ = load(html);
  const results = $('[id="res-shadow-box"]');
  const errors = $('#result-lines [id="error-des"]');
  if (!results.length && errors.length === 1) {
    const title = clean(errors.children('h3').text());
    const echoed = errors.children('p').children('b');
    if (title === NOT_FOUND && echoed.length === 1 && normalizeTrackingNumber(echoed.text()) === number) {
      throw new NotFoundError(PROVIDER);
    }
    throw new IndeterminateError(PROVIDER, 'PFL returned an unrecognized tracking notice');
  }
  const identity = results.find('[id="tracking-number"]');
  if (results.length !== 1 || errors.length || identity.length !== 1 || $('[id="tracking-number"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'PFL returned a page without one parcel result');
  }
  // Compare the whole text before any display limit: a matching prefix is not this parcel.
  if (normalizeTrackingNumber(identity.text()) !== number) {
    throw new IndeterminateError(PROVIDER, 'PFL answered for another parcel reference');
  }
  const rows = results.find('.grey-border.extra-padding');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PFL returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const seen = new Set<string>();
  const scans: { event: CarrierEvent; timestamp: number }[] = [];
  rows.each((_, element) => {
    const row = $(element).children('.res-padding');
    const heading = row.children('.res-left').children('[id="main-status"]');
    const detail = row.children('.res-left').children('p');
    const place = row.children('.res-mid').children('p');
    const clock = row.children('.res-right').children('p');
    if (row.length !== 1 || heading.length !== 1 || detail.length !== 1 || place.length !== 1 || clock.length !== 1) {
      throw new SchemaError(PROVIDER, 'PFL returned an incomplete scan');
    }
    const label = clean(heading.text(), 100);
    const description = clean(detail.text(), 500) || label;
    if (!label || !description) throw new SchemaError(PROVIDER, 'PFL returned a scan without its wording');
    const time = scanTime(clean(clock.text(), 80));
    const location = clean(place.text(), 120);
    const staged = pflogisticsStage(label, description);
    const event: CarrierEvent = { time: time.iso, description,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) {
      seen.add(key);
      scans.push({ event, timestamp: time.timestamp });
    }
  });
  // The page lists newest first; stable sorting keeps its order for equal clocks.
  scans.sort((left, right) => right.timestamp - left.timestamp);
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!, last_update: newest.time!, expected_delivery: null, timezone: 'UTC',
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
