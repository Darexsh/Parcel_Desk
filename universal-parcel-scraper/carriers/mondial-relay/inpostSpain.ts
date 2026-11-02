import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, InputRequiredError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { EXPLICIT_OFFSET_PATTERN } from '../../core/time/index.js';
import { cleanScalar, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { inpostSpainHeadlineStage, inpostSpainStage } from './status.js';

const PROVIDER = 'Mondial Relay';
/** InPost Spain's tracking page, which the server renders with the parcel's tracking in its props. */
export const INPOST_SPAIN_PAGE = 'https://www.inpost.es/seguimiento-del-envio/';
// One page is under 100 kB.
const MAX_BYTES = 2_000_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// The instants are UTC; shown on peninsular Spain's clocks, as the app's are on Paris's.
const ZONE = 'Europe/Madrid';
// FV and eight digits: InPost Spain's own numbers, which Mondial Relay's website does not know.
const NUMBER = /^FV\d{8}$/;
const CODE = /^[A-Z]{3}\.\d{4}$/;
const MAX_MILESTONES = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha-delivery|_Incapsula_Resource|<title>\s*Access Denied/i;

/** Whether a number is one of InPost Spain's own, tracked on its page alone. */
export function isInpostSpainNumber(number: string): boolean {
  return NUMBER.test(number);
}

export function inpostSpainTrackingUrl(number: string): string {
  const url = new URL(INPOST_SPAIN_PAGE);
  url.searchParams.set('parcelNumber', number);
  return url.toString();
}

/**
 * Astro's serialized props: every value is a pair, type 0 for a plain value or
 * an object of pairs, type 1 for an array of pairs. Dates, maps and the other
 * types are not read here.
 */
function astroValue(pair: unknown, depth = 0): unknown {
  if (depth > 16 || !Array.isArray(pair) || pair.length > 2 || typeof pair[0] !== 'number') {
    throw new SchemaError(PROVIDER, 'InPost Spain changed the props of its tracking page');
  }
  const [type, value] = pair as [number, unknown];
  if (type === 1) {
    if (!Array.isArray(value)) throw new SchemaError(PROVIDER, 'InPost Spain changed the props of its tracking page');
    return value.map((item) => astroValue(item, depth + 1));
  }
  if (type !== 0) return undefined;
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, astroValue(item, depth + 1)])) : value;
}

/** The props of the page's tracking component. */
function trackingProps(html: string): Record<string, unknown> {
  const $ = load(html);
  const props = $('astro-island').toArray().map((island) => $(island).attr('props') ?? '')
    .filter((value) => value.includes('"trackingDetailsStatus"'));
  if (props.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'InPost Spain answered with a browser check');
    throw new SchemaError(PROVIDER, 'InPost Spain’s tracking page no longer carries the parcel’s tracking');
  }
  let decoded: unknown;
  try {
    decoded = astroValue([0, JSON.parse(props[0]!)]);
  } catch (cause) {
    if (cause instanceof SchemaError) throw cause;
    throw new SchemaError(PROVIDER, 'InPost Spain changed the props of its tracking page', { cause });
  }
  if (!isRecord(decoded)) throw new SchemaError(PROVIDER, 'InPost Spain changed the props of its tracking page');
  return decoded;
}

function scanTime(value: unknown): { iso: string; timestamp: number } {
  const raw = typeof value === 'string' ? value.trim() : '';
  const parsed = raw.length <= 40 && EXPLICIT_OFFSET_PATTERN.test(raw) ? DateTime.fromISO(raw, { setZone: true }) : null;
  const iso = parsed?.isValid ? parsed.setZone(ZONE).toISO({ suppressMilliseconds: true }) : null;
  if (!parsed || !iso) throw new SchemaError(PROVIDER, 'InPost Spain returned an invalid scan time');
  return { iso, timestamp: parsed.toMillis() };
}

/**
 * The tracking InPost Spain's page renders for one number. The props of its
 * tracking component carry the status of the page's own lookup: 404 for a
 * number it does not know, 409 when it asks the recipient's postcode, 200 with
 * `trackingDetails`. Those hold the milestones newest first, each with its
 * coded scans and their instants. The parcel is read only when both the page
 * and its details name the whole number asked.
 */
