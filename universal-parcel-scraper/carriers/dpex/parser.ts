import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { parseGetOnline, type GetOnlineMember } from '../skynet-worldwide/getonline.js';
import { dpexStage } from './status.js';

export const PROVIDER = 'DPEX Worldwide';
/** The GETOnline page dpex.com frames for a number, on Frontier Force's own host. */
export const DPEX_TRACKER = 'https://tracking.frontierforce.com/go/plm-tracking';
/** DPEX China's trace-and-track page, where dpex.com.cn's search leads. */
export const DPEX_CHINA_TRACKER = 'https://erp.dpex.com.cn/trace-and-track/index';
// Air waybills are twelve digits, the last the first eleven modulo 7.
const NUMBER = /^\d{12}$/;

/** A DPEX air waybill: twelve digits whose last is the first eleven modulo 7. */
export function normalizeDpexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || !hasMod7CheckDigit(number)) {
    throw new InvalidInputError(PROVIDER, 'DPEX air waybills are twelve digits ending in their check digit');
  }
  return number;
}

export const DPEX: GetOnlineMember = {
  carrier: 'dpex', provider: PROVIDER, name: 'DPEX', stid: 'dpexwwe', tracker: DPEX_TRACKER,
  normalize: normalizeDpexNumber, stage: dpexStage,
};

/** The GETOnline page for one air waybill, `go/plm-tracking?stid=dpexwwe&cn=`. */
export const parseDpex = (html: string, rawNumber: string): CarrierResult => parseGetOnline(html, rawNumber, DPEX);

const MAX_ROWS = 500;
// The three arrays the server writes into the page's first script, one entry per number asked.
const ARRAYS = /<script>var trackAndEventsArray = (\[[\s\S]*?\]);\s*var cardInfoArray = (\[[\s\S]*?\]);\s*var locationNamesArray = (\[[\s\S]*?\]);\s*<\/script>/;
// The page's own entry for a number its system holds nothing for.
const NO_TRACK = 'No track found';
// "2025-08-23 09:33:00", the clock of the station that entered the scan.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^\d{1,6}$/;
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected/i;

type Row = [Record<string, unknown>, Record<string, unknown>];

/** A field the page writes as a string or a number, as text. */
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SchemaError(PROVIDER, 'DPEX China returned an unreadable history');
  }
}

/** One scan: the entering station's wall clock, the event's tracker number and wording, and its place. */
function scanOf([track, event]: Row, place: unknown): CarrierEvent {
  const clock = typeof track.TrackDateTime === 'string' ? CLOCK.exec(track.TrackDateTime) : null;
  const code = text(event.TrackEventCode);
  const description = clean(event.TrackEventCustViewName, 300);
  if (!clock || !CODE.test(code) || !description) throw new SchemaError(PROVIDER, 'DPEX China returned a scan it does not render');
  const location = clean(place, 120);
  const staged = dpexStage(code, description);
  return {
    local_time: `${clock[1]}T${clock[2]}`,
    ...(location && location !== 'N/A' ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * DPEX China's page for one number, `trace-and-track/index?id=`. The server
 * writes the history into the page's script as JSON, oldest first: for each
 * scan the number, the station's clock, the event and, in a list beside it,
 * the place. Every scan must name the number asked. A number the system holds
 * nothing for comes back as its "No track found" entry.
 */
export function parseDpexChina(html: string, rawNumber: string): CarrierResult {
  const number = normalizeDpexNumber(rawNumber);
  const arrays = ARRAYS.exec(html);
  if (!arrays) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DPEX China answered with a block page');
    throw new SchemaError(PROVIDER, 'DPEX China did not return its trace-and-track page');
  }
  const [tracks, cards, places] = [json(arrays[1]!), json(arrays[2]!), json(arrays[3]!)];
  if (!Array.isArray(tracks) || tracks.length !== 1 || !Array.isArray(tracks[0]) || !Array.isArray(cards) || cards.length !== 1
    || !Array.isArray(places) || !Array.isArray(places[0])) {
    throw new SchemaError(PROVIDER, 'DPEX China returned a page for another request');
  }
  const card = cards[0] as Record<string, unknown> | null;
  if (normalizeTrackingNumber(text(card?.trackingNo)) !== number) throw new IndeterminateError(PROVIDER, 'DPEX China answered for another shipment');
  const rows = tracks[0] as unknown[];
  const names = places[0] as unknown[];
  if (rows.length === 1 && Array.isArray(rows[0]) && rows[0][0] === NO_TRACK) throw new NotFoundError(PROVIDER);
  if (!rows.length || rows.length > MAX_ROWS || names.length !== rows.length
    || !rows.every((row): row is Row => Array.isArray(row) && row.length >= 2
      && typeof row[0] === 'object' && row[0] !== null && typeof row[1] === 'object' && row[1] !== null)) {
    throw new SchemaError(PROVIDER, 'DPEX China returned a history it does not render');
  }
  if (rows.some(([track]) => normalizeTrackingNumber(text(track.TrackConnote)) !== number)) {
    throw new IndeterminateError(PROVIDER, 'DPEX China answered for another shipment');
  }
  // Oldest first on the page; newest first here, the page's order kept for scans of the same minute.
  const events = rows.map((row, index) => scanOf(row, names[index])).reverse();
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The card names the destination country when the system has it, "N/A" otherwise.
  const country = countryCode(card?.destination);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
