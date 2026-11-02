/**
 * The Freightways group's tracking lookup, shared by its networks: New Zealand
 * Couriers, Post Haste, Castle Parcels and Now Couriers. Each network's folder
 * declares a `FreightwaysNetwork`; the lookup, its reply and the scan types'
 * status map (`./status.ts`) are the group's.
 */
import { DateTime } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { readFreightwaysTrackingUrl } from '../../core/catalog/urls.js';
import { isValidSscc, normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { nzCouriersStage } from './status.js';

// A consignment of several parcels is a few kilobytes.
export const FREIGHTWAYS_MAX_BYTES = 512 * 1024;
// A customer printed label's consignment number, which the sender's own system
// writes: letters, sometimes after a digit, then six to eight digits, not all
// zeros (three or four letters and six or seven digits on the labels seen; a
// digit leads Castle Parcels' sample label). A longer run, such as Purolator's
// PIN of three letters and nine digits, is refused.
const CONSIGNMENT = /^\d?[A-Z]{2,6}(?!0+$)\d{6,8}$/;
// The sender's account number, which the reply puts before a customer printed
// label's consignment number: digits, or letters and digits.
const ACCOUNT = /^[A-Z0-9]+$/;
// A consignment number the lookup takes with the sender's account.
const ACCOUNT_CONSIGNMENT = /^[A-Z0-9]{4,40}$/;
// The tracker's lookup refuses a query of fewer than six characters.
const MIN_QUERY = 6;
const MAX_ITEMS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const ZONE = 'Pacific/Auckland';
const ESTIMATE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\d{1,2})\s+([A-Za-z]+)$/i;
const REDIRECTS = [301, 302, 303, 307, 308];
const VALIDATION = /"title"\s*:\s*"REQUEST_VALIDATION_ERROR"/;
const LABEL_CREATED = /^label created$/i;
// Bot checks CloudFront or a firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|gokuProps|Request blocked/i;

/** One Freightways network on the group's tracking lookup. */
export interface FreightwaysNetwork {
  readonly carrier: string;
  readonly provider: string;
  /** The network's name in the lookup's address. */
  readonly path: string;
  /** A courier ticket: its product code, then its number. */
  readonly ticket: RegExp;
  /** A label of digits alone. */
  readonly label: RegExp;
  /** The numbers the network prints, for the refusal of anything else. */
  readonly numbers: string;
}

/**
 * The number as the tracker's lookup takes it: a ticket's product code and
 * number, a label or a customer printed label's consignment number alone, or
 * a consignment number with the sender's account. A consignment number asked
 * alone keeps the account a link names, which the reply must then name.
 */
export type FreightwaysQuery =
  | { kind: 'ticket'; number: string; code: string; query: string }
  | { kind: 'label'; number: string; query: string }
  | { kind: 'consignment'; number: string; query: string; account?: string }
  | { kind: 'account'; number: string; account: string; query: string };

const withoutZeros = (value: string) => value.replace(/^0+/, '');

/**
 * The lookups for one number, in order. With the sender's account, from a
 * link that names it, the consignment number goes first with the account, as
 * the receiver site asks it. A ticket, label or SSCC goes as the tracking page
 * sends it: without the number's leading zeros, except in a 20-digit barcode.
 * A customer printed label's consignment number goes whole, after the ticket
 * its layout may also fit, which the lookup then does not hold. Anything else
 * is not a number the network's tracker reads.
 */
export function freightwaysQueries(network: FreightwaysNetwork, raw: string, account?: string): FreightwaysQuery[] {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const ticket = network.ticket.exec(number);
  const query = ticket ? withoutZeros(ticket[2]!) : network.label.test(number) ? withoutZeros(number) : isValidSscc(number) ? number : '';
  const queries: FreightwaysQuery[] = [];
  if (account && ACCOUNT.test(account) && ACCOUNT_CONSIGNMENT.test(number)) queries.push({ kind: 'account', number, account, query: number });
  // The lookup refuses a ticket number that is too short once its zeros are dropped.
  if (query.length >= MIN_QUERY) queries.push(ticket ? { kind: 'ticket', number, code: ticket[1]!, query } : { kind: 'label', number, query });
  if (CONSIGNMENT.test(number)) queries.push({ kind: 'consignment', number, query: number, ...(account ? { account } : {}) });
  if (!queries.length) throw new InvalidInputError(network.provider, `${network.provider} numbers are ${network.numbers}`);
  return queries;
}

/** The first lookup for one number. */
export function freightwaysQuery(network: FreightwaysNetwork, raw: string): FreightwaysQuery {
  return freightwaysQueries(network, raw)[0]!;
}