export function parseInpostSpainPage(html: string, number: string): CarrierResult {
  const props = trackingProps(html);
  if (props.parcelNumber !== number) throw new SchemaError(PROVIDER, 'InPost Spain answered for another number');
  const status = props.trackingDetailsStatus;
  if (status === 404) throw new NotFoundError(PROVIDER, 'InPost Spain has no parcel under this number');
  if (status === 409) throw new InputRequiredError(PROVIDER, 'the recipient postcode', 'InPost Spain asks the recipient postcode for this parcel');
  if (typeof status === 'number' && status >= 500 && status < 600) {
    throw new TransportError(PROVIDER, 'InPost Spain’s tracking lookup failed', { status });
  }
  if (status !== 200) throw new SchemaError(PROVIDER, 'InPost Spain returned an unexpected tracking status');
  const details = props.trackingDetails;
  if (!isRecord(details) || !Array.isArray(details.milestones)) throw new SchemaError(PROVIDER, 'InPost Spain returned tracking without milestones');
  if (details.packageId !== number) throw new SchemaError(PROVIDER, 'InPost Spain answered for another parcel');
  if (details.milestones.length > MAX_MILESTONES) throw new SchemaError(PROVIDER, 'InPost Spain returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; at: number; index: number }[] = [];
  let rows = 0;
  for (const milestone of details.milestones) {
    if (!isRecord(milestone) || !Array.isArray(milestone.events)) throw new SchemaError(PROVIDER, 'InPost Spain returned an invalid milestone');
    const type = typeof milestone.type === 'string' ? milestone.type : '';
    rows += milestone.events.length;
    if (rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'InPost Spain returned an oversized history');
    for (const row of milestone.events) {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'InPost Spain returned an invalid scan');
      const time = scanTime(row.date);
      const label = cleanScalar(row.name, 200);
      // A scan without a label says nothing.
      if (!label) continue;
      const code = typeof row.code === 'string' && CODE.test(row.code) ? row.code : '';
      const key = JSON.stringify([time.iso, code, label]);
      if (seen.has(key)) continue;
      seen.add(key);
      const staged = inpostSpainStage(code, label, type);
      scans.push({ at: time.timestamp, index: scans.length, event: {
        time: time.iso,
        description: label,
        ...(code ? { provider_code: code } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      } });
    }
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  scans.sort((left, right) => right.at - left.at || left.index - right.index);

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  // The newest scan's stage, else the page's headline, else the newest scan with one.
  const headline = isRecord(details.milestones[0]) && typeof details.milestones[0].type === 'string'
    ? inpostSpainHeadlineStage(details.milestones[0].type) : undefined;
  const staged = newest.stage ? newest : headline ? undefined : events.find((event) => event.stage);
  const stage = (staged?.stage ?? headline) as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged?.stage_source ?? 'milestone' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    timezone: ZONE,
  };
}

/** One read of the page for an InPost Spain number. */
export async function readInpostSpain(number: string, options: {
  signal: AbortSignal; timeoutMs: number; fetcher?: typeof fetch; userAgent?: string;
}): Promise<CarrierResult> {
  const { response, bytes } = await fetchBounded(inpostSpainTrackingUrl(number), { method: 'GET', signal: options.signal, headers: {
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9',
    'User-Agent': userAgentOf(options.userAgent),
  } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(options.timeoutMs)), maxBytes: MAX_BYTES,
    redirect: 'manual', fetcher: options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404] });
  const page = decodeText(bytes);
  if (response.status === 403 && CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'InPost Spain answered with a browser check');
  // The page answers every number with HTTP 200; a redirect or a 404 is a moved route.
  if (response.status !== 200) throw new TransportError(PROVIDER, 'InPost Spain tracking page moved', { status: response.status });
  return { ...parseInpostSpainPage(page, number), tracking_url: inpostSpainTrackingUrl(number), tracking_source: 'rendered-page' };
}
