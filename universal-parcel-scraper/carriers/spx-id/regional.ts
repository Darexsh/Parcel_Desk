/**
 * The order lookup SPX's trackers in Indonesia, Malaysia, Singapore, Thailand
 * and Vietnam make, the same one the Brazilian tracker makes. Each network
 * passes its host, language, number layouts and status map; `spx-my`, `spx-sg`,
 * `spx-th` and `spx-vn` share this module with `spx-id`.
 */
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { isSpxHiddenMilestone, type SpxStatusMap } from './codes.js';

export interface SpxNetwork {
  readonly id: CarrierId;
  readonly provider: string;
  /** The tracker's host. */
  readonly origin: string;
  /** The tracker's own language code for the country. */
  readonly language: string;
  /** SPX's own numbers: SPX, the country and twelve characters. */
  readonly spx: RegExp;
  /** Shopee's logistics numbers in the country, which a marketplace parcel's SPX number resolves to. */
  readonly sls: RegExp;
  readonly statuses: SpxStatusMap;
}

// A long cross-border history is under a hundred kilobytes.
const MAX_BYTES = 1_000_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// The order index's own count of parcels under the number: none.
const UNKNOWN = /GetLogisticOrderIndexMap[\s\S]*\bfind \[0\]/;
// A parcel the index knows whose scans the lookup no longer holds.
const EMPTY = /GetRecords\(\)\)\s*==\s*0/;
const CODE = /^[A-Z0-9_]{1,16}$/;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;
// Scans at SPX's warehouses, forwarders, ports, hubs and sorting centres, on
// the way out and back. Pickups, drop-offs and deliveries name the seller's
// or the recipient's area, which is not kept. The end of a line haul names the
// place it left, so it keeps none.
const FACILITY = /^F(?!580$)(?:[2-5]\d\d|67\d|680)$/;
// Who took the parcel: the clause the Indonesian delivery line ends with, its
// English form, or the bracketed name the trackers' other wordings put after it.
const RECEIVER = /[\s,;]*\b(?:diterima oleh|received by|signed by)\b[\s\S]*$/i;
const NAMED = /\b(delivered)\s*\[[^\]]*\][\s\S]*$/i;
const DELIVERED = 'F980';

/** The lookup address of a network's tracker. */
export function spxOrderApi(network: SpxNetwork): string {
  return `${network.origin}/shipment/order/open/order/get_order_info`;
}

/** A number of the network's own layouts; anything else is not one its tracker looks up. */
export function normalizeSpxNumber(network: SpxNetwork, raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!network.spx.test(number) && !network.sls.test(number)) {
    throw new InvalidInputError(network.provider, `${network.provider} looks up its SPX numbers and Shopee's numbers for its country`);
  }
  return number;
}

/** A delivery's wording without the name of whoever took the parcel. */
export function spxDeliveryWording(text: string): string {
  return clean(clean(text, 1000).replace(RECEIVER, '').replace(NAMED, '$1'), 500).replace(/[\s,;:]+$/, '');
}

/** An optional text field; anything but a string is a changed reply. */
function text(provider: string, row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return value;
}

