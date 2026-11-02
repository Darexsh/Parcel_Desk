import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult, type EventPoint } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { serpostStage } from './status.js';

export const PROVIDER = 'Serpost';
// The tracking page is about 100 kB; a long history is a few kilobytes.
export const SERPOST_MAX_BYTES = 512 * 1024;

const ZONE = 'America/Lima';
const MAX_SCANS = 200;
// An ASP.NET Core anti-forgery token.
const TOKEN = /^[A-Za-z0-9_-]{40,400}$/;
// The scan's clock as the reply gives it, month first: "09/08/2026 12:12:30".
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const CODE = /^\d{1,4}$/;
// Bot checks and firewall pages that could stand in for the page or the reply.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Web Page Blocked|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha|Attack ID|FortiWeb|FortiGate/i;
// "ENVÍO ADMITIDO EN ADMINISTRACION POSTAL CUSCO": the office that accepted the item.
const ADMITTED = /^ENV[ÍI]O ADMITIDO EN (.+)$/u;
// "ENVÍO LLEGÓ A LA ADMINISTRACION POSTAL JESUS MARIA Av. ...": the office that received it, then its address.
const ARRIVED = /^(ENV[ÍI]O LLEG[ÓO] A(?: LA| EL)?) (?!SERPOST\b)(.+)$/u;
// The office's invitation to collect the item there instead, with its WhatsApp number.
const COLLECT = /\s+Y SI PREFIERES RECOGERLO\b.*$/u;
// The office on a map, as the page's "Ver oficina" link opens it: "...!2d<longitude>!3d<latitude>...".
const MAP = /^https:\/\/www\.google\.com\/maps\/embed\?pb=\S*?!2d(-?\d{1,3}\.\d+)!3d(-?\d{1,2}\.\d+)/;
// Serpost delivers in Peru: a point outside it is not the office's.
const PERU = { south: -18.4, north: 0, west: -81.4, east: -68.6 };

/**
 * Serpost's tracker looks up UPU S10 item codes: its own, ending PE, and those
 * of the posts that send mail to Peru. The lookup matches the start of what it
 * is sent, so only a whole code with a valid check digit binds its reply.
 */
export function normalizeSerpostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Serpost tracks S10 item codes');
}

/** A firewall or bot-check page in place of the site's own. */
export function isBlockPage(text: string): boolean {
  return BLOCK.test(text.slice(0, 64_000));
}

/** The anti-forgery token of the tracking form, which the lookup sends back with its cookie. */
export function parseSerpostForm(html: string): string {
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Serpost answered with a browser check');
  const $ = load(html);
  const forms = $('form').filter((_, form) => $(form).find('input#txtEnvio').length === 1);
  const tokens = forms.length === 1 ? forms.find('input[name="__RequestVerificationToken"]') : null;
  const token = tokens?.length === 1 ? tokens.attr('value') ?? '' : '';
  if (!TOKEN.test(token)) throw new SchemaError(PROVIDER, 'Serpost tracking form changed');
  return token;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Serpost returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock, "MM/DD/YYYY HH:mm:ss", the wall clock of the Peruvian office
 * that made it, read on Lima time.
 */
function instant(value: string): string {
  const match = CLOCK.exec(value);
  const local = match ? `${match[3]}-${match[1]}-${match[2]}T${match[4]}:${match[5]}:${match[6]}` : '';
  // The calendar check reads the clock as written, before it is placed on Lima time.
  const written = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  const time = written?.isValid && written.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local && written.year >= 2000
    ? firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toISO({ suppressMilliseconds: true }) : null;
  if (!time) throw new SchemaError(PROVIDER, 'Serpost returned an invalid scan time');
  return time;
}

/** The leading words in capitals: the office's name, before an address the tracker writes in mixed case. */
function office(words: string): string {
  const name: string[] = [];
  for (const word of words.split(' ')) {
    if (/\p{Ll}/u.test(word)) break;
    name.push(word);
  }
  return name.join(' ').replace(/[\s,.;:-]+$/, '');
}

/** The scan's wording without the office's contact details, and the office it names. */
function wordingOf(event: string): { description: string; location: string } {
  const wording = event.replace(COLLECT, '');
  const admitted = ADMITTED.exec(wording);
  if (admitted) return { description: wording, location: office(admitted[1]!) };
  const arrived = ARRIVED.exec(wording);
  const place = arrived ? office(arrived[2]!) : '';
  return place ? { description: `${arrived![1]} ${place}`, location: place } : { description: wording, location: '' };
}

/** The office on the map the row links, if it is one in Peru. */
function pointOf(note: string): EventPoint | null {
  const match = MAP.exec(note);
  const point = match ? eventPoint(match[2], match[1]) : null;
  return point && point.latitude >= PERU.south && point.latitude <= PERU.north
    && point.longitude >= PERU.west && point.longitude <= PERU.east ? point : null;
}

interface Scan { event: CarrierEvent; index: number }

/**
 * One row: `fecha`, the scan's `evento`, a `codigo` from one of Serpost's two
 * systems and an `observacion`, the page's note under the scan or a map of
 * the office. The note is no part of the history and is not kept.
 */
function scanOf(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Serpost returned an invalid scan');
  const { description, location } = wordingOf(text(row, 'evento', 300));
  if (!description) throw new SchemaError(PROVIDER, 'Serpost returned a scan without wording');
  const time = instant(text(row, 'fecha', 32));
  const code = text(row, 'codigo', 16);
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Serpost returned an invalid scan code');
  const point = pointOf(text(row, 'observacion', 2000));
  const staged = serpostStage(description, code);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    ...(point ? { point } : {}),
  };
  return { event, index };
}

/**
 * The reply of the page's `POST /Cliente/SegumientoLinea/ObtenerTracking` for
 * one code: Serpost's scans of the item newest first. It does not echo the
 * code, so its scans are those of the code asked for. An empty array is the
 * page's "Número de envío no registrado en el sistema".
 */
export function parseSerpost(payload: unknown, rawNumber: string): CarrierResult {
  normalizeSerpostNumber(rawNumber);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Serpost returned an invalid reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Serpost returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  payload.forEach((row, index) => {
    const scan = scanOf(row, index);
    // A row the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans at the same second keep the reply's order.
  scans.sort((left, right) => Date.parse(right.event.time!) - Date.parse(left.event.time!) || left.index - right.index);
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  // Serpost hands items over in Peru only.
  const delivering = events.some(event => ['out_for_delivery', 'ready_for_pickup', 'failed_attempt', 'delivered'].includes(event.stage ?? ''));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    ...(delivering ? { destination_country: 'PE' } : {}),
    events,
  };
}
