import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { DateTime } from 'luxon';
import { CarrierError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { EXPLICIT_OFFSET_PATTERN } from '../../core/time/index.js';
import { cleanScalar, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { classifyScan, classifyStatus, milestoneNumberStatus, scanSite } from './status.js';

export const MONDIAL_RELAY_APP_API = 'https://mobile-app-bff.mondialrelay.app/api/';
const TOKEN_URL = 'https://account.inpost-group.com/oauth2/token';
const CLIENT_ID = 'mondialrelay-mobile';
// Shared request-signing secret of the public app, distributed with the maintainer's approval.
const SIGNING_SECRET = 'VCzt4PzS8ynJE2yy7zNBiQbTE3pkncqEyvrUsCDbXupGn8yqRrPDov2FYiAVfuUx';
const MAX_BYTES = 2_000_000;
/** An access token this close to its stated expiry is renewed first. */
const EXPIRY_MARGIN_MS = 60_000;
const ZONE = 'Europe/Paris';

/**
 * The backend's bot screen refuses Node's built-in fetch, which offers
 * HTTP/2, and answers the same request over plain HTTP/1.1.
 */
export const http1Fetch: typeof fetch = (input, init = {}) => new Promise<Response>((resolve, reject) => {
  const url = input instanceof Request ? input.url : String(input);
  const sent = init.body ?? undefined;
  if (sent !== undefined && typeof sent !== 'string' && !(sent instanceof URLSearchParams)) throw new TypeError('Only text bodies are sent');
  const body = sent?.toString();
  const headers = Object.fromEntries(new Headers(init.headers));
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const outgoing = request(url, { method: init.method ?? 'GET', headers, signal: init.signal ?? undefined }, (incoming) => {
    const status = incoming.statusCode ?? 0;
    const replied = new Headers();
    for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) replied.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
    try {
      const stream = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(stream, { status, statusText: incoming.statusMessage, headers: replied }));
    } catch (error) {
      incoming.destroy();
      reject(error);
    }
  });
  outgoing.on('error', reject);
  outgoing.end(body);
});

/** A normalized credential: 8, 10 or 12 digits, or a barcode's 12-digit alias, and the postcode an 8-digit one needs. */
export interface MondialRelayAppQuery {
  shipment: string;
  postcode: string;
}

function invalid(message = 'Mondial Relay app returned invalid tracking data'): never {
  throw new SchemaError('Mondial Relay', message);
}

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeText(bytes));
  } catch {
    return invalid();
  }
}

/** The app sends UTC instants; they are shown on Paris clocks, as the website does. */
function eventTime(value: unknown): { iso: string; timestamp: number } | null {
  const raw = cleanScalar(value, 64);
  if (!EXPLICIT_OFFSET_PATTERN.test(raw)) return null;
  const parsed = DateTime.fromISO(raw, { setZone: true }).setZone(ZONE);
  const iso = parsed.isValid ? parsed.toISO({ suppressMilliseconds: true }) : null;
  return iso ? { iso, timestamp: parsed.toMillis() } : null;
}

/** The highest milestone with a date: its wording, else its position on the app's rail. */
function milestoneStatus(steps: readonly JsonObject[]): ClassifiedStatus | null {
  const reached = steps
    .filter((step) => eventTime(step.date) && Number.isFinite(Number(step.number)))
    .sort((left, right) => Number(right.number) - Number(left.number))[0];
  if (!reached) return null;
  const worded = classifyStatus(cleanScalar(reached.status, 200));
  return worded.status !== 'unknown' ? worded : milestoneNumberStatus(Number(reached.number));
}

/** The instants of the reached milestones whose label reads out for delivery. */
function outForDeliveryInstants(steps: readonly JsonObject[]): Set<number> {
  const instants = new Set<number>();
  for (const step of steps) {
    const time = eventTime(step.date);
    if (time && classifyStatus(cleanScalar(step.status, 200)).stage === 'out_for_delivery') instants.add(time.timestamp);
  }
  return instants;
}

/**
 * The relay or locker the detail names as the parcel's delivery point, as the
 * app shows it: `line1` is its name, the other lines and the town its address.
 * Its opening hours, coordinates and photo are not read.
 */
