import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { kyrgyzPostStage } from './status.js';

export const PROVIDER = 'Kyrgyz Post';
// A long history is a few kilobytes.
export const KYRGYZ_POST_MAX_BYTES = 512 * 1024;

const MAX_ROWS = 500;
// A wall clock to the second. Kyrgyz Post's own scans add up to seven decimals; the relayed ones have none.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// The office a relayed scan names after its event: "… (исх.). Офис: SAMPLE".
const OFFICE = /\.?\s*Офис:\s*([\s\S]*)$/u;
// A post office's six-digit postcode, as in "Принято в ПУ … - 999999".
const POSTCODE = /\s*[-–,]?\s*(?<![\p{L}\p{N}])\d{6}(?![\p{L}\p{N}])\s*[,;]?/gu;
// The delivery scan, and anything the reply could put after it about who took the item.
const HANDED_OVER = /^(Вручено\s+получателю)(?:[\s,:;.–-][\s\S]*)?$/iu;
// A firewall's, CDN's or bot check's page in place of the reply, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;

/**
 * A number for Kyrgyz Post's tracker: a UPU S10 code with a valid check
 * digit, its own or another post's.
 */
export function normalizeKyrgyzPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Kyrgyz Post tracks S10 item codes');
}

/** Whether a reply is a firewall's or bot check's page. */
export function isKyrgyzPostBlockPage(text: string): boolean {
  return BLOCKED.test(text.slice(0, 64_000));
}

/** Text without postcodes, and without what they leave dangling. */
function withoutPostcodes(text: string): string {
  return clean(text.replace(POSTCODE, ' ')).replace(/[\s,;:–-]+$/u, '');
}

/** A scan's `date`: the wall clock it was recorded at, with no zone. */
function clockOf(value: unknown): string {
  const wall = typeof value === 'string' ? CLOCK.exec(value.trim())?.[1] : undefined;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!wall || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'Kyrgyz Post returned an invalid scan time');
  }
  return wall;
}

/**
 * One scan: `EventName` and `date`. A relayed scan's event name ends with the
 * office, which becomes its place. Postcodes are dropped, and the delivery
 * scan keeps its own two words.
 */
function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row) || typeof row.EventName !== 'string') throw new SchemaError(PROVIDER, 'Kyrgyz Post returned an invalid scan');
  const name = clean(row.EventName, 300);
  const office = OFFICE.exec(name);
  const event = withoutPostcodes(office ? name.slice(0, office.index) : name);
  const description = HANDED_OVER.exec(event)?.[1] ?? event;
  if (!description) throw new SchemaError(PROVIDER, 'Kyrgyz Post returned a scan without wording');
  const location = office ? withoutPostcodes(office[1]!).slice(0, 120) : '';
  const staged = kyrgyzPostStage(description);
  return {
    local_time: clockOf(row.date),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of the tracking page's `get_track_number` lookup: the item's scans,
 * oldest first, or an empty list, which the page reports as not found. It does
 * not name the item: the request holds the whole code, and the tracker matches
 * only whole codes.
 */
export function parseKyrgyzPost(payload: unknown, rawNumber: string): CarrierResult {
  normalizeKyrgyzPostNumber(rawNumber);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Kyrgyz Post returned an invalid reply');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Kyrgyz Post returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of payload) {
    const event = scanOf(row);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Newest first; the reply runs oldest first, and a newest-first one stays as it is.
  if (events[0]!.local_time! <= events.at(-1)!.local_time!) events.reverse();

  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    events,
  };
}

/** The lookup's body: JSON, else a block page or a changed reply. */
export function parseKyrgyzPostReply(body: string, rawNumber: string): CarrierResult {
  const number = normalizeKyrgyzPostNumber(rawNumber);
  // Trimming also drops a byte order mark.
  const text = body.trim();
  if (!text) throw new IndeterminateError(PROVIDER, 'Kyrgyz Post returned an empty reply');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    if (isKyrgyzPostBlockPage(text)) throw new ChallengeError(PROVIDER, 'Kyrgyz Post answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Kyrgyz Post returned a reply that is not JSON', { cause });
  }
  return parseKyrgyzPost(payload, number);
}
