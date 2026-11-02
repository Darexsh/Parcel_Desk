import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { royalExpressStage } from './status.js';

export const PROVIDER = 'Royal Express';
// The page is about 65 kilobytes, with or without a history.
export const ROYAL_EXPRESS_MAX_BYTES = 512 * 1024;
// A branch waybill (an office's three letters, digits and the destination's
// three letters) or a member waybill (three letters and six digits).
const WAYBILL = /^[A-Z]{3}\d{6,11}(?:[A-Z]{3})?$/;
const TOKEN = /^[A-Za-z0-9]{20,100}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*:\s*([\s\S]*)$/;
// The tracker's answer for a waybill it has no parcel for; it names the waybill.
const NOT_FOUND = /^Waybill No not found with this Tracking Code\s+(\S{1,64})$/i;
// The office a scan's sentence starts with, "MDY-C2 ရုံးမှ" ("from the MDY-C2 office").
const FROM_OFFICE = /^(\S[\s\S]*?)\s+ရုံးမှ\s+([\s\S]+)$/u;
// An office code with the township it serves, "YGN-HUB(မြောက်ဥက္ကလာပ)".
const OFFICE = /^([A-Z0-9]+(?:-[A-Z0-9]+)*)\s*\(([\s\S]+)\)$/;
// A run of seven or more digits, Burmese ones included, as phone numbers are written.
const PHONE = /\+?[\d၀-၉](?:[\s().-]{0,2}[\d၀-၉]){6,}/gu;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill in upper case, as the tracker shows it; anything else is not one Royal Express issues. */
export function normalizeRoyalExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!WAYBILL.test(number)) throw new InvalidInputError(PROVIDER, 'Royal Express waybills are three letters and six to eleven digits, with three more letters on a branch waybill');
  return number;
}

const blocked = (html: string) => BLOCKED.test(html.slice(0, 64_000));

/** The token the tracking page's form carries, which its post must send back with the page's session. */
export function royalExpressFormToken(html: string): string {
  const $ = load(html);
  const form = $('form[action$="/tracking"]').filter((_, element) => $(element).find('input[name="waybill-number"]').length === 1).first();
  const token = form.find('input[name="_token"]').attr('value')?.trim() ?? '';
  if (TOKEN.test(token)) return token;
  if (blocked(html)) throw new ChallengeError(PROVIDER, 'Royal Express answered with a browser check');
  throw new SchemaError(PROVIDER, 'Royal Express’s tracking page has no form');
}

/** The office as a scan's location: its code, with the township it serves when the page names one. */
function office(value: string): string {
  const match = OFFICE.exec(value);
  if (!match) return value;
  const [, code, township] = match as unknown as [string, string, string];
  const place = clean(township, 80);
  return place && place !== code ? `${code} (${place})` : code;
}

function projectRow(row: { leg: string; step: string; line: string }): { key: string; event: CarrierEvent } {
  const clock = CLOCK.exec(row.line);
  if (!clock) throw new SchemaError(PROVIDER, 'Royal Express returned a scan without its time');
  const local = `${clock[1]}T${clock[2]}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Royal Express returned an invalid scan time');
  const sentence = clean(clock[3]!.replace(PHONE, ''), 300);
  const from = FROM_OFFICE.exec(sentence);
  const location = from ? office(clean(from[1], 120)) : '';
  const code = [row.leg, row.step].filter(Boolean).join('-').toLowerCase();
  const description = (from ? clean(from[2], 300) : sentence) || [row.leg, row.step].filter(Boolean).join(' ');
  if (!description) throw new SchemaError(PROVIDER, 'Royal Express returned a scan without wording');
  const staged = royalExpressStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/**
 * The tracking page's answer to its form. A waybill it knows is headed
 * "Tracking No." with the waybill, beside the sender, receiver and recipient
 * and over its scans, newest first; one it does not know gets a line naming
 * the waybill. Either must name the waybill asked.
 */
export function parseRoyalExpress(html: string, raw: string): CarrierResult {
  const number = normalizeRoyalExpressNumber(raw);
  const $ = load(html);
  const heading = $('h6').filter((_, element) => clean($(element).text(), 120).startsWith('Tracking No.')).first();
  if (!heading.length) {
    const missing = NOT_FOUND.exec(clean($('p.text-center.red').first().text(), 160))?.[1];
    if (missing) {
      if (normalizeTrackingNumber(missing) !== number) throw new IndeterminateError(PROVIDER, 'Royal Express answered for another waybill');
      throw new NotFoundError(PROVIDER);
    }
    if (blocked(html)) throw new ChallengeError(PROVIDER, 'Royal Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'Royal Express returned an unexpected page');
  }
  const shown = clean(heading.find('span').first().text(), 80);
  if (!shown) throw new SchemaError(PROVIDER, 'Royal Express returned a parcel without its waybill');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'Royal Express answered for another waybill');

  const rows = $('ul.timeline > li.event');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Royal Express returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const element of rows.toArray()) {
    const row = $(element);
    const scan = projectRow({ leg: clean(row.find('span.text-danger').first().text(), 40),
      step: clean(row.find('span.fw-semibold').first().text(), 60), line: clean(row.find('p.draft').first().text(), 600) });
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; a stable sort keeps the page's order within a second.
  events.sort((a, b) => (b.local_time as string).localeCompare(a.local_time as string));

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