function deliveryPoint(detail: JsonObject): string {
  const address = isRecord(detail.deliveryPointModel) ? detail.deliveryPointModel.address : undefined;
  if (!isRecord(address)) return '';
  const name = cleanScalar(address.line1, 120);
  if (!/\p{L}/u.test(name)) return '';
  const streets = [address.line2, address.line3, address.line4].map((line) => cleanScalar(line, 120)).filter(Boolean);
  const city = cleanScalar(address.city, 80);
  return streets.length && city
    ? [name, ...streets, [cleanScalar(address.postcode, 16), city].filter(Boolean).join(' ')].join('\n')
    : name;
}

/**
 * The app's parcel detail: a headline, milestones and their dated events, and
 * the delivery point. It carries no delivery estimate, and its pickup code,
 * barcode and contact fields are never read.
 */
export function parseMondialRelayApp(payload: unknown, uid: string): CarrierResult {
  if (!Array.isArray(payload)) invalid();
  const parcel = payload.find((entry): entry is JsonObject => isRecord(entry) && isRecord(entry.expedition)
    && cleanScalar(entry.expedition.shipmentUid, 16) === uid);
  if (!parcel) invalid('Mondial Relay returned a different shipment');
  const expedition = parcel.expedition as JsonObject;
  if (!isRecord(parcel.detail) || !Array.isArray(parcel.detail.steps)) invalid();
  const steps = parcel.detail.steps.filter(isRecord);
  const parsed: Array<{ event: CarrierEvent; classified: ClassifiedStatus; timestamp: number }> = [];
  const seen = new Set<string>();
  const outForDelivery = outForDeliveryInstants(steps);
  for (const step of steps) {
    for (const raw of Array.isArray(step.events) ? step.events : []) {
      if (!isRecord(raw)) continue;
      const time = eventTime(raw.date);
      const description = cleanScalar(raw.label, 500);
      if (!time || !description) continue;
      const identity = JSON.stringify([time.iso, description]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const classified = classifyScan(description, time.timestamp, outForDelivery);
      parsed.push({ event: { time: time.iso, location: scanSite(description), description, stage: classified.stage }, classified, timestamp: time.timestamp });
    }
  }
  parsed.sort((left, right) => right.timestamp - left.timestamp);
  const events = parsed.slice(0, 100).map(({ event }) => event);
  const hint = cleanScalar(expedition.stepHint, 200);
  const hinted = classifyStatus(hint);
  const current = hinted.status !== 'unknown'
    ? hinted
    : parsed.find(({ classified }) => classified.status !== 'unknown')?.classified ?? milestoneStatus(steps);
  if (!events.length && !current) throw new IndeterminateError('Mondial Relay', 'Mondial Relay app returned no shipment activity');
  // The delivery point, while the parcel waits there.
  const pickup = current?.stage === 'ready_for_pickup' ? deliveryPoint(parcel.detail) : '';
  // As on the website, a delivered parcel takes its delivery scan's clock.
  const deliveredAt = current?.status === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: current?.status ?? 'unknown',
    ...(current ? { current_stage: current.stage } : {}),
    last_status_text: hint || events[0]?.description || 'Tracking information received',
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    timezone: ZONE,
    events,
    source: 'mondial_relay_app',
  };
}

/**
 * The consumer app's backend, signed in as one InPost account. Searching
 * needs no link between that account and the parcel. Requests carry the
 * app's shared signature; the account's refresh token renews a two-hour
 * access token, kept per client.
 */
export class MondialRelayAppClient {
  readonly #refreshToken: string;
  readonly #fetcher: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  #access: { token: string; expiresAt: number } | null = null;
  #renewing: Promise<string> | null = null;

