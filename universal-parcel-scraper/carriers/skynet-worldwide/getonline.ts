/**
 * Frontier Force's GETOnline tracker, which couriers such as SkyNet Worldwide
 * Express, Airpak Express and RR Express run under their own member id,
 * `stid`. The id picks the member's records as well as its branding: another
 * member's id does not find its shipments. `go/plm-tracking?stid=&cn=` is the
 * page for one number, which the server writes into the page's script. Each
 * courier keeps its id, host, number shape and status map; this module holds
 * the request and the parser they share.
 */
import { DateTime } from 'luxon';
import type { TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { countryCode, countryTimeZone, firstOccurrence, regionHasTown } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, textFromHtml, userAgentOf } from '../../core/transport/index.js';

/** One courier's membership of the tracker. */
export interface GetOnlineMember {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The short name their messages use. */
  readonly name: string;
  /** The member id: the tracker answers from this member's records only. */
  readonly stid: string;
  /** The member's tracking page, `…/go/plm-tracking`. */
  readonly tracker: string;
  /** The whole number the member issues, or an `InvalidInputError`. */
  readonly normalize: (raw: string) => string;
  /** A scan's stage from its event number and wording, or null. */
  readonly stage: (code: string, wording: string) => ClassifiedWording | null;
}

// A long history is under 200 kB; the page carries its styles and scripts inline.
export const GETONLINE_MAX_BYTES = 2_000_000;
const MAX_ROWS = 500;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the tracker answers unknown numbers on its page.
const GONE = [404, 410];

// A double-quoted JavaScript string, as the page writes each value into its script.
const LITERAL = String.raw`"((?:[^"\\\r\n]|\\.)*)"`;
// The function the server writes the history into, up to the next function.
const TRACKER = /function js_getTrack\(\)\s*\{([\s\S]*?)(?=\n\s*function \w+\s*\(|$)/;
// The tracker's own answer for a number it holds nothing for.
const NO_TRACKING = '$(".no-trackingstatus").show();';
// The panel the page shows over a shipment's history.
const SHIPMENT = '$(".trackingstatus-connote").show();';
// Each scan opens by writing the shipment's number into the page's heading.
const SHIPMENT_NUMBER = new RegExp(String.raw`\$\("\.cn"\)\.html\(${LITERAL}\);`, 'g');
const DESTINATION = new RegExp(String.raw`\$\("\.destination"\)\.html\(${LITERAL}\);`);
const WORDING = new RegExp(String.raw`langtag="event_'\s*\+\s*(\d{1,6})\s*\+\s*'">'\s*\+\s*${LITERAL}\s*\+\s*'</span>'`);
const LOCATION = new RegExp(String.raw`var TrackingLocation = ${LITERAL};`);
// A second part the page appends to the location when it has one.
const LOCATION_DETAIL = new RegExp(String.raw`TrackingLocation \+= " - " \+ ${LITERAL};`);
const DATE = /<span class="text14 t-faded-1">(\d{2} [A-Z][a-z]{2} \d{4})<\/span>/;
const CLOCK = /<span class="text14 t-faded-1 event-time">((?:0\d|1[0-2]):[0-5]\d [AP]M)<\/span>/;
// The page's own rewrite of a location such as "Lagos Others - NIGERIA" to the country alone.
const OTHERS = /(.*?) Other[s]? - (.*)/i;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected/i;
// Island groups an hour behind their mainland, which a location files under the country.
const ISLANDS: Readonly<Record<string, { group: string; zone: string }>> = {
  'Europe/Madrid': { group: 'ES-CN', zone: 'Atlantic/Canary' },
  'Europe/Lisbon': { group: 'PT-20', zone: 'Atlantic/Azores' },
};

/** The text of a JavaScript string literal's body. */
function literal(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, escape: string) =>
    escape.length > 1 ? String.fromCharCode(Number.parseInt(escape.slice(1), 16)) : ({ n: ' ', r: ' ', t: ' ' } as Record<string, string>)[escape] ?? escape);
}

/**
 * The zone of a scan's location, "CITY - COUNTRY" or a country alone, when the
 * country keeps one clock: Spain and Portugal take their mainland's, except for
 * a town of the Canary Islands or the Azores. Null for any other country.
 */
export function getOnlineScanZone(location: string): string | null {
  const parts = location.split(' - ').map((part) => part.trim()).filter(Boolean);
  const zone = parts.length ? countryTimeZone(parts.at(-1)) : null;
  const islands = zone ? ISLANDS[zone] : undefined;
  return islands && parts.length > 1 && regionHasTown(islands.group, parts[0]!) ? islands.zone : zone;
}

/**
 * A scan's clock: the day ("16 Oct 2026") and 12-hour time ("11:32 AM") of the
 * scanning station's wall clock, with no zone. It is dated in the zone of a
 * country with one clock, and kept as a wall clock anywhere else.
 */
