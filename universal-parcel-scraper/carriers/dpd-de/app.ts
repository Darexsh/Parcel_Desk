import { DateTime } from 'luxon';
import { CarrierError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { calendarDay, isoTime, zonedTime } from '../../core/time/index.js';
import type { XmlNode } from '../../core/transport/xml.js';
import {
  children, DpdAppService, DpdOtherCountryError, invalid, one, optional, PostcodeRejected, scalar, SessionExpired, type DpdDePartner,
} from './service.js';
import { DPD_DE_APP_SCANS, dpdDeScanKey, dpdDeShopCollectionStage } from './status.js';

/** The app's progress rail: one coarse state for the whole parcel. */
export const DPD_DE_APP_RAIL: Readonly<Record<string, ClassifiedStatus>> = {
  ACCEPTED: { status: 'pending', stage: 'registered' },
  ON_THE_ROAD: { status: 'in_transit', stage: 'in_transit' },
  AT_DELIVERY_DEPOT: { status: 'in_transit', stage: 'in_transit' },
  OUT_FOR_DELIVERY: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  DELIVERED: { status: 'delivered', stage: 'delivered' },
  // Set while the return travels and after it reaches the sender: its own scans tell them apart.
  RETURN_TO_SENDER: { status: 'exception', stage: 'exception' },
};

const affirmative = (value: string) => value === 'true' || value === '1';
const placeholderDay = (day: string) => day === '2000-01-01' || day === '0001-01-01';

/** Validate source digits without assigning a zone to an offset-less estimate. */
function estimateClock(raw: string) {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(raw)
    || placeholderDay(raw.slice(0, 10))) return null;
  return isoTime(raw, 'UTC');
}

function estimateDay(raw: string): string | null {
  if (estimateClock(raw)) return raw.slice(0, 10);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const display = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  const day = iso ? calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    : display ? calendarDay(Number(display[3]), Number(display[2]), Number(display[1])) : null;
  return day && !placeholderDay(day) ? day : null;
}

function announcedDay(wording: string): string | null {
  const date = /^Your parcel is estimated to be delivered on:\s*(?:[A-Za-z]+,\s*)?(\d{2}\.\d{2}\.\d{4})$/i.exec(wording)?.[1];
  return date ? estimateDay(date) : null;
}

/** Specified dates are forecasts, never scans; delivered display dates are actuals. */
function deliveryEstimate(tracking: XmlNode, announced: string | null): string | null {
  const planned = optional(tracking, 'NewDeliveryInfo');
  const day = planned && affirmative(scalar(planned, 'PlannedDeliveryDateSpecified', 8))
    ? estimateDay(scalar(planned, 'PlannedDeliveryDate', 64)) : null;
  // The app displays a changed delivery day ahead of its previous forecast.
  if (day && planned && affirmative(scalar(planned, 'DateChanged', 8))) return day;
  const live = optional(tracking, 'LiveTracking');
  if (live && affirmative(scalar(live, 'EstimatedDeliveryDateTimeSpecified', 8))) {
    const from = scalar(live, 'EstimatedDeliveryDateTimeFrom', 64);
    const to = scalar(live, 'EstimatedDeliveryDateTimeTo', 64);
    const start = estimateClock(from);
    const end = estimateClock(to);
    const hasOffset = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    if (start && end && hasOffset(from) === hasOffset(to) && end.timestamp >= start.timestamp) {
      // An explicit instant can be shown on the German delivery clock. Unresolved
      // wall clocks retain their digits, without receiving an invented offset.
      const display = (raw: string, timestamp: number) => hasOffset(raw)
        ? DateTime.fromMillis(timestamp, { zone: 'Europe/Berlin' }).toFormat('yyyy-MM-dd HH:mm')
        : raw.slice(0, 16).replace('T', ' ');
      const first = display(from, start.timestamp);
      const last = display(to, end.timestamp);
      return `${first}–${first.slice(0, 10) === last.slice(0, 10) ? last.slice(11) : last}`;
    }
  }
  // DeliveryDateTime is display text and can omit the year: never invent it.
  return day ?? announced ?? estimateDay(scalar(tracking, 'DeliveryDateTime', 64));
}

/** A two-letter country, where the service puts a placeholder three-letter one for an unknown depot. */
function countryOf(node: XmlNode | undefined): string {
  const country = node ? scalar(node, 'Country', 8) : '';
  return /^[A-Z]{2}$/.test(country) ? country : '';
}

/** As on the guest API: a parcel waiting at a shop is out for delivery, and a failed attempt stays in transit. */
function statusOf(stage: string | undefined): CarrierStatus {
  if (stage === 'delivered' || stage === 'out_for_delivery' || stage === 'exception') return stage;
  if (stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'returned') return 'exception';
  if (stage === 'registered') return 'pending';
  return stage ? 'in_transit' : 'unknown';
}