/** An optional text field; anything but a string is a changed reply. */
function text(provider: string, row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * Whether the consignment the reply heads with, `shortConsignmentId`, is the
 * whole number asked: a ticket's product code and number, or the label alone.
 * The ticket number and a short label may come with or without their leading zeros.
 * A customer printed label's consignment number comes after the sender's
 * account number, which must be the account a link names.
 */
function sameConsignment(value: string, asked: FreightwaysQuery): boolean {
  const parts = value.toUpperCase().split(/\s+/).filter(Boolean);
  if (asked.kind === 'ticket') return parts.length === 2 && parts[0] === asked.code && withoutZeros(parts[1]!) === asked.query;
  if (asked.kind === 'consignment' || asked.kind === 'account') {
    return parts.at(-1) === asked.number && (parts.length === 1 || parts.length === 2 && (asked.account ? parts[0] === asked.account : ACCOUNT.test(parts[0]!)));
  }
  return parts.length === 1 && (asked.query.length === 20 ? parts[0] === asked.query : withoutZeros(parts[0]!) === asked.query);
}

/**
 * Where a scan was, as the tracking page shows it: its suburb and region. The
 * postcode and the delivery run are not kept.
 */
function place(provider: string, row: Record<string, unknown>): string {
  const location = row.location;
  if (location === null || location === undefined) return '';
  if (!isRecord(location)) throw new SchemaError(provider, `${provider} returned an invalid scan location`);
  return [text(provider, location, 'suburb', 80), text(provider, location, 'region', 80)].filter(Boolean).join(', ');
}

interface Scan { event: CarrierEvent; at: number; index: number; network: string }

/**
 * One scan. `createdOn` is an instant in UTC. Its attachments (a signature
 * with the name of whoever signed, a delivery photo), the authority-to-leave
 * tag, the barcode and the driver are not kept. The lookup with the sender's
 * account gives the label's creation without a type; its wording stages it.
 */
function projectScan(provider: string, row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
  const type = text(provider, row, 'eventType', 16).toUpperCase();
  const subtype = text(provider, row, 'eventSubType', 16).toUpperCase();
  const description = text(provider, row, 'status');
  const at = explicitOffsetTime(row.createdOn);
  const typed = type || (!subtype && LABEL_CREATED.test(description));
  if (!typed || !description || !at) throw new SchemaError(provider, `${provider} returned a scan without its type, wording or time`);
  const code = subtype ? `${type}/${subtype}` : type;
  const location = place(provider, row);
  const staged = nzCouriersStage(code, description);
  const event: CarrierEvent = {
    time: at.iso,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: at.timestamp, index, network: text(provider, row, 'carrierName', 40) };
}

/**
 * The delivery estimate, a weekday and a date without a year ("Thursday,
 * 20 February"). It is the next such date from the day before the parcel's
 * first scan in New Zealand, kept only when its weekday agrees.
 */
function estimate(provider: string, data: Record<string, unknown>, first: number): string | null {
  const parts = ESTIMATE.exec(text(provider, data, 'ETA', 40));
  if (!parts) return null;
  const from = DateTime.fromMillis(first, { zone: ZONE }).minus({ days: 1 });
  // A calendar date: parsing in UTC reads its digits only.
  const date = (year: number) => DateTime.fromFormat(`${parts[2]} ${parts[3]} ${year}`, 'd LLLL yyyy', { zone: 'UTC', locale: 'en-NZ' });
  const day = [date(from.year), date(from.year + 1)].find((candidate) => candidate.isValid && candidate.toISODate() >= from.toISODate()!);
  return day && day.toFormat('cccc', { locale: 'en-NZ' }).toLowerCase() === parts[1]!.toLowerCase() ? day.toISODate() : null;
}

/**
 * The reply of the `tracking-events` lookup for one number, which answers
 * HTTP 204 for a number it does not find. A consignment must name the whole
 * number asked, and the sender's account when it was asked with one. Each of
 * its parcels has its own scans; they are kept together, newest first.
 * Another catalog network that made the newest scan becomes the delivery
 * carrier.
 */
export function parseFreightways(network: FreightwaysNetwork, payload: unknown, raw: string, account?: string): CarrierResult {
  const { provider } = network;
  const readings = freightwaysQueries(network, raw, account);
  if (!isRecord(payload)) throw new SchemaError(provider, `${provider} returned an invalid consignment`);
  if (typeof payload.shortConsignmentId !== 'string') throw new SchemaError(provider, `${provider} returned a consignment without its number`);
  const consignment = clean(payload.shortConsignmentId, 80);
  if (!readings.some((asked) => sameConsignment(consignment, asked))) {
    throw new IndeterminateError(provider, `${provider} answered for another consignment`);
  }
  const items = payload.consignmentItems;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new SchemaError(provider, `${provider} returned a consignment with invalid parcels`);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  let index = 0;
  for (const item of items) {
    if (!isRecord(item) || !Array.isArray(item.trackingEvents)) throw new SchemaError(provider, `${provider} returned a parcel without its scans`);
    item.trackingEvents.forEach((row, position) => {
      const scan = projectScan(provider, row, index++);
      // The page shows a parcel's label only when it opens its history.
      if (position > 0 && LABEL_CREATED.test(scan.event.description!)) return;
      const key = JSON.stringify([scan.event.time, scan.event.provider_code, scan.event.description, scan.event.location ?? '']);
      if (seen.has(key)) return;
      seen.add(key);
      scans.push(scan);
    });
    if (index > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  }
  if (!scans.length) throw new NoHistoryError(provider);
  // Newest first; of two scans at one instant, the later in the reply is newer.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time : undefined;
  // Freightways' networks share the tracker; the network that scanned the
  // parcel last can be another courier's.
  const scanner = scans.find((scan) => scan.network)?.network;
  const partner = scanner ? carrierIdFromPartner(scanner) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' ? null : estimate(provider, payload, scans.at(-1)!.at),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(partner && partner !== network.carrier ? { delivery_carrier: partner } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The group's tracking lookup for one of its networks. */
export function freightwaysApi(network: FreightwaysNetwork): string {
  return `https://public-website.ep-prod.freightways.co.nz/public-website/v1/carriers/${network.path}/tracking-events`;
}

/**
 * The address of a network's lookup: a ticket as its product code and number,
 * a label or consignment number alone, or a consignment number under the
 * sender's account, in the receiver site's lookup.
 */
export function freightwaysLookupUrl(network: FreightwaysNetwork, asked: FreightwaysQuery): string {
  if (asked.kind === 'account') {
    return `https://public-website.ep-prod.freightways.co.nz/public-website/v2/carriers/${network.path}/customers/`
      + `${encodeURIComponent(asked.account)}/consignments/${encodeURIComponent(asked.query)}/tracking-events`;
  }
  const params = asked.kind === 'ticket'
    ? new URLSearchParams({ searchType: 'TK', ticketProductCode: asked.code, query: asked.query })
    : new URLSearchParams({ query: asked.query });
  return `${freightwaysApi(network)}?${params}`;
}

function json(provider: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/**
 * The sender's account named by a network's tracking link; a link of another
 * network or another number is invalid input.
 */
function accountOf(network: FreightwaysNetwork, raw: string, trackingUrl: string): string {
  try {
    return readFreightwaysTrackingUrl(trackingUrl, raw, network.carrier).account;
  } catch (cause) {
    throw new InvalidInputError(network.provider, cause instanceof TypeError ? cause.message : `${network.provider} cannot read the tracking link`, { cause });
  }
}

/**
 * The group's tracker for one network. A number that fits both a ticket and a
 * customer printed label's consignment number is asked as the ticket first,
 * then whole when the lookup does not hold the ticket. A tracking link that
 * names the sender's account is asked with it first.
 */
export class FreightwaysTracker {
  constructor(private readonly network: FreightwaysNetwork,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}, trackingUrl?: string | null): Promise<CarrierResult> {
    const { network } = this;
    const { provider } = network;
    const account = trackingUrl ? accountOf(network, raw, trackingUrl) : undefined;
    const queries = freightwaysQueries(network, raw, account);
    /** One lookup's consignment, or null when the lookup does not hold the number. */
    const lookup = async (asked: FreightwaysQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult | null> => {
      const { response, bytes } = await fetchBounded(freightwaysLookupUrl(network, asked), { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FREIGHTWAYS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(provider, `${provider} redirected its tracking lookup`);
      // The page reads a missing parcel from an empty 204 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(provider, `${provider} tracking lookup is unavailable`);
      if (response.status === 400) {
        // The lookup's own refusal of a query it does not take, such as one too short.
        if (VALIDATION.test(decodeText(bytes).slice(0, 4_000))) throw new InvalidInputError(provider, `${provider} refused the number`);
        throw new TransportError(provider, `${provider} rejected the tracking lookup`, { status: 400 });
      }
      if (response.status === 204) return null;
      return parseFreightways(network, json(provider, decodeText(bytes)), asked.number, account);
    };
    const read = async (signal: AbortSignal, remainingMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + remainingMs;
      for (const asked of queries) {
        const result = await lookup(asked, signal, deadline - Date.now());
        if (result) return result;
      }
      throw new NotFoundError(provider);
    };
    return runSteps({ carrier: network.carrier, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

/** A network's adapter: one direct step, without recognition, with the tracking link when there is one. */
export function freightwaysAdapter(network: FreightwaysNetwork): AdapterFactory {
  return (environment) => {
    const tracker = new FreightwaysTracker(network, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: network.carrier, recordsSteps: true, steps: ['direct'],
      track: (input, context) => tracker.fetch(input.number, context, input.trackingUrl),
    };
  };
}
