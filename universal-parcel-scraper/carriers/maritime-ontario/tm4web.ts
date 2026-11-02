/**
 * TM4Web, the customer portal of Trimble's TruckMate, which freight carriers
 * such as Groupe Guilbault and Maritime-Ontario run on `*.tmwcloud.com` or a
 * host of their own. Its external trace, `trace/external.msw`, is a form with
 * one field per trace type; it posts every type with its value, empty but for
 * the one filled in, to the bill viewer, `trace/external_bill_viewer.msw`,
 * which opens an anonymous session and writes them into its page. The viewer
 * takes them in its address too. The page's script then asks
 * `trace/bill_details_ajax.msw` for `func=ExternalTrace` with the same values,
 * which answers with the bill's `DETAIL_LINE_ID`, the matches it found or
 * `NO_RESULTS`, and for `func=BillDetails` with that id: the order, `TLORDER`,
 * and its status history, `ODRSTAT`. The trace answers `NO_RESULTS` for a bill
 * it holds when the request leaves out any of the form's types. Each carrier
 * keeps its host, trace types, number shape and status map; this module holds
 * the requests and the parser they share.
 */
import { DateTime } from 'luxon';
import type { TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { cleanScalar, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

/** One carrier's TM4Web trace. */
export interface TM4WebSite {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The short name their messages use. */
  readonly name: string;
  /** The portal's origin, as `https://grguweb.tmwcloud.com`. */
  readonly origin: string;
  /** The external trace's type for the carrier's own number, as `~PTLORDER`. */
  readonly traceType: string;
  /** Every type of the trace form, in its order, `traceType` among them. */
  readonly traceTypes: readonly string[];
  /** The whole number the carrier issues, or an `InvalidInputError`. */
  readonly normalize: (raw: string) => string;
  /** A status code's stage, or null. */
  readonly stage: (code: string) => ClassifiedWording | null;
}

// A bill's details are a few kilobytes; the viewer page is about ten.
export const TM4WEB_MAX_BYTES = 1024 * 1024;
const MAX_MATCHES = 1000;
const MAX_ROWS = 500;
const MAX_COOKIES = 8;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const FINAL = new Set<Stage>(['delivered', 'returned']);
// TruckMate's detail line id, the key the viewer opens a bill by.
const LINE_ID = /^\d{1,12}$/;
// "2026-03-05 14:40:00", or with a 12-hour clock, "2026-03-05 02:40:00 PM", as the page's script reads them.
// A database's fraction of a second, or a "T" in place of the space, is taken too; a zone is not.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(?: ?([AP])M)?$/i;
const COOKIE = /^([A-Za-z0-9_.-]{1,64})=([^;\s]{0,512})/;
// A firewall or bot check's page in place of the trace's reply, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|Microsoft-Azure-Application-Gateway|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;

/** The trace form's fields, in its order: each type with the number under the carrier's own and the others empty. */
function tm4webForm(site: TM4WebSite, number: string): [string, string][] {
  return site.traceTypes.flatMap((type): [string, string][] => [['trace_type[]', type], ['search_value[]', type === site.traceType ? number : '']]);
}

/** The bill viewer's address for a number: the page the trace form opens, which takes the form's fields in its address too. */
export function tm4webViewerUrl(site: TM4WebSite, number: string): string {
  const query = tm4webForm(site, number).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  return `${site.origin}/trace/external_bill_viewer.msw?${query}`;
}

/** A wall clock without a zone, "2026-03-05T14:40:00", when the calendar has it; null otherwise. */
function wallClock(value: unknown): string | null {
  const match = CLOCK.exec(cleanScalar(value, 40));
  if (!match) return null;
  let hour = Number(match[2]);
  if (match[5]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (match[5].toUpperCase() === 'P' ? 12 : 0);
  }
  const local = `${match[1]}T${String(hour).padStart(2, '0')}:${match[3]}:${match[4] ?? '00'}`;
  // Parsing in UTC checks the calendar fields only; the wall clock keeps no offset.
  return DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") === local ? local : null;
}

/** The day of a clock or of a bare date, when the calendar has it. */
function dayOf(value: unknown): string | null {
  const day = cleanScalar(value, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
  return wallClock(day)?.slice(0, 10) ?? null;
}

const json = (body: string, site: TM4WebSite): unknown => {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(site.provider, `${site.name} answered with a block page`, { cause });
    throw new SchemaError(site.provider, `${site.name} returned a trace reply that is not JSON`, { cause });
  }
};

const lineIdOf = (value: unknown): string | null => {
  const id = cleanScalar(value, 16);
  return LINE_ID.test(id) ? id : null;
};

const billNumberOf = (value: unknown): string => normalizeTrackingNumber(cleanScalar(value, 64));

/**
 * The bill `func=ExternalTrace` found for the number, by its detail line id.
 * Read in the order the page's script reads the reply: the bill's id, then a
 * request for more criteria, the matches, and `NO_RESULTS`, the trace's own
 * answer for a number it does not hold. Of several matches, only one whose
 * bill number is the whole number asked is taken.
 */
export function readTM4WebTrace(reply: unknown, rawNumber: string, site: TM4WebSite): string {
  const number = site.normalize(rawNumber);
  if (!isRecord(reply)) throw new SchemaError(site.provider, `${site.name} returned an invalid trace reply`);
  if (Object.hasOwn(reply, 'DETAIL_LINE_ID')) {
    const id = lineIdOf(reply.DETAIL_LINE_ID);
    if (!id) throw new SchemaError(site.provider, `${site.name} returned an invalid bill id`);
    return id;
  }
  if (Object.hasOwn(reply, 'REQUIRE_DISAMBIGUATION')) {
    throw new IndeterminateError(site.provider, `${site.name} found several shipments for the number`, { reason: 'several_parcels' });
  }
  if (Object.hasOwn(reply, 'MULTIPLE_RESULTS')) {
    const matches = reply.traceResults;
    if (!Array.isArray(matches) || matches.length > MAX_MATCHES) throw new SchemaError(site.provider, `${site.name} returned an invalid list of matches`);
    const own = matches.filter((match) => isRecord(match) && billNumberOf(match.BILL_NUMBER) === number);
    const id = own.length === 1 ? lineIdOf((own[0] as Record<string, unknown>).DETAIL_LINE_ID) : null;
    if (!id) throw new IndeterminateError(site.provider, `${site.name} found several shipments for the number`, { reason: 'several_parcels' });
    return id;
  }
  if (reply.NO_RESULTS === true) throw new NotFoundError(site.provider);
  throw new SchemaError(site.provider, `${site.name} returned a trace reply without an answer`);
}

/**
 * The status history, newest first: each row's code, its wording and its wall
 * clock. Rows the reply repeats are kept once.
 */
function historyOf(rows: unknown, site: TM4WebSite): CarrierEvent[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(site.provider, `${site.name} returned an invalid status history`);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(site.provider, `${site.name} returned an invalid status`);
    const code = cleanScalar(row.OS_STATUS_CODE, 40);
    const local = wallClock(row.OS_CHANGED);
    if (!code || !local) throw new SchemaError(site.provider, `${site.name} returned a status without its code or time`);
    const key = `${local}\n${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = site.stage(code);
    // A carrier that shows the status's description has it in the row; a history that shows the code alone has it as its wording.
    const description = cleanScalar(row.S_SHORT_DESCRIPTION, 200) || code;
    events.push({ local_time: local, description, provider_code: code, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // The history comes newest first; a reply oldest first is turned around so equal clocks keep their order.
  if (events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time!) events.reverse();
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const a = left.event.local_time!;
      const b = right.event.local_time!;
      return a < b ? 1 : a > b ? -1 : left.index - right.index;
    })
    .map(({ event }) => event);
}

/** The scheduled delivery, `DELIVER_BY` to `DELIVER_BY_END`, as days; nothing once the shipment arrived. */
function estimateOf(order: Record<string, unknown>, stage: Stage | undefined): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  if (stage && FINAL.has(stage)) return { expected_delivery: null };
  const from = dayOf(order.DELIVER_BY);
  const to = dayOf(order.DELIVER_BY_END);
  const last = to && (!from || to >= from) ? to : from;
  if (!last) return { expected_delivery: null };
  return { expected_delivery: last, ...(from && from < last ? { expected_delivery_from: from } : {}) };
}

/**
 * The reply of `func=BillDetails`: `TLORDER`, the order, and `ODRSTAT`, its
 * status history, among the sections the carrier shows. The order's bill
 * number must be the whole number asked. The parser reads the status codes
 * with their clocks, the order's current status when the carrier shows it and
 * the scheduled delivery; the parties' names and addresses, the person who
 * signed, the trace numbers and the freight details are not kept.
 */
export function parseTM4WebBill(reply: unknown, rawNumber: string, site: TM4WebSite): CarrierResult {
  const number = site.normalize(rawNumber);
  if (!isRecord(reply) || !isRecord(reply.TLORDER)) throw new SchemaError(site.provider, `${site.name} returned a bill without its order`);
  const order = reply.TLORDER;
  const bill = billNumberOf(order.BILL_NUMBER);
  if (!bill) throw new SchemaError(site.provider, `${site.name} returned a bill without its number`);
  if (bill !== number) throw new IndeterminateError(site.provider, `${site.name} answered for another shipment`);

  const events = historyOf(reply.ODRSTAT, site);
  const current = cleanScalar(order.CURRENT_STATUS, 40);
  const summary = current ? site.stage(current) : null;
  const scanned = events.find((event) => event.stage);
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const source = summary?.source ?? scanned?.stage_source;
  if (!events.length && !summary) throw new NoHistoryError(site.provider);
  const newest = events[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest?.description ?? current,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : { provider_code: current, summary_only: true }),
    ...estimateOf(order, stage),
    events,
  };
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

/**
 * One carrier's lookup: the trace form's post to the bill viewer, which opens
 * the session, then the trace and the bill's details in it, the way the
 * viewer's script asks for them. The whole sequence runs once more, in a new
 * session, after a network failure.
 */
export class TM4WebTracker {
  constructor(
    private readonly site: TM4WebSite,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {},
  ) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { site } = this;
    const viewer = `${site.origin}/trace/external_bill_viewer.msw`;
    const ajax = `${site.origin}/trace/bill_details_ajax.msw`;
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const cookies = new Map<string, string>();
    const keep = (response: Response) => {
      for (const header of response.headers.getSetCookie()) {
        const cookie = COOKIE.exec(header);
        if (cookie && (cookies.has(cookie[1]!) || cookies.size < MAX_COOKIES)) cookies.set(cookie[1]!, cookie[2]!);
      }
    };
    const request = async (url: string, init: RequestInit, what: string) => {
      const { response, bytes } = await fetchBounded(url, { ...init, signal }, { provider: site.provider, timeoutMs: left(), maxBytes: TM4WEB_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (response.status === 403) throw new ChallengeError(site.provider, `${site.name} refused the ${what}`, { status: 403 });
      if (GONE.includes(response.status)) throw new TransportError(site.provider, `${site.name}'s ${what} is unavailable`, { status: response.status });
      keep(response);
      return { response, body: decodeText(bytes) };
    };
    const ask = async (query: [string, string][], what: string): Promise<unknown> => {
      const { response, body } = await request(`${ajax}?${new URLSearchParams(query)}`, { method: 'GET', headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: viewer,
        'User-Agent': userAgentOf(this.options.userAgent), Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      } }, what);
      // The portal sends a request outside a trace session to its home page.
      if (REDIRECTS.includes(response.status)) {
        throw new IndeterminateError(site.provider, `${site.name} did not accept the trace session`, { reason: 'session_rejected' });
      }
      return json(body, site);
    };
    try {
      // The trace form's post: every type, with the number under the carrier's own.
      const opened = await request(viewer, { method: 'POST', headers: {
        Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${site.origin}/trace/external.msw`, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams(tm4webForm(site, number)).toString() }, 'bill viewer');
      if (REDIRECTS.includes(opened.response.status)) throw new TransportError(site.provider, `${site.name} moved its bill viewer`, { status: opened.response.status });
      if (!opened.body.includes('trace_values')) {
        if (BLOCKED.test(opened.body.slice(0, 64_000))) throw new ChallengeError(site.provider, `${site.name} answered with a block page`);
        throw new SchemaError(site.provider, `${site.name} did not open its bill viewer`);
      }
      if (!cookies.size) throw new IndeterminateError(site.provider, `${site.name} did not open a trace session`, { reason: 'session_rejected' });
      signal.throwIfAborted();
      // The script sends the page's values back as jQuery lists them: the types, then the values.
      const form = tm4webForm(site, number);
      const trace = await ask([...form.filter(([name]) => name === 'trace_type[]'), ...form.filter(([name]) => name === 'search_value[]'),
        ['func', 'ExternalTrace']], 'trace');
      const id = readTM4WebTrace(trace, number, site);
      signal.throwIfAborted();
      return parseTM4WebBill(await ask([['func', 'BillDetails'], ['dld', id]], 'bill details'), number, site);
    } catch (error) {
      throw withoutSession(error);
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = this.site.normalize(raw);
    // A lookup that fails to reach the portal, or hangs, is asked once more in
    // a new session: the first try gets half of the budget. An HTTP status or
    // a reply is never sent again.
    return runSteps({ carrier: this.site.carrier, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}