/** The shop a scan names, as `<PUDO id>|<shop name>` under additional code 999. */
function shopOf(row: XmlNode): { id: string; name: string } | undefined {
  for (const entry of children(row, 'TrackingScanAdditionalList').flatMap(list => children(list, 'TrackingScanAdditionalType'))) {
    const named = scalar(entry, 'AdditionalCode', 8) === '999' && /^([A-Z]{2}\d{1,12})\|(.{1,120})$/.exec(scalar(entry, 'Description', 200));
    if (named && named[2]!.trim()) return { id: named[1]!, name: named[2]!.trim() };
  }
  return undefined;
}

/** The measured length, width and height, in millimetres; the shipper's own figures are not read. */
function dimensionsOf(order: XmlNode): string | null {
  const sides = ['Length', 'Width', 'Height'].map(name => scalar(order, name, 16));
  if (!sides.every(side => /^\d{1,5}$/.test(side) && Number(side) > 0)) return null;
  return `${sides.map(side => Number(side) / 10).join(' × ')} cm`;
}

/**
 * Scans arrive oldest first, with a facility's wall clock and no offset. `shop` is the PUDO id of
 * the shop the result names as its pickup point, else empty.
 */
export function parseDpdDeApp(data: XmlNode, scans: XmlNode, number: string): { result: CarrierResult; shop: string } {
  const tracking = one(data, 'TrackingData');
  if (scalar(tracking, 'ParcelNo', 40) !== number) throw new SchemaError('DPD Germany', 'DPD Germany returned a different parcel');
  const rows = children(one(scans, 'TrackingScanList'), 'TrackingScan');
  if (rows.length > 500) invalid();
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  let placed = '';
  let announced: string | null = null;
  let shop: ReturnType<typeof shopOf>;
  // Oldest first: whether the parcel waited at a shop for its recipient, and the stage before.
  let waited = false;
  let previous: Stage | undefined;
  for (const row of rows) {
    const wording = scalar(row, 'StatusText', 500);
    if (!wording) invalid();
    // These rows may carry no scan clock. The date is in the announcement itself.
    if (/^Your parcel is estimated to be delivered\b/i.test(wording)) {
      announced = announcedDay(wording);
      continue;
    }
    const day = scalar(row, 'ScanDate', 16);
    const time = scalar(row, 'ScanTime', 16);
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) invalid();
    const place = /^(.{1,120}) \(([A-Z]{2})\)$/.exec(scalar(row, 'Location'));
    if (place) placed = place[2]!;
    // German facilities keep German civil time; a clock elsewhere has no established zone.
    const clock = zonedTime(`${day} ${time}`, 'dd.MM.yyyy HH:mm', place?.[2] === 'DE' ? 'Europe/Berlin' : 'UTC');
    if (!clock) invalid();
    const key = dpdDeScanKey(wording);
    const stage = Object.hasOwn(DPD_DE_APP_SCANS, key) ? DPD_DE_APP_SCANS[key] : dpdDeShopCollectionStage(key, waited, previous);
    if (stage === 'ready_for_pickup') [shop, waited] = [shopOf(row), true];
    previous = stage ?? previous;
    const event: CarrierEvent = {
      ...(place?.[2] === 'DE' ? { time: clock.iso } : { local_time: clock.iso.slice(0, 19), provider_time_text: `${day} ${time}` }),
      ...(place ? { location: `${place[1]}, ${place[2]}` } : {}),
      description: /\b(?:delivered to|signed (?:for )?by|received by)\b/i.test(wording) ? 'Delivery update' : wording,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    // Reason codes and service descriptions are not projected.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  if (!events.length) throw new IndeterminateError('DPD Germany', 'DPD Germany returned no parcel scans');
  // The service also answers for parcels elsewhere in the group, and its recipient address reads
  // Germany for them too. Where the parcel is now, as the guest API's current country: the newest
  // placed scan, else the depot of the last status.
  const depot = children(tracking, 'LastStatusInfo').flatMap(info => children(info, 'DepotData')).flatMap(data => children(data, 'Address'))[0];
  const country = placed || countryOf(depot);
  if (country && country !== 'DE') {
    throw new DpdOtherCountryError(country);
  }
  events.reverse();
  const current = events[0]!;
  const railId = scalar(one(tracking, 'LastStatusInfo'), 'StatusID', 64);
  const rail = Object.hasOwn(DPD_DE_APP_RAIL, railId) ? DPD_DE_APP_RAIL[railId] : undefined;
  const stage = current.stage ?? rail?.stage;
  const status = rail?.status ?? statusOf(current.stage);
  const order = one(tracking, 'OrderInfo');
  const kilograms = Number(scalar(order, 'Weight', 16).replace(',', '.'));
  const dimensions = dimensionsOf(order);
  const deliveredAt = status === 'delivered' ? events.find(event => event.stage === 'delivered')?.time : undefined;
  // The shop holding the parcel, while it waits there.
  const pickup = stage === 'ready_for_pickup' ? shop : undefined;
  const result: CarrierResult = {
    status, ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description ?? null, last_update: current.time ?? null,
    expected_delivery: affirmative(scalar(tracking, 'Delivered', 8)) || status === 'delivered' || status === 'exception'
      || stage === 'delivered' || stage === 'ready_for_pickup' ? null : deliveryEstimate(tracking, announced),
    ...(current.time ? {} : { last_update_local: current.local_time }),
    ...(Number.isFinite(kilograms) && kilograms > 0 ? { weight_kg: kilograms } : {}),
    ...(dimensions ? { dimensions_text: dimensions } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(pickup ? { pickup_point: pickup.name } : {}),
    events: events.slice(0, 100),
  };
  return { result, shop: pickup?.id ?? '' };
}

/** DPD Germany's tracking through the German app's service, over the given one or a new one. */
export class DpdDeAppClient {
  readonly #service: DpdAppService;

  constructor(options: { service?: DpdAppService; partner?: DpdDePartner; fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {}) {
    this.#service = options.service ?? new DpdAppService(options);
  }

  /**
   * `sessionWaitMs` is how long from its start the lookup may wait for a session still opening, also
   * for one that replaces a session the service refused; the whole `timeoutMs` by default. `waiting`
   * is called when the lookup starts waiting for one. Once `stop` aborts, the lookup stops waiting,
   * ends with its reason and reads nothing.
   * DPD checks a `postcode` against the recipient's: a rejected one gets one lookup without it, and
   * the result says which, as on the guest API.
   */
  async track(number: string, options: {
    signal: AbortSignal; timeoutMs: number; sessionWaitMs?: number; postcode?: string; stop?: AbortSignal; waiting?: () => void;
  }): Promise<CarrierResult> {
    if (!/^\d{14}$/.test(number)) throw new TypeError('DPD Germany app tracking takes 14 digits');
    const postcode = options.postcode ?? '';
    if (postcode && !/^\d{5}$/.test(postcode)) throw new TypeError('DPD Germany app tracking takes a 5-digit postcode');
    const deadline = performance.now() + options.timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const waitEnds = Math.min(deadline, performance.now() + (options.sessionWaitMs ?? Infinity));
    try {
      for (let attempt = 0; ; attempt += 1) {
        const session = await this.#service.session(options.signal, Math.max(0, waitEnds - performance.now()), {
          waiting: options.waiting, stop: options.stop,
        });
        options.stop?.throwIfAborted();
        // Read-only: the parcel is neither added to the session nor redirected.
        const tracking = (zip: string) => this.#service.call('getTrackingData', { SessionToken: session, ParcelNo: number, DeliveryZipCode: zip,
          UpdateNewDeliveryData: 'false', addParcelIfNoTrackingdataAvailable: 'false', ParcelFlowTypeID: 'receiving' }, options.signal, left());
        try {
          let data: XmlNode;
          let verified: boolean | undefined;
          try {
            data = await tracking(postcode);
            if (postcode) verified = ['DeliveryZipCode_isValid', 'Owner'].includes(scalar(one(data, 'TrackingData'), 'DataViewStatus', 40));
          } catch (error) {
            // Also the answer for an unknown parcel, which the lookup without it then reports.
            if (!(error instanceof PostcodeRejected)) throw error;
            data = await tracking('');
            verified = false;
          }
          options.stop?.throwIfAborted();
          const scans = await this.#service.call('getTrackingScanList', { SessionToken: session, ParcelNo: number,
            DeliveryZipCode: verified ? postcode : '' }, options.signal, left());
          const { result, shop } = parseDpdDeApp(data, scans, number);
          // The scans name the shop without its address, which the shop's own record adds.
          // Without it, the parcel is found all the same and its pickup point keeps the name alone.
          options.stop?.throwIfAborted();
          const address = shop ? (await this.#service.parcelShop(shop, { signal: options.signal, timeoutMs: left() }))?.address : undefined;
          if (address) result.pickup_point = `${result.pickup_point}\n${address}`;
          if (verified !== undefined) result.dpd_postcode_verified = verified;
          return result;
        } catch (error) {
          if (!(error instanceof SessionExpired) || attempt) throw error;
          this.#service.expire(session);
        }
      }
    } catch (error) {
      options.signal.throwIfAborted();
      // Transport diagnostics include the credentials, the session and recipient XML.
      // Preserve the failure contract without forwarding request or body data. The
      // country a parcel is in holds neither.
      if (error instanceof DpdOtherCountryError) throw error;
      if (error instanceof CarrierError) throw new CarrierError(error.kind, 'DPD Germany', `DPD Germany app tracking failed (${error.kind})`, {
        status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
      });
      throw new TransportError('DPD Germany', 'DPD Germany app request failed');
    }
  }
}