function scanClock(date: string, time: string, zoneOf: string, member: GetOnlineMember): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const wall = DateTime.fromFormat(`${date} ${time}`, 'dd MMM yyyy hh:mm a', { zone: 'UTC', locale: 'en-US' });
  if (!wall.isValid) throw new SchemaError(member.provider, `${member.name} returned an invalid scan time`);
  const local = wall.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const zone = getOnlineScanZone(zoneOf);
  const instant = zone ? firstOccurrence(DateTime.fromISO(local, { zone })) : null;
  // A wall clock the zone skips when its clocks go forward stays as it was written.
  return instant?.isValid && instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local
    ? { time: instant.toISO({ suppressMilliseconds: true }) } : { local_time: local };
}

/** One scan, from the script between one heading write and the next. */
function scanOf(segment: string, member: GetOnlineMember): CarrierEvent {
  const worded = WORDING.exec(segment);
  const date = DATE.exec(segment)?.[1];
  const time = CLOCK.exec(segment)?.[1];
  if (!worded || !date || !time) throw new SchemaError(member.provider, `${member.name} returned a scan it does not render`);
  const code = worded[1]!;
  const description = textFromHtml(literal(worded[2]!), 300);
  if (!description) throw new SchemaError(member.provider, `${member.name} returned a scan without wording`);
  const place = textFromHtml(literal(LOCATION.exec(segment)?.[1] ?? ''), 120);
  const detail = textFromHtml(literal(LOCATION_DETAIL.exec(segment)?.[1] ?? ''), 120);
  const located = place && detail ? `${place} - ${detail}` : place;
  const others = OTHERS.exec(located);
  const location = others ? clean(others[2]) : located;
  const staged = member.stage(code, description);
  return {
    ...scanClock(date, time, place, member),
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The country at the end of the shipment's destination, "MISSISSAUGA CANADA"; the town is not kept. */
function destinationCountry(script: string): string | null {
  const words = textFromHtml(literal(DESTINATION.exec(script)?.[1] ?? ''), 120).split(' ');
  for (let count = Math.min(4, words.length); count > 0; count--) {
    const code = countryCode(words.slice(-count).join(' '));
    if (code) return code;
  }
  return null;
}

/**
 * The member's page for one number, `go/plm-tracking?stid=&cn=`. The server
 * writes the history into the page's script: for each scan the shipment's
 * number, the event's wording and number, its location and its clock, newest
 * first. Each scan must name the number asked. A number the tracker holds
 * nothing for comes back with its "no tracking" notice.
 */
export function parseGetOnline(html: string, rawNumber: string, member: GetOnlineMember): CarrierResult {
  const number = member.normalize(rawNumber);
  const script = TRACKER.exec(html)?.[1];
  if (script === undefined) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(member.provider, `${member.name} answered with a block page`);
    throw new SchemaError(member.provider, `${member.name} did not return its tracking page`);
  }
  const heads = [...script.matchAll(SHIPMENT_NUMBER)];
  if (!heads.length) {
    if (script.includes(NO_TRACKING)) throw new NotFoundError(member.provider);
    if (script.includes(SHIPMENT)) throw new NoHistoryError(member.provider);
    throw new SchemaError(member.provider, `${member.name} returned a page without an answer`);
  }
  if (script.includes(NO_TRACKING)) throw new SchemaError(member.provider, `${member.name} returned scans with its no-tracking notice`);
  if (heads.length > MAX_ROWS) throw new SchemaError(member.provider, `${member.name} returned an oversized history`);
  if (heads.some((head) => normalizeTrackingNumber(literal(head[1]!)).toUpperCase() !== number)) {
    throw new IndeterminateError(member.provider, `${member.name} answered for another shipment`);
  }
  const events = heads.map((head, index) => scanOf(script.slice(head.index, heads[index + 1]?.index), member));
  const newest = events[0]!;
  // A notice has no stage; the newest scan with one sets the parcel's.
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const country = destinationCountry(script);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}

/** One member's lookup: one `GET` of its page for the whole number, sent once more after a network failure. */
export class GetOnlineTracker {
  constructor(
    private readonly member: GetOnlineMember,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {},
  ) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { member } = this;
    const number = member.normalize(raw);
    const url = `${member.tracker}?${new URLSearchParams({ stid: member.stid, cn: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: member.provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GETONLINE_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      // The page sends a request without its member id or number back to the search form.
      if (REDIRECTS.includes(response.status)) throw new TransportError(member.provider, `${member.name} sent the lookup to another page`, { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(member.provider, `The ${member.name} tracker is unavailable`, { status: response.status });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(member.provider, `${member.name} returned an empty page`);
      return parseGetOnline(html, number, member);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: member.carrier, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}