function projectRow(network: SpxNetwork, row: Record<string, unknown>): CarrierEvent | null {
  const { provider } = network;
  // The tracker leaves out the rows SPX flags hidden; its milestones among them stay.
  if (row.display_flag === 0 && !isSpxHiddenMilestone(row)) return null;
  const code = text(provider, row, 'tracking_code').trim().toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(provider, `${provider} returned an invalid tracking code`);
  // A scan without a line of its own keeps its English tracking name.
  const line = text(provider, row, 'description');
  const description = (code === DELIVERED ? spxDeliveryWording(line) : clean(line, 500)) || clean(text(provider, row, 'tracking_name'), 200);
  if (!description) throw new SchemaError(provider, `${provider} returned a scan without wording`);
  const clock = row.actual_time;
  const time = typeof clock === 'number' && Number.isSafeInteger(clock) && clock >= 1_000_000_000 && clock < 10_000_000_000
    ? epochSecondsTime(clock)?.iso : undefined;
  if (!time) throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  const place = FACILITY.test(code) && isRecord(row.current_location) ? row.current_location : null;
  const location = place ? clean(text(provider, place, 'location_name'), 120) : '';
  const point = place && location ? eventPoint(place.lat, place.lng) : null;
  const staged = network.statuses.classify(code, description);
  return {
    time, ...(location ? { location } : {}), ...(point ? { point } : {}), description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The numbers a reply names: its tracking object's, and a standalone order's own. */
function identities(provider: string, data: Record<string, unknown>, tracking: Record<string, unknown>) {
  const order = data.order_info;
  if (order !== undefined && order !== null && !isRecord(order)) throw new SchemaError(provider, `${provider} returned an invalid order`);
  const named = [tracking.sls_tn, ...(order ? [order.sls_tn, order.spx_tn] : [])]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => normalizeTrackingNumber(clean(value, 64)));
  return { order: Boolean(order), sls: normalizeTrackingNumber(clean(tracking.sls_tn, 64)), named };
}

/**
 * The reply of the tracker's `get_order_info` for one number. The order index
 * finding no parcel under one of SPX's own numbers is the page's no result.
 * A marketplace parcel is often found only by its SPX number, so the same
 * answer for a Shopee number proves nothing. A marketplace reply names only
 * the parcel's Shopee number, in the country's layout, and a standalone
 * order's names the number asked.
 */
export function parseSpxOrder(network: SpxNetwork, payload: unknown, raw: string): CarrierResult {
  const { provider } = network;
  const number = normalizeSpxNumber(network, raw);
  if (!isRecord(payload) || typeof payload.retcode !== 'number') throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  if (payload.retcode !== 0) {
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (UNKNOWN.test(message)) {
      if (network.spx.test(number)) throw new NotFoundError(provider);
      throw new IndeterminateError(provider, `${provider} finds this Shopee number only through its SPX number`);
    }
    if (EMPTY.test(message)) throw new NoHistoryError(provider);
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  if (!isRecord(payload.data)) throw new SchemaError(provider, `${provider} returned no tracking data`);
  const tracking = payload.data.sls_tracking_info;
  if (tracking === undefined || tracking === null) throw new NoHistoryError(provider);
  if (!isRecord(tracking) || typeof tracking.sls_tn !== 'string') throw new SchemaError(provider, `${provider} returned a shipment without its number`);
  const { order, sls, named } = identities(provider, payload.data, tracking);
  const bound = named.includes(number) || (!order && network.spx.test(number) && network.sls.test(sls));
  if (!bound) throw new IndeterminateError(provider, `${provider} answered for another shipment`);
  const rows = tracking.records ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(provider, `${provider} returned a shipment with invalid scans`);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    const event = projectRow(network, row);
    if (!event) continue;
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(provider);
  // Every scan is an instant; newest first by the clock, the order stays stable.
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The reply as JSON; a web page in its place is a gateway's check, anything else a changed reply. */
function json(provider: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (/^\s*</.test(body)) throw new ChallengeError(provider, `${provider} answered with a web page instead of its tracking reply`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

export class SpxRegionalTracker {
  constructor(
    private readonly network: SpxNetwork,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {},
  ) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { network } = this;
    const number = normalizeSpxNumber(network, raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const url = `${spxOrderApi(network)}?${new URLSearchParams({ spx_tn: number, language_code: network.language })}`;
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: network.provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The tracker reads a missing parcel from a 200 reply; a 404 or a redirect is a moved route.
      if (response.status !== 200) throw new TransportError(network.provider, `${network.provider} tracking lookup is unavailable`, { status: response.status });
      return parseSpxOrder(network, json(network.provider, decodeText(bytes)), number);
    };
    return runSteps({ carrier: network.id, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

/** A network's adapter. It has no recognition: a Shopee number's absence proves nothing, and SPX's own numbers need none. */
export function spxRegionalAdapter(network: SpxNetwork): AdapterFactory {
  return (environment) => {
    const tracker = new SpxRegionalTracker(network, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return { id: network.id, recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
  };
}
