import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'CNE Express';
const WORDING: Readonly<Record<string, Stage>> = {
  'Parcel Infomation Received': 'registered', 'Picked Up by Courier': 'accepted',
  'Shipment Loaded': 'in_transit', 'Departed CNE Facility': 'in_transit',
  'Arrived at CNE Facility': 'in_transit', 'Inbound scan': 'in_transit',
  'Shipment Processed': 'in_transit', 'Sorting failed []': 'exception',
  "It was returned to customer's address by CNE": 'returned',
  'Departure Scan': 'in_transit', 'Depart From Local Facility': 'in_transit',
  'Arrived Export Airport': 'in_transit', 'Released From Export Customs': 'in_transit',
  'Shipment Departed From Original Country': 'in_transit', 'Arrived At Transit Airport': 'in_transit',
  'Shipment Depart From Transit Airport': 'in_transit', 'Arrived at Import Airport': 'in_transit',
  'The shipment is picked up by customs broker': 'customs', 'Released From Import Customs': 'in_transit',
  'Pickup from airport': 'in_transit', 'Arrived At The Delivery Company': 'in_transit',
  // Last-mile labels the shared rules miss; the courier's van takes the parcel on board.
  'On Board with Courier': 'out_for_delivery', 'Parcel Unloaded From Container': 'in_transit',
  'Your shipment has arrived at sorting center': 'in_transit', 'Your shipment is in process at sorting center': 'in_transit',
  // Arrival in the destination country, before its sorting and customs, not at the delivery office.
  'Arrived at destination': 'in_transit',
  // CNE's hand-over to the destination network, before that network's own acceptance.
  'Handled by local carrier': 'in_transit',
};
// CNE capitalises the same labels differently ("Arrived At" and "Arrived at").
const WORDING_ANY_CASE: ReadonlyMap<string, Stage> = new Map(Object.entries(WORDING).map(([wording, stage]) => [wording.toLowerCase(), stage]));
// Status codes as CNE's tracking page labels them: 1 and 2 Shipping, 3 Delivered,
// 5 Customs inspection, 6 Invalid address, 7 Lost, 8 Returned, 9 Exception and
// 10 Destroyed. 0 (not sent), 4 (time out) and 99 (unknown) establish nothing.
const CODES: Readonly<Record<string, Stage>> = {
  1: 'in_transit', 2: 'in_transit', 3: 'delivered', 5: 'customs', 6: 'exception',
  7: 'exception', 8: 'returned', 9: 'exception', 10: 'exception',
};
// Last-mile suppliers, by CNE's code, that the catalog tracks directly.
const PARTNERS: Readonly<Record<string, string>> = {
  'DE DHL': 'dhl', 'Royal Mail': 'royal-mail', USPS: 'usps',
};
// CNE's own labels for the destination network's arrival and hand-over, which it
// writes on Beijing time: read so, they fall in the minute of that network's own
// scans of the step. Its other rows abroad can keep the destination's clock.
const BEIJING_LABELS: ReadonlySet<string> = new Set(['arrived at destination', 'handled by local carrier']);
const BEIJING = 'Asia/Shanghai';

export function normalizeCneNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'CNE requires an alphanumeric parcel reference');
  return number;
}

function scanTime(value: string) {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](\d{2}):?(\d{2}))$/i.exec(value);
  if (!match || (match[1] !== undefined && (Number(match[1]) > 14 || Number(match[2]) > 59
    || (Number(match[1]) === 14 && Number(match[2]) !== 0)))) return null;
  return explicitOffsetTime(value);
}

// CNE's clocks name no zone, and its legs cross zones: a valid one stays a
// wall clock in `local_time`, never placed in a zone, unless its label is one
// CNE writes on Beijing time.
function scanClock(value: string, label: string): { time?: string; local_time?: string; provider_time_text?: string } {
  const instant = scanTime(value);
  if (instant) return { time: instant.iso };
  const wall = DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (wall.isValid && wall.toFormat('yyyy-MM-dd HH:mm:ss') === value) {
    const local = wall.toISO({ includeOffset: false, suppressMilliseconds: true });
    // China keeps one offset all year: every valid wall clock is an instant there.
    return BEIJING_LABELS.has(label.toLowerCase()) ? { time: isoTime(local, BEIJING)!.iso } : { local_time: local };
  }
  return value ? { provider_time_text: value } : {};
}

// Last-mile partners write "label；explanation".
const labelOf = (description: string) => description.split('；')[0]!.trim() || description;

