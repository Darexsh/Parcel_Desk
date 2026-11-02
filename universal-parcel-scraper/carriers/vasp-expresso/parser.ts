import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { vaspExpressoStage } from './status.js';

export const PROVIDER = 'Vasp Expresso';
// A long history is under ten kilobytes.
export const VASP_EXPRESSO_MAX_BYTES = 512 * 1024;

// A service barcode, or a volume's: the service barcode and a three-digit counter.
const NUMBER = /^(?:\d{13}|\d{16})$/;
// The wall clock the page shows, to the second, with up to seven digits of fraction and no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,7})?$/;
// Bot checks a CDN or firewall could put in place of the reply. The site's own
// pages load reCAPTCHA, so that alone is no check.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
// The created event, whose Kios store the page does not show.
const CREATED = '1';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Vasp Expresso number: a thirteen-digit service barcode or a sixteen-digit volume barcode. */
export function normalizeVaspExpressoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Vasp Expresso numbers are thirteen digits, or sixteen with a volume counter');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Vasp Expresso returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * An event's `eventDate`, the wall clock the page shows. Most events carry a
 * record stamp, `createdDateUtc`, about an hour before it in summer, as Lisbon
 * time would be; events from delivery rounds carry the same value in both,
 * so the clock keeps no zone.
 */
function scanClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  // .NET writes its minimum date where it has none.
  if (!match || !day || day < '2000-01-01') throw new SchemaError(PROVIDER, 'Vasp Expresso returned an invalid scan time');
  return `${day}T${match[4]}:${match[5]}:${match[6]}`;
}

function projectEvent(row: unknown): { key: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Vasp Expresso returned an invalid scan');
  const id = row.eventTypeId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new SchemaError(PROVIDER, 'Vasp Expresso returned a scan without its type');
  }
  const code = String(id);
  const wording = text(row, 'eventDescriptionPT') || text(row, 'eventDescriptionENG');
  if (!wording) throw new SchemaError(PROVIDER, 'Vasp Expresso returned a scan without wording');
  // An incidence's reason, such as an absent recipient, follows its wording as the page shows it.
  const reason = text(row, 'incidencePT') || text(row, 'incidenceENG');
  const description = reason ? `${wording}: ${reason}` : wording;
  const local = scanClock(row.eventDate);
  // The Kios store a scan names, else the depot that read it.
  const kios = code === CREATED ? '' : text(row, 'kios');
  const location = kios || text(row, 'depotName', 120);
  const staged = vaspExpressoStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/**
 * The reply of the tracking page's `/api/TrackAndTrace` for one number. The
 * page reads an empty reply, HTTP 204, as "Não existe registo". A service
 * must name the number asked; a volume barcode finds its service, whose
 * number is the barcode without its counter.
 */
export function parseVaspExpresso(body: string, raw: string): CarrierResult {
  const number = normalizeVaspExpressoNumber(raw);
  const service = number.slice(0, 13);
  // A byte-order mark is whitespace to trim().
  const trimmed = body.trim();
  if (!trimmed || trimmed === 'null') throw new NotFoundError(PROVIDER);
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (cause) {
    if (CHALLENGE.test(trimmed.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Vasp Expresso answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Vasp Expresso returned a reply that is not JSON', { cause });
  }
  if (!isRecord(payload) || !isRecord(payload.service)) throw new SchemaError(PROVIDER, 'Vasp Expresso returned a reply without its service');
  const shown = payload.service.serviceBarCode;
  if (typeof shown !== 'string' || !clean(shown)) throw new SchemaError(PROVIDER, 'Vasp Expresso returned a service without its number');
  if (clean(shown, 64) !== service) throw new IndeterminateError(PROVIDER, 'Vasp Expresso answered for another shipment');

  const rows = payload.clientEvents ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Vasp Expresso returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Vasp Expresso returned an oversized history');
  const current = payload.currentEvent ?? null;
  if (current !== null && !isRecord(current)) throw new SchemaError(PROVIDER, 'Vasp Expresso returned an invalid current event');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  const add = (scan: { key: string; event: CarrierEvent }) => {
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    events.push(scan.event);
  };
  // The page heads the history with the current event, which the list can
  // lack: a parcel back at the depot after a failed round, for one. When the
  // list has it, the copy is dropped.
  if (current) add(projectEvent(current));
  for (const row of rows) add(projectEvent(row));
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans of the same second keep the reply's order.
  events.sort((a, b) => (a.local_time! < b.local_time! ? 1 : a.local_time! > b.local_time! ? -1 : 0));

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(number !== service ? { canonical_tracking_number: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
