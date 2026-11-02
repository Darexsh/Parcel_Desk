/**
 * The ControlBox courier platform, on which Vimenpaq runs as a tenant. Each
 * tenant has a customer API, and the tracking page its app opens asks it for
 * one guide: `POST <api>/Consultas/RastreoGuia?tracking=<number>`, answered in
 * JSON. A tenant keeps its own API address, name and status map; this module
 * holds the request and the parser they share.
 */
import { DateTime } from 'luxon';
import type { TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

/** One carrier's tenant on the platform. */
export interface ControlboxTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The tenant's customer API, ending in `/api`. */
  readonly api: string;
  /** A row's stage from its status wording, or null when the wording moves nothing the map or the shared rules know. */
  readonly stage: (wording: string) => ClassifiedWording | null;
}

export const CONTROLBOX_TRACK_PATH = '/Consultas/RastreoGuia';
// An empty guide is about a kilobyte; a long history a few dozen.
const MAX_BYTES = 512 * 1024;
// Letters and digits with at least one digit; short references are never sent.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// The API's clocks: a wall clock with optional fractions and no offset, as .NET writes an unzoned date.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|g-recaptcha|h-captcha|_Incapsula_Resource|AwsWafIntegration/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A guide, tracking or warehouse receipt number for a ControlBox tracker, in capitals; anything else is never sent. */
export function normalizeControlboxNumber(raw: string, provider: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} numbers are 8 to 30 letters and digits, with a digit`);
  return number;
}

/** The address of the guide lookup for one number. */
export function controlboxTrackUrl(tenant: ControlboxTenant, raw: string): string {
  const url = new URL(`${tenant.api.replace(/\/+$/, '')}${CONTROLBOX_TRACK_PATH}`);
  url.searchParams.set('tracking', normalizeControlboxNumber(raw, tenant.provider));
  return url.toString();
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: Record<string, unknown>, key: string, provider: string, maxLength = 300): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A row's wall clock to the second. The reply names no zone, so it stays local. */
function wallClock(value: string, provider: string): string {
  const local = CLOCK.exec(value)?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  // .NET writes an empty date as year one; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.year < 2000 || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  return local;
}

/**
 * The reply of `Consultas/RastreoGuia` for one number. It is the guide's
 * record: its number, the tracking number it may hold, its receipt date,
 * weight and pieces, fields for the sender, the recipient and the charges,
 * and the `Status` rows newest first, each with `CreatedDate`,
 * `StatusDescription` and a free-text `Comment`, padded with spaces. A number
 * the tenant does not know comes back as the same record left empty, with no
 * guide number and no rows. A guide counts only when its own number or the
 * tracking number it holds is the whole number asked. Only the rows' clocks
 * and wording are read: the comments can name who collected a parcel, and at
 * times the person a parcel waits for.
 */
export function parseControlboxGuide(payload: unknown, raw: string, tenant: ControlboxTenant): CarrierResult {
  const { provider } = tenant;
  const number = normalizeControlboxNumber(raw, provider);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'NumeroGuia') || !Object.hasOwn(payload, 'Status')) {
    throw new SchemaError(provider, `${provider} returned an invalid guide`);
  }
  const rows = payload.Status ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(provider, `${provider} returned a guide with invalid statuses`);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  const guide = text(payload, 'NumeroGuia', provider, 64);
  if (!guide) {
    if (rows.length) throw new SchemaError(provider, `${provider} returned statuses without their guide`);
    throw new NotFoundError(provider);
  }
  const asked = (value: string) => value !== '' && normalizeTrackingNumber(value) === number;
  if (!asked(guide) && !asked(text(payload, 'Tracking', provider, 64))) {
    throw new IndeterminateError(provider, `${provider} answered for another shipment`);
  }

  const scans = rows.map((row, index) => {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid status`);
    const description = text(row, 'StatusDescription', provider, 200);
    if (!description) throw new SchemaError(provider, `${provider} returned a status without wording`);
    const local = wallClock(text(row, 'CreatedDate', provider, 40), provider);
    const staged = tenant.stage(description);
    const event: CarrierEvent = {
      local_time: local,
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { event, index, wording: description.toLowerCase(), at: DateTime.fromISO(local, { zone: 'UTC' }).toMillis() };
  });
  if (!scans.length) throw new NoHistoryError(provider);
  // Oldest first by wall clock; rows at one clock keep the reply's order, which lists them newest first.
  scans.sort((a, b) => a.at - b.at || b.index - a.index);
  // Staff often record a status twice in a few seconds: a row repeating the
  // wording kept within the minute before it counts once, at its first clock.
  const events: CarrierEvent[] = [];
  let kept: { at: number; wording: string } | undefined;
  for (const { event, at, wording } of scans) {
    if (kept?.wording === wording && at - kept.at < 60_000) continue;
    events.push(event);
    kept = { at, wording };
  }
  events.reverse();

  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The reply as JSON; a page in its place is a block or a changed route. */
function json(body: string, provider: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

export class ControlboxTracker {
  constructor(private readonly tenant: ControlboxTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { provider } = this.tenant;
    // The page posts an empty JSON string as the body and the number in the query.
    const { response, bytes } = await fetchBounded(controlboxTrackUrl(this.tenant, number), { method: 'POST', signal, headers: {
      Accept: 'application/json, text/javascript, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify('{}') }, { provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(provider, `${provider} redirected its tracking lookup`);
    // An unknown number is HTTP 200: a 404 is a moved route.
    if (GONE.includes(response.status)) throw new TransportError(provider, `${provider} tracking lookup is unavailable`);
    return parseControlboxGuide(json(decodeText(bytes), provider), number, this.tenant);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeControlboxNumber(raw, this.tenant.provider);
    // A request that fails to reach the API, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: this.tenant.carrier, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}
