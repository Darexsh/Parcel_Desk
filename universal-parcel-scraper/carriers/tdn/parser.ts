import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { tdnStage } from './status.js';

export const PROVIDER = 'TDN';
// The page is about 45 kB of site around one status line.
export const TDN_MAX_BYTES = 512 * 1024;

// An expedition number: twelve digits starting with 9999, the layout TDN's tracking page gives.
const NUMBER = /^9999\d{8}$/;
// "Entregado - 041 - 19/12/2022 18:04": the status, the branch's number, sometimes followed by
// its name, and a clock to the minute.
const LINE = /^(.+?)(?:\s+-\s+\d{1,4}(?:\s+[^\s-](?:[^-]|(?<=\S)-(?=\S))*?)?)?\s+-\s+(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
// The tracker's answer for an expedition it has not registered, in the rail's first slot. The
// accent is left open, so a page decoded in the wrong encoding still reads as this notice.
const NOT_REGISTERED = /^Env\S{1,3}o no registrado\b/i;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
const MAX_SLOTS = 8;

/** A TDN expedition number: twelve digits starting with 9999. */
export function normalizeTdnNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TDN expedition numbers are twelve digits starting with 9999');
  return number;
}

/** A status line's wording and wall clock. The page names no zone, so the clock keeps none. */
function statusLine(text: string): { local_time: string; description: string } {
  const match = LINE.exec(text);
  if (!match) throw new SchemaError(PROVIDER, 'TDN returned a status without its time');
  const [, wording, day, month, year, hour, minute] = match;
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day),
    hour: Number(hour), minute: Number(minute) }, { zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'TDN returned an invalid status time');
  return { local_time: parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description: wording! };
}

/**
 * The tracker's page for one reference: a heading repeating the reference and
 * a progress rail of four slots, of which the current one holds the status,
 * the branch's number and the time. An expedition it has not registered gets
 * a notice in the first slot instead. There is no history, place or recipient.
 */
export function parseTdn(html: string, raw: string): CarrierResult {
  const number = normalizeTdnNumber(raw);
  const $ = load(html);
  const panels = $('div.principal');
  if (panels.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TDN answered with a browser check');
    throw new SchemaError(PROVIDER, 'TDN did not return its tracking page');
  }
  const panel = panels.first();
  const shown = clean(panel.children('h1').text(), 80);
  if (!shown) throw new SchemaError(PROVIDER, 'TDN did not name the reference');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'TDN answered for another reference');
  const slots = panel.find('.dotsandlines2 .circle-contain2');
  if (!slots.length || slots.length > MAX_SLOTS) throw new SchemaError(PROVIDER, 'TDN tracking page changed');
  const lines = slots.toArray().map((slot, index) => ({ index, text: clean($(slot).text(), 300) })).filter(({ text }) => text);
  if (!lines.length) throw new SchemaError(PROVIDER, 'TDN returned a reference without a status');
  if (lines.some(({ text }) => NOT_REGISTERED.test(text))) {
    if (lines.length > 1) throw new SchemaError(PROVIDER, 'TDN returned a status beside its not-registered notice');
    throw new NotFoundError(PROVIDER);
  }

  // Newest first: by clock, then the later slot on the rail.
  const scans = lines.map(({ index, text }) => ({ index, ...statusLine(text) }))
    .sort((left, right) => right.local_time.localeCompare(left.local_time) || right.index - left.index)
    .map(({ local_time, description }) => ({ local_time, description, staged: tdnStage(description) }));
  const events: CarrierEvent[] = scans.map(({ local_time, description, staged }) => ({
    local_time, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  }));
  const newest = scans[0]!;
  const staged = newest.staged;
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    summary_only: true,
    events,
  };
}