  constructor(options: { refreshToken: string; fetcher?: typeof fetch; userAgent?: string; now?: () => number }) {
    this.#refreshToken = options.refreshToken.trim();
    if (!this.#refreshToken) throw new TypeError('Mondial Relay app tracking needs a refresh token');
    this.#fetcher = options.fetcher ?? http1Fetch;
    this.#userAgent = userAgentOf(options.userAgent);
    this.#now = options.now ?? Date.now;
  }

  /**
   * One parcel, found by its shipment and the recipient postcode, or by a
   * barcode's brand and shipment alone. A search that does not single out the
   * parcel is inconclusive: the website also accepts the sender's postcode.
   */
  async track(query: MondialRelayAppQuery, options: { signal: AbortSignal; timeoutMs: number }): Promise<CarrierResult> {
    const { shipment, postcode } = query;
    if (!/^(?:\d{8}|\d{10}|\d{12})$/.test(shipment)) throw new TypeError('Mondial Relay app tracking takes 8, 10 or 12 digits');
    const deadline = performance.now() + options.timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    try {
      const search = await this.#get('parcels-search', postcode
        ? { shipmentUid: shipment.length === 8 ? shipment : shipment.slice(2, 10), postcode }
        : { shipmentUid: shipment.slice(0, 10) }, options.signal, left);
      if (!isRecord(search) || !Array.isArray(search.list)) invalid();
      const matches = search.list.flatMap((entry) => {
        const uid = isRecord(entry) && isRecord(entry.expedition) ? cleanScalar(entry.expedition.shipmentUid, 16) : '';
        // The 10-digit UID is the brand followed by the shipment.
        return /^\d{10}$/.test(uid) && (shipment.length === 8 ? uid.slice(2) === shipment : uid === shipment.slice(0, 10)) ? [uid] : [];
      });
      const uids = [...new Set(matches)];
      if (uids.length !== 1) throw new IndeterminateError('Mondial Relay', 'Mondial Relay app could not single out the shipment');
      const detail = await this.#get('parcels-detail', { shipmentUids: uids[0]!, parcelType: 'received' }, options.signal, left);
      return parseMondialRelayApp(detail, uids[0]!);
    } catch (error) {
      options.signal.throwIfAborted();
      // Transport diagnostics carry the bearer token and the postcode.
      if (error instanceof CarrierError) throw new CarrierError(error.kind, 'Mondial Relay', `Mondial Relay app tracking failed (${error.kind})`, {
        status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
      });
      throw new TransportError('Mondial Relay', 'Mondial Relay app request failed');
    }
  }

  /** A signed request; a rejected access token is renewed once. */
  async #get(path: string, query: Record<string, string>, signal: AbortSignal, left: () => number): Promise<unknown> {
    const url = new URL(path, MONDIAL_RELAY_APP_API);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.#accessToken(signal, left);
      const nonce = randomUUID();
      const clock = String(Math.floor(this.#now() / 1000));
      const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'fr-FR', 'User-Agent': this.#userAgent, 'X-OriginApp': 'MR',
        'X-MR-Param1': nonce, 'X-MR-Param2': clock, 'X-MR-API-KEY': sha256(sha256(SIGNING_SECRET + nonce + clock)),
        Authorization: `Bearer ${token}`,
      } }, { provider: 'Mondial Relay', maxBytes: MAX_BYTES, timeoutMs: left(), fetcher: this.#fetcher, allowHttpStatuses: [401, 403, 404] });
      if (response.status === 401 && !attempt) {
        if (this.#access?.token === token) this.#access = null;
        continue;
      }
      if ([401, 403].includes(response.status)) throw new ChallengeError('Mondial Relay', 'Mondial Relay refused the app request');
      // A missing parcel is an empty search; a 404 is a moved route.
      if (response.status === 404) throw new TransportError('Mondial Relay', 'Mondial Relay app service is unavailable', { status: 404 });
      if (response.status !== 200) throw new UpstreamHttpError('Mondial Relay', response.status);
      return json(bytes);
    }
  }

  /** The current access token, renewed by one request at a time. */
  async #accessToken(signal: AbortSignal, left: () => number): Promise<string> {
    if (this.#access && this.#access.expiresAt - EXPIRY_MARGIN_MS > this.#now()) return this.#access.token;
    signal.throwIfAborted();
    this.#renewing ??= this.#renew(left()).finally(() => { this.#renewing = null; });
    const renewing = this.#renewing;
    let leave!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      leave = () => reject(signal.reason as Error);
      signal.addEventListener('abort', leave, { once: true });
    });
    try { return await Promise.race([renewing, aborted]); }
    finally { signal.removeEventListener('abort', leave); }
  }

  async #renew(timeoutMs: number): Promise<string> {
    const body = new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: this.#refreshToken });
    const { response, bytes } = await fetchBounded(TOKEN_URL, { method: 'POST', body, headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': this.#userAgent,
    } }, { provider: 'Mondial Relay', maxBytes: 100_000, timeoutMs, fetcher: this.#fetcher, allowHttpStatuses: [400, 401] });
    // An expired or revoked sign-in needs a new one; the website still answers meanwhile.
    if (response.status !== 200) throw new ChallengeError('Mondial Relay', 'Mondial Relay refused the account token');
    const reply = json(bytes);
    if (!isRecord(reply)) invalid();
    const token = cleanScalar(reply.access_token, 8_192);
    const lifetime = Number(reply.expires_in);
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || !Number.isFinite(lifetime) || lifetime <= 0) invalid();
    this.#access = { token, expiresAt: this.#now() + lifetime * 1000 };
    return token;
  }
}
