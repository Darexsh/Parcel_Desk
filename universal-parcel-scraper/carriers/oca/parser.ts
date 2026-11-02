import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { ocaStage } from './status.js';

export const PROVIDER = 'OCA';
// A long history is a few kilobytes, with the dataset's schema before it.
export const OCA_MAX_BYTES = 256 * 1024;
const NUMBER = /^\d{19}$/;
// A piece's number ends with a dash and the piece's digit.
const PIECE = /-\s*\d\s*$/;
const DATASET = '#Oca_e_Pak';
const DIFFGRAM = 'urn:schemas-microsoft-com:xml-diffgram-v1';
// A wall clock to the second, mostly with a fraction.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const ZONE = 'America/Argentina/Buenos_Aires';
// The branch the service appends to each state.
const BRANCH = /(?:^|\s)-\s+Suc:.*$/i;
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|_Incapsula_Resource|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/**
 * A number for OCA's tracking service: nineteen digits. A piece's dash and
 * digit are dropped, since the service tracks the parcel.
 */
export function normalizeOcaNumber(raw: string): string {
  const typed = raw.length <= 64 ? raw : '';
  const digits = normalizeTrackingNumber(typed);
  const number = digits.length === 20 && PIECE.test(typed) ? digits.slice(0, 19) : digits;
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'OCA numbers are nineteen digits');
  return number;
}

/** One text field of a row; a field the row repeats or nests is a changed reply. */
function field(row: XmlNode, name: string, maxLength = 200): string {
  const found = row.children.filter((child) => child.name === name && child.uri === '');
  if (found.length > 1 || found[0]?.children.length) throw new SchemaError(PROVIDER, `OCA returned an invalid ${name}`);
  return clean(found[0]?.text ?? '', maxLength);
}

/**
 * A scan's clock: Argentina's wall clock, without an offset. The service's
 * sibling method that sends the same scans as dates gives them `-03:00`, and
 * Argentina has one zone, without daylight saving.
 */
function scanTime(value: string): string {
  const match = CLOCK.exec(value);
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // UTC only checks the calendar fields. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'OCA returned an invalid scan time');
  }
  return firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })!;
}

/**
 * A scan's wording: the state without the branch the service appends, then
 * the reason in brackets when the state does not already give it.
 */
export function ocaWording(state: string, reason: string): string {
  const own = clean(state.replace(BRANCH, ''), 200);
  const why = clean(reason, 120);
  if (!why || /^sin motivo$/i.test(why) || own.toLowerCase().includes(why.toLowerCase())) return own;
  return own ? `${own} (${why})` : '';
}

interface Scan { event: CarrierEvent; at: number; order: number }

function readRow(row: XmlNode, number: string, order: number): Scan {
  if (row.name !== 'Table' || row.uri !== '') throw new SchemaError(PROVIDER, 'OCA returned an unexpected row');
  const echoed = field(row, 'NumeroEnvio', 64);
  if (!echoed) throw new SchemaError(PROVIDER, 'OCA returned a scan without its number');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'OCA answered for another shipment');
  const description = ocaWording(field(row, 'Desdcripcion_Estado', 300), field(row, 'Descripcion_Motivo', 120));
  if (!description) throw new SchemaError(PROVIDER, 'OCA returned a scan without its state');
  const time = scanTime(field(row, 'fecha', 32));
  const location = field(row, 'SUC', 160).replace(/^Suc:\s*/i, '');
  const staged = ocaStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: DateTime.fromISO(time).toMillis(), order };
}

/**
 * The reply of the e-Pak service's `Tracking_Pieza` for one number: a .NET
 * dataset whose rows are the parcel's states, oldest first, each naming the
 * parcel. A dataset without rows is the service's answer for a number it does
 * not know.
 */
export function parseOca(xml: string, raw: string): CarrierResult {
  const number = normalizeOcaNumber(raw);
  const root = xmlDocument(xml, OCA_MAX_BYTES);
  if (!root || root.name !== 'DataSet' || root.uri !== DATASET) {
    if (CHALLENGE.test(xml.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'OCA answered with a browser check');
    throw new SchemaError(PROVIDER, 'OCA returned a reply that is not its tracking dataset');
  }
  const diffgrams = root.children.filter((child) => child.name === 'diffgram' && child.uri === DIFFGRAM);
  if (diffgrams.length !== 1) throw new SchemaError(PROVIDER, 'OCA returned a dataset without its rows');
  const sets = diffgrams[0]!.children;
  if (sets.length > 1 || sets.some((set) => set.name !== 'NewDataSet' || set.uri !== '')) {
    throw new SchemaError(PROVIDER, 'OCA returned an unexpected dataset');
  }
  const rows = sets[0]?.children ?? [];
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'OCA returned an oversized history');

  const seen = new Set<string>();
  // Newest first; equal clocks put the later row first.
  const ordered = rows.map((row, order) => readRow(row, number, order)).filter(({ event }) => {
    const identity = JSON.stringify([event.time, event.description, event.location]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => b.at - a.at || b.order - a.order);

  const events = ordered.map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The delivery is the first scan of the run of delivered scans the history ends with.
  const ended = events.findIndex((event) => event.stage && event.stage !== 'delivered');
  const delivery = stage === 'delivered'
    ? events.slice(0, ended < 0 ? undefined : ended).reverse().find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
