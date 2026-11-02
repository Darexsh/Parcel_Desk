/**
 * The lookup the tracking pages of J&T's Australian, German and UK networks
 * make on J&T's "official" platform: the same signed request, app id, key and
 * reply, on each network's host. Each network passes its address, country
 * header, waybill layout and status map; `j-and-t-de` and `j-and-t-uk` share
 * this module with `j-and-t-au`.
 */
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { withoutCourtesy } from './identity.js';

export interface JAndTNetwork {
  readonly id: CarrierId;
  readonly provider: string;
  /** The lookup the network's tracking page makes for the waybills typed in. */
  readonly api: string;
  /** The header naming the network's country, as its page sends it. */
  readonly country: Readonly<Record<string, string>>;
  /** The waybill the network prints, in upper case. */
  readonly number: RegExp;
  /** What a waybill of the network is, for a number that is not one. */
  readonly layout: string;
  /** The network's own cleaning of a scan's sentence, before the shared one. */
  readonly wording?: (sentence: string) => string;
  readonly stage: (wording: string) => ClassifiedWording | null;
}

/** The app id and signing key the sites' scripts give every visitor; the pages send the key along as a header too. */
export const J_AND_T_APP_ID = '2BZWAROTK578H7MG9YPWT057NN6IN8T1'; // gitleaks:allow
export const J_AND_T_SIGNING_KEY = 'cteezp48358yyn6t6l9w8wfz2wctuqs7'; // gitleaks:allow
/** The zone the request names, which the reply writes every scan time in: UTC, so each is an instant. */
export const J_AND_T_ZONE = 'GMT+0000';
// A long history is a few kilobytes.
export const J_AND_T_MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|AwsWafIntegration|awswaf\.com/i;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The page reads a reply as an answer only with this code.
const ANSWERED = 1;
// A signature that does not check out, and missing or invalid parameters: the lookup no longer takes the request as sent.
const REFUSED_REQUEST = new Set([999001010, 999001030, 999001031]);
const THROTTLED = /too many|too frequent|frequently|rate limit|请求(?:过于)?频繁|访问(?:过于)?频繁/i;
// Fields that could name the waybill a scan belongs to.
const IDENTITY = ['waybillNo', 'billCode', 'keyword'] as const;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * The page's signature of a request: MD5, in capitals, of the app id, the
 * timestamp, the nonce, the JSON body with its keys sorted and the key.
 */
export function jAndTSignature(timestamp: string, nonce: string, sortedBody: string): string {
  return createHash('md5').update(`${J_AND_T_APP_ID}${timestamp}${nonce}${sortedBody}${J_AND_T_SIGNING_KEY}`).digest('hex').toUpperCase();
}

/** The page's request for one waybill: its body, and its headers signed over the same fields with their keys sorted. */
export function jAndTRequest(network: JAndTNetwork, number: string): { body: string; headers: Record<string, string> } {
  const timestamp = String(Date.now());
  const nonce = String(Math.random());
  return {
    body: JSON.stringify({ waybillNos: [number], langType: 'EN' }),
    headers: {
      langType: 'EN', appId: J_AND_T_APP_ID, timestamp, nonce, ...network.country, key: J_AND_T_SIGNING_KEY,
      sign: jAndTSignature(timestamp, nonce, JSON.stringify({ langType: 'EN', waybillNos: [number] })),
      timezone: J_AND_T_ZONE,
    },
  };
}

/** A waybill for the network's tracker, in upper case as it prints them; anything else is not one it issues. */
export function normalizeJAndTNumber(network: JAndTNetwork, raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!network.number.test(number)) throw new InvalidInputError(network.provider, network.layout);
  return number;
}

