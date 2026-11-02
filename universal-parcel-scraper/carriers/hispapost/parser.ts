import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { hispapostStage } from './status.js';

export const PROVIDER = 'Hispapost';
// The page and its answer are a few kilobytes.
export const HISPAPOST_MAX_BYTES = 256 * 1024;
// Hispapost delivers in Spain and its tracker gives no zone.
const ZONE = 'Europe/Madrid';

const BARCODE = /^(?=.*\d)[A-Z0-9]{6,40}$/;
// Temu's parcel numbers, which the tracker holds with their dashes: BG-2411035ABCDEFGHI-01.
const TEMU = /^BG(\d{7}[A-Z0-9]{9})(\d{2})$/;
const TOKEN = /^[\w-]{20,200}$/;
const CLOCK = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;
const TITLE = /^Estado del envío:\s*(\S{1,64})$/;
// The flash message for a barcode the tracker has no parcel for; it names the barcode.
const NOT_FOUND = /^No hemos encontrado ningún envío con código de barras\s+(\S{1,64})$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha/i;

/** Letters and digits, as the barcode reads once separators are removed. */
export function normalizeHispapostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!BARCODE.test(number)) throw new InvalidInputError(PROVIDER, 'Hispapost barcodes are six to forty letters and digits');
  return number;
}

/**
 * The barcode as the tracker matches it. It finds a parcel only by its whole
 * barcode as printed, so a Temu number gets back the dashes normalization removed.
 */
export function hispapostBarcode(number: string): string {
  const temu = TEMU.exec(number);
  return temu ? `BG-${temu[1]}-${temu[2]}` : number;
}

const blocked = (html: string) => BLOCKED.test(html.slice(0, 64_000));

/** The token the tracking page's form carries, which its post must send back with the page's session. */
export function hispapostFormToken(html: string): string {
  const $ = load(html);
  const token = $('form[action="/tracking"] input[name="authenticity_token"]').attr('value')?.trim() ?? '';
  if (TOKEN.test(token) && $('form[action="/tracking"] input[name="barcode"]').length === 1) return token;
  if (blocked(html)) throw new ChallengeError(PROVIDER, 'Hispapost answered with a browser check');
  throw new SchemaError(PROVIDER, 'Hispapost’s tracking page has no form');
}

/**
 * The tracker's refusal, HTTP 422: the form again with a flash message. Only
 * the message for the barcode asked says there is no such parcel.
 */
export function parseHispapostRefusal(html: string, rawNumber: string): never {
  const number = normalizeHispapostNumber(rawNumber);
  const message = clean(load(html)('.alert-danger').clone().children('button').remove().end().text(), 200);
  const named = NOT_FOUND.exec(message)?.[1];
  if (named) {
    if (normalizeTrackingNumber(named) !== number) throw new SchemaError(PROVIDER, 'Hispapost answered for a different barcode');
    throw new NotFoundError(PROVIDER);
  }
  if (blocked(html)) throw new ChallengeError(PROVIDER, 'Hispapost answered with a browser check');
  throw new SchemaError(PROVIDER, 'Hispapost refused the lookup without saying why');
}

/**
 * The tracker's answer for a barcode it knows: the parcel's current status and
 * when it was set, under a heading naming the barcode. It has no history,
 * place or recipient.
 */
export function parseHispapost(html: string, rawNumber: string): CarrierResult {
  const number = normalizeHispapostNumber(rawNumber);
  const $ = load(html);
  const title = TITLE.exec(clean($('.page-title h1').first().text(), 120))?.[1];
  if (!title) {
    if (blocked(html)) throw new ChallengeError(PROVIDER, 'Hispapost answered with a browser check');
    throw new SchemaError(PROVIDER, 'Hispapost returned an unexpected page');
  }
  if (normalizeTrackingNumber(title) !== number) throw new SchemaError(PROVIDER, 'Hispapost answered for a different barcode');
  const info = $('.tracking-info');
  const description = clean(info.find('p.h2').first().text(), 160);
  const shown = clean(info.find('p.h4').first().text(), 40);
  if (info.length !== 1 || !description) throw new SchemaError(PROVIDER, 'Hispapost returned a parcel without its status');
  // The status's clock: Hispapost's wall clock to the minute.
  const clock = shown ? CLOCK.test(shown) ? zonedTime(shown, 'dd/MM/yyyy HH:mm', ZONE) : null : undefined;
  if (clock === null) throw new SchemaError(PROVIDER, 'Hispapost returned an invalid status time');
  const staged = hispapostStage(description);
  const event: CarrierEvent = {
    ...(clock ? { time: clock.iso } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: description,
    last_update: clock?.iso ?? null,
    expected_delivery: null,
    ...(staged?.stage === 'delivered' && clock ? { delivered_at: clock.iso } : {}),
    timezone: ZONE,
    summary_only: true,
    events: [event],
  };
}
