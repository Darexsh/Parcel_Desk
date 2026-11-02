
import { DateTime, IANAZone } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { accepted, recognizeFromLookup } from '../../core/adapter/index.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fourPxStatus } from './status.js';

const ENDPOINT = 'https://track.4px.com/track/v2/front/listTrackV3';

export function normalizeFourPxNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9]{8,40}$/.test(number)) throw new InvalidInputError('4PX', '4PX requires an alphanumeric parcel reference');
  return number;
}

function eventTime(raw: Record<string, unknown>): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const local = clean(raw.tkDateStr, 64);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(local)) throw new SchemaError('4PX', '4PX returned an invalid scan time');
  const zone = clean(raw.tkTimezone, 64);
  const offset = /^UTC([+-]\d{2}:\d{2})$/.exec(zone)?.[1];
  // Some partners' scans name a zone instead ("UTCAmerica/Vancouver").
  const named = /^UTC([A-Z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+)$/.exec(zone)?.[1];
  if (zone && !offset && !named && zone !== 'UTC') throw new SchemaError('4PX', '4PX returned an invalid scan offset');
  // The displayed time and offset form one pair. tkDate encodes different
  // clock digits and must not replace the portal's per-scan local timestamp.
  const wall = local.replace(' ', 'T');
  const parsed = named ? firstOccurrence(DateTime.fromISO(wall, { zone: IANAZone.isValidZone(named) ? named : 'UTC' }))
    : DateTime.fromISO(`${wall}${offset ?? (zone === 'UTC' ? 'Z' : '')}`, { setZone: true, zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError('4PX', '4PX returned an invalid scan time');
  // A zone name the clock database does not know leaves the scan's clock local.
  const placed = Boolean(zone) && (!named || IANAZone.isValidZone(named));
  const iso = parsed.toISO({ suppressMilliseconds: true, includeOffset: placed });
  return placed ? { time: iso } : { local_time: iso };
}

// The contact card opens with the last-mile provider's name, and also lists
// its website. Only the catalog carrier both agree on is kept, never the
// card's phone numbers or addresses.
function partnerOf(card: unknown): string | undefined {
  if (!isRecord(card) || typeof card.contact !== 'string') return undefined;
  const name = clean(/^\s*【服务商】([^\n【]+)/.exec(card.contact.slice(0, 1000))?.[1], 80);
  return name ? carrierIdFromPartner(name, clean(card.website, 200)) : undefined;
}

// 4PX sends a partner the order data when its facility measures the parcel and
// records that on the facility's clock, but labels the row with the partner's
// zone: "Order information has been transmitted to dpd." reads three seconds
// after the +08:00 measurement, labelled +02:00.
const TRANSMITTED = /^order information has been transmitted to /i;

// 4PX copies La Poste's arrival in France and its transit there with La
// Poste's UTC digits under Paris's offset, two hours early in summer: arrived
// at destination at Roissy, handled by local carrier, transport to delivery
// centre. Those copies keep La Poste's seconds; 4PX's own transport rows, to
// the minute, and the delivery round's copies show Paris's clock.
const LA_POSTE_TRANSIT = /^(?:arrived at destination|handled by local carrier|transport to delivery cent(?:re|er))\.?$/i;
const PARIS_LABEL = /^UTC\+0[12]:00$/;

/** A copy of La Poste's arrival or transit scan on a parcel to France, whose digits are UTC. */
function laPosteTransitCopy(raw: Record<string, unknown>, description: string, country: string): boolean {
  return country === 'FR' && LA_POSTE_TRANSIT.test(description) && PARIS_LABEL.test(clean(raw.tkTimezone, 64))
    && !clean(raw.tkDateStr, 64).endsWith(':00');
}

// Asendia Hong Kong, which flies parcels for 4PX, dates its label and manifest
// in UTC, as Yanwen relays them, and 4PX labels those digits with the
// destination's offset: a label made as 4PX's facility measured the parcel
// reads two hours before the measurement, at the same seconds.
const ASENDIA = /^asendia hong kong$/i;

// 4PX can list a partner's scan twice: on the partner's clock, and with UTC digits under
// the same offset, the offset earlier at the same seconds. A partner's order made as the
// facility measures the parcel reads one second after the measurement on the partner's
// clock, and hours before the pickup in UTC digits. A scan whose digits are its twin's UTC
// time is that copy, and is left out.
function twin(digits: string, raw: Record<string, unknown>): string {
  return JSON.stringify([digits, clean(raw.tkTimezone, 64), clean(raw.tkDesc, 1000), clean(raw.tkLocation, 200), clean(raw.tkCode, 64)]);
}

/** How a UTC-digit copy of each scan with an offset other than zero would read. */
function utcCopies(tracks: unknown[]): Set<string> {
  const copies = new Set<string>();
  for (const raw of tracks) {
    if (!isRecord(raw)) continue;
    const offset = /^UTC([+-]\d{2}:\d{2})$/.exec(clean(raw.tkTimezone, 64))?.[1];
    const at = offset && !/^[+-]00:00$/.test(offset)
      ? DateTime.fromISO(`${clean(raw.tkDateStr, 64).replace(' ', 'T')}${offset}`, { zone: 'UTC' }) : null;
    if (at?.isValid) copies.add(twin(at.toFormat('yyyy-MM-dd HH:mm:ss'), raw));
  }
  return copies;
}

/** The offset 4PX's own facility scans (`FPX_C_…`) carry, if any. */
function facilityZone(tracks: unknown[]): string | undefined {
  return tracks.map((raw) => (isRecord(raw) && clean(raw.tkCode, 64).startsWith('FPX_C_') ? clean(raw.tkTimezone, 64) : ''))
    .find((zone) => /^UTC[+-]\d{2}:\d{2}$/.test(zone));
}

// A partner's qualifier left on its wording, as DPD's `NABN` or `SHOP`
// ("…Notification was left._nabn").
const QUALIFIER = /(?<=[a-z.])_[a-z]{2,8}$/i;

/**
 * A partner's pickup-shop record relayed as a scan's wording: the shop's
 * fields, then `_` and their names (`store_type;pudo_id;pudo_name;…`), in any
 * case. It is no scan; the shop's name and town are the pickup point, and
 * without a name there is none.
 */
function shopRecord(description: string): { point?: string } | undefined {
  const [values, names] = description.split(/_(?=store_type;)/i);
  if (!names || !/(?:^|;)pudo_[a-z]+(?:;|$)/i.test(names)) return undefined;
  const fields = values!.split(';');
  const field = (name: string) => clean(fields[names.toLowerCase().split(';').indexOf(name)], 120);
  const shop = field('pudo_name');
  return shop ? { point: [shop, field('city')].filter(Boolean).join(', ') } : {};
}

export function parse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeFourPxNumber(trackingNumber);
  if (!isRecord(payload) || payload.result !== 1 || !Array.isArray(payload.data)) throw new SchemaError('4PX');
  const matches = payload.data.filter((item) => isRecord(item) && clean(item.queryCode, 64).toUpperCase() === number);
  if (matches.length !== 1 || !isRecord(matches[0])) throw new SchemaError('4PX', '4PX returned a different or ambiguous shipment');
  const item = matches[0];
  if (item.status === 7 && item.serverCode === null && item.shipperCode === null && item.tracks === null) throw new NotFoundError('4PX');
  if (item.mutiPackage === true) throw new IndeterminateError('4PX', '4PX returned a multi-package order requiring separate parcel history');
  if (!Array.isArray(item.tracks) || item.tracks.length === 0) throw new IndeterminateError('4PX', '4PX returned no parcel scans');
  if (item.tracks.length > 500) throw new SchemaError('4PX', '4PX returned excessive tracking history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let pickupPoint: string | undefined;
  const facility = facilityZone(item.tracks);
  const copies = utcCopies(item.tracks);
  const country = clean(item.ctEndCode, 8).toUpperCase();
  for (const raw of item.tracks) {
    if (!isRecord(raw)) throw new SchemaError('4PX');
    const wording = clean(raw.tkDesc, 1000);
    if (!wording) throw new SchemaError('4PX', '4PX returned an empty scan');
    if (copies.has(twin(clean(raw.tkDateStr, 64), raw))) continue;
    const shop = shopRecord(wording);
    if (shop) {
      pickupPoint ??= shop.point;
      continue;
    }
    const description = clean(wording.replace(QUALIFIER, ''), 500);
    const location = clean(raw.tkLocation, 200);
    const time = eventTime(facility && TRANSMITTED.test(description) ? { ...raw, tkTimezone: facility }
      : laPosteTransitCopy(raw, description, country) || ASENDIA.test(location) ? { ...raw, tkTimezone: 'UTC' } : raw);
    const code = clean(raw.tkCode, 64);
    const key = JSON.stringify([time, description, location, code]);
    if (seen.has(key)) continue;
    seen.add(key);
    const classified = fourPxStatus(code, description);
    events.push({ ...time, description, location, ...(code ? { provider_code: code } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) });
  }
  const latest = events[0];
  if (!latest) throw new IndeterminateError('4PX', '4PX returned no parcel scans');
  const classified = fourPxStatus(latest.provider_code ?? '', latest.description);
  // Result normalization keeps only the package number of a USPS routing barcode.
  const deliveryNumber = clean(item.serverCode, 64).toUpperCase();
  const partner = partnerOf(item.channelContact);
  return {
    status: classified?.status ?? 'unknown',
    ...(classified ? { current_stage: classified.stage, current_stage_source: classified.source } : {}),
    last_status_text: latest.description,
    last_update: latest.time ?? null,
    ...(classified?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(deliveryNumber !== number && /^[A-Z0-9]{4,40}$/.test(deliveryNumber) ? { delivery_tracking_number: deliveryNumber } : {}),
    events: events.slice(0, 100),
  };
}

export class FourPxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFourPxNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('4PX timeout must be positive');
    context.signal?.throwIfAborted();
    try {
      const { bytes } = await fetchBounded(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ queryCodes: [number], language: 'en-us', translateLanguage: '' }),
      }, {
        provider: '4PX', timeoutMs: Math.max(1, Math.floor(budgetMs)), maxBytes: 1_000_000,
        fetcher: (input, init) => (this.options.fetcher ?? fetch)(input, { ...init,
          signal: AbortSignal.any([...(context.signal ? [context.signal] : []), ...(init?.signal ? [init.signal] : [])]) }),
      });
      context.signal?.throwIfAborted();
      return parse(parseJsonBytes(bytes, '4PX'), number);
    } catch (error) {
      if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('4PX', '4PX tracking endpoint is unavailable', { cause: error });
      throw error;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FourPxTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  const lookup = (number: string, context: TrackingContext = {}) => runSteps({ carrier: 'four-px', budgetMs: context.budgetMs ?? 15_000,
    signal: context.signal, recorder: environment.recorder }, [{ id: 'direct', run: ({ signal, remainingMs }) => tracker.fetch(number, { signal, budgetMs: remainingMs }) }]);
  return { id: 'four-px', recordsSteps: true, steps: ['direct'], track: async (input, context) => {
    // A number of another shape is refused before the lookup starts.
    normalizeFourPxNumber(input.number);
    return lookup(input.number, context);
  },
    recognize: (number, context) => recognizeFromLookup(() => lookup(number, context), () => accepted(() => normalizeFourPxNumber(number))) };
};