// The page sets text in 【】 apart; like square brackets, it can hold a person, a phone or a branch.
const BRACKETED = /【[^】]{0,200}】|\[[^\]]{0,200}\]/gu;
// The customer service line some scans end with: "Customer service: 13 00 00", "客服热线：130000".
const HOTLINE = /\s*(?:customer\s+service(?:\s+(?:hotline|number))?|(?:官网)?客服(?:热线|电话)?)\s*[:：]?\s*\+?\d[\d\s-]*\d/giu;
// Who signed for, received or collected the parcel, to the end of the sentence: "signed for by Sample Person".
const RECEIVER = /\b((?:signed(?:\s+for)?|received|collected)\s+)by\b[^.。;；]*/giu;
const ROLES = 'courier|driver|rider|recipient|receiver|consignee|signer|signatory|sender|contact';
// A role followed by its person, after a colon or in brackets: "Courier: Sample Person", "driver (Sample Person)".
const PERSON = String.raw`(?:\s*[:：][^.。;；,，]*|(?:\s*(?:\([^)]{0,200}\)|（[^）]{0,200}）))+)`;
const NAMED = new RegExp(String.raw`\b(${ROLES})${PERSON}`, 'giu');
const NAMED_ZH = new RegExp(String.raw`(签收人|收件人|寄件人|派件员|快递员|业务员|派送员|收派员|司机|联系人)${PERSON}`, 'gu');
// A role left alone as the last sentence once its person is gone.
const BARE_ROLE = new RegExp(String.raw`(?<=[.。])\s*(?:${ROLES})\s*[.。]?$`, 'iu');
// A run of eight or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){7,}(?![A-Z\d])/giu;

/**
 * A scan's sentence without the people and phones it can name: anything in
 * brackets, the customer service line and the courtesy that offers it, who
 * signed for the parcel, a person after their role, and phone numbers.
 */
export function jAndTWording(sentence: string): string {
  return clean(withoutCourtesy(sentence).replace(BRACKETED, ' ').replace(HOTLINE, '').replace(RECEIVER, '$1').replace(NAMED, '$1')
    .replace(NAMED_ZH, '$1').replace(PHONE, '').replace(/\(\s*\)|（\s*）/gu, '').replace(/\s+([,.;:!?，。；：])/gu, '$1'))
    .replace(/([,;:，；：])(?=[.。])/gu, '').replace(BARE_ROLE, '').replace(/^[\s,;:，；：\-–]+|[\s,;:，；：\-–]+$/gu, '');
}

/** Any waybill a record names must be the one asked. */
function checkIdentity(network: JAndTNetwork, record: Record<string, unknown>, number: string): void {
  for (const key of IDENTITY) {
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') throw new SchemaError(network.provider, `${network.provider} returned an invalid ${key}`);
    // The whole value, normalized: a different waybill's suffix must not be cut off before comparing.
    if (normalizeTrackingNumber(value).toUpperCase() !== number) {
      throw new IndeterminateError(network.provider, `${network.provider} answered for another waybill`);
    }
  }
}

/** A scan's instant: `scanTime`, which the reply writes in the zone the request named, UTC. */
function scanTime(network: JAndTNetwork, row: Record<string, unknown>): string {
  const match = WALL_CLOCK.exec(typeof row.scanTime === 'string' ? row.scanTime.trim() : '');
  const clock = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(clock, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== clock) {
    throw new SchemaError(network.provider, `${network.provider} returned an invalid scan time`);
  }
  return parsed.toISO({ suppressMilliseconds: true });
}

/** One scan: its instant and its sentence. A sentence that named only people or phones is no scan. */
function projectRow(network: JAndTNetwork, row: Record<string, unknown>, number: string): { key: string; event: CarrierEvent } | null {
  checkIdentity(network, row, number);
  if (typeof row.customerTracking !== 'string' || !clean(row.customerTracking)) {
    throw new SchemaError(network.provider, `${network.provider} returned a scan without wording`);
  }
  const time = scanTime(network, row);
  const sentence = clean(row.customerTracking, 1000);
  const description = jAndTWording(network.wording ? network.wording(sentence) : sentence).slice(0, 300);
  if (!description) return null;
  const staged = network.stage(description);
  const event: CarrierEvent = {
    time,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time, description]), event };
}