export function cneScanStage(description: string, code: string): { stage: Stage; source: string } | undefined {
  // The explanation can announce a later step ("It will be out for delivery"), so only the label is read.
  const label = labelOf(description);
  const exact = WORDING_ANY_CASE.get(description.toLowerCase()) ?? WORDING_ANY_CASE.get(label.toLowerCase());
  if (exact) return { stage: exact, source: 'carrier_map' };
  const worded = classifyWording(label, 'pending');
  // CNE codes a partner's acceptance or pre-advice after the hand-off as
  // shipping: the parcel is in the middle of its journey, not starting it.
  if ((worded.stage === 'accepted' || worded.stage === 'registered') && CODES[code] === 'in_transit') {
    return { stage: 'in_transit', source: 'carrier_map' };
  }
  if (worded.source !== 'none') return worded;
  // A partner's own wording that no rule knows still carries CNE's code.
  return CODES[code] ? { stage: CODES[code], source: 'carrier_map' } : undefined;
}

function scan(raw: unknown): CarrierEvent {
  if (!isRecord(raw) || !clean(raw.details, 1000)) throw new SchemaError(PROVIDER, 'CNE returned an invalid movement');
  const description = clean(raw.details, 1000), clock = clean(raw.date, 64);
  const location = clean(raw.place, 200), code = cleanScalar(raw.state);
  const mapped = cneScanStage(description, code);
  return { description, ...(location ? { location } : {}), ...scanClock(clock, labelOf(description)),
    ...(mapped ? { stage: mapped.stage, stage_source: mapped.source } : {}),
    ...(code ? { provider_code: code } : {}) };
}

export function parseCne(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCneNumber(raw);
  if (!isRecord(payload) || typeof payload.ReturnValue !== 'number') throw new SchemaError(PROVIDER, 'CNE returned an invalid envelope');
  if (payload.ReturnValue !== 1) {
    if (payload.ReturnValue === 0 && payload.cMess === '订单不存在'
      && payload.Response_Info === undefined && payload.trackingEventList === undefined) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'CNE did not complete the lookup');
  }
  const identity = payload.Response_Info;
  if (!isRecord(identity) || clean(identity.trackingNbr) !== number) throw new SchemaError(PROVIDER, 'CNE returned a different shipment');
  // Number_t echoes the source number or, once a last-mile supplier is named,
  // the transfer number that supplier tracks. Anything else is another shipment.
  const transfer = clean(identity.transNbr, 64);
  const echoed = identity.Number_t === undefined ? number : clean(identity.Number_t, 64);
  if (echoed !== number && (!transfer || echoed !== transfer)) throw new SchemaError(PROVIDER, 'CNE returned conflicting shipment identifiers');
  if (!Array.isArray(payload.trackingEventList) || payload.trackingEventList.length > 1000) throw new SchemaError(PROVIDER, 'CNE returned an invalid history');
  if (!payload.trackingEventList.length) throw new IndeterminateError(PROVIDER, 'CNE returned no shipment movements');
  // The official client reverses the oldest-first array. Preserve that order
  // even when its unqualified cross-border clocks cannot resolve to instants.
  const events = payload.trackingEventList.map(scan).reverse();
  const latest = events[0]!;
  // A terminal or blocking summary outranks the latest row, which can stop at
  // the hand-off to the last-mile partner. Shipping defers to the rows.
  const summaryCode = cleanScalar(identity.status);
  const summaryStage = summaryCode !== '1' && summaryCode !== '2' ? CODES[summaryCode] : undefined;
  const stage = summaryStage ?? latest.stage;
  const source = summaryStage ? 'carrier_map' : latest.stage_source;
  const country = clean(identity.Destination, 64).toUpperCase();
  // A named supplier declares the hand-off. Without one, transNbr can be a
  // merchant's reference, and referNbr always is: neither is followed.
  const supplier = isRecord(payload.lastMileSupplier) ? clean(payload.lastMileSupplier.code, 64) : '';
  const partner = supplier ? PARTNERS[supplier] : undefined;
  const handoff = supplier && echoed === transfer && transfer !== number && /^[A-Z0-9]{4,40}$/.test(transfer) ? transfer : '';
  // The supplier tracks its transfer number, not CNE's: without one, nobody is named to ask.
  return { status: stage ? languageStageStatus(stage as Stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(typeof latest.local_time === 'string' ? { last_update_local: latest.local_time } : {}),
    ...(stage === 'delivered' && latest.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(partner && handoff ? { delivery_carrier: partner } : {}), ...(handoff ? { delivery_tracking_number: handoff } : {}),
    events: events.slice(0, 100) };
}