/** The refusal or failure a reply that is not an answer stands for. */
function failure(network: JAndTNetwork, payload: Record<string, unknown>): Error {
  const message = clean(payload.msg, 200);
  if (THROTTLED.test(message)) return new RateLimitedError(network.provider, undefined, `${network.provider} refused more lookups for now`);
  if (typeof payload.code === 'number' && REFUSED_REQUEST.has(payload.code)) {
    return new SchemaError(network.provider, `${network.provider} refused the lookup’s signature or parameters`);
  }
  return new IndeterminateError(network.provider, `${network.provider} did not complete the lookup`);
}

/**
 * The reply of `getDetailByWaybillNo` for one waybill: code 1 with one answer
 * in `data` per waybill it knows, which names the waybill in `keyword` and
 * lists its scans in `details`. A waybill it does not know is left out, and
 * the page then says it has no tracking records: not found.
 */
export function parseJAndT(network: JAndTNetwork, payload: unknown, raw: string): CarrierResult {
  const { provider } = network;
  const number = normalizeJAndTNumber(network, raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  if (payload.code !== ANSWERED) throw failure(network, payload);
  const answers = payload.data;
  if (!Array.isArray(answers)) throw new SchemaError(provider, `${provider} returned invalid answers`);
  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.keyword !== 'string' || !answer.keyword) {
      throw new SchemaError(provider, `${provider} did not name the waybill it answered for`);
    }
    checkIdentity(network, answer, number);
  }
  if (answers.length > 1) throw new SchemaError(provider, `${provider} returned more than one answer for the waybill`);
  const answer = answers[0] as Record<string, unknown> | undefined;
  if (!answer) throw new NotFoundError(provider);
  const rows = answer.details ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(provider, `${provider} returned invalid scans`);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);

  const seen = new Set<string>();
  const scans: { index: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    const scan = projectRow(network, row, number);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ index: scans.length, event: scan.event });
  }
  // A waybill the tracker knows without a scan has no history.
  if (!scans.length) throw new NoHistoryError(provider);
  // Newest first, as the page sorts them by time; scans at one time keep the reply's order.
  const clock = (event: CarrierEvent) => event.time as string;
  const newestFirst = scans.sort((a, b) => clock(b.event).localeCompare(clock(a.event)) || a.index - b.index).map(({ event }) => event);

  const newest = newestFirst[0]!;
  const staged = newestFirst.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

function json(network: JAndTNetwork, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    // A JSON lookup answering with a page has been turned away.
    if (CHALLENGE.test(body.slice(0, 64_000)) || /^\s*</.test(body)) {
      throw new ChallengeError(network.provider, `${network.provider} answered with a page instead of its lookup`, { cause });
    }
    throw new SchemaError(network.provider, `${network.provider} returned a reply that is not JSON`, { cause });
  }
}

export class JAndTTracker {
  constructor(private readonly network: JAndTNetwork,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { network } = this;
    const number = normalizeJAndTNumber(network, raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // Signed afresh for each try, as the page signs each request.
      const { body, headers } = jAndTRequest(network, number);
      const { response, bytes } = await fetchBounded(network.api, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        ...headers,
      }, body }, { provider: network.provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: J_AND_T_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(network.provider, `${network.provider} redirected its tracking lookup`);
      // The lookup answers every waybill with HTTP 200; a 404 is a moved route, not an unknown parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(network.provider, `${network.provider} tracking lookup is unavailable`);
      return parseJAndT(network, json(network, decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: network.id, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

/** The network's adapter: the lookup, once more after a request that fails to reach the site, and recognition through it. */
export function jAndTAdapter(network: JAndTNetwork): AdapterFactory {
  return (environment) => {
    const tracker = new JAndTTracker(network, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: network.id, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
        () => accepted(() => normalizeJAndTNumber(network, number))),
    };
  };
}
