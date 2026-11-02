import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { countryCode, epochMillisTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { HANDOFF, speedpakEnglish, speedpakScanStatus } from './status.js';
import { speedpakPlace, withoutRoutingPrefix } from './wording.js';

const PROVIDER = 'SpeedPAK';
// A partner's departure for the destination country, which a scan with no city of its own places in that country.
const DEPARTURE_TO_DESTINATION = /^departure to (?:the )?country of destination\b/i;

export function normalizeSpeedpakNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^E[ES][A-Z0-9]{26}$/.test(number)) throw new InvalidInputError(PROVIDER, 'SpeedPAK requires a 28-character EE or ES tracking number');
  return number;
}

export function parseSpeedpak(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeSpeedpakNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'SpeedPAK did not complete the tracking lookup');
  const result = payload.result;
  if (!isRecord(result) || !Array.isArray(result.waybills) || !Array.isArray(result.notExistsTrackingNumbers)) {
    throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid shipment list');
  }
  if (result.waybills.length === 0) {
    if (result.notExistsTrackingNumbers.length === 1 && clean(result.notExistsTrackingNumbers[0]) === number) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'SpeedPAK returned no identity-bound shipment');
  }
  if (result.waybills.length !== 1 || result.notExistsTrackingNumbers.length) throw new SchemaError(PROVIDER, 'SpeedPAK returned ambiguous shipments');
  const shipment: unknown = result.waybills[0];
  if (!isRecord(shipment) || clean(shipment.trackingNumber) !== number) throw new SchemaError(PROVIDER, 'SpeedPAK returned a different shipment');
  if (!Array.isArray(shipment.traces) || shipment.traces.length > 1000) throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid history');
  if (!shipment.traces.length) throw new IndeterminateError(PROVIDER, 'SpeedPAK returned no shipment activity');
  const events: CarrierEvent[] = [];
  const handoffs = new Map<string, string>();
  for (const row of shipment.traces) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SpeedPAK returned an invalid history row');
    const description = withoutRoutingPrefix(clean(row.eventDesc));
    if (!description) throw new SchemaError(PROVIDER, 'SpeedPAK returned an empty scan description');
    const time = epochMillisTime(row.oprTimestamp);
    const mapped = speedpakScanStatus(description, clean(row.eventDescCn));
    const place = speedpakPlace(clean(row.oprCity), clean(row.oprCountry));
    // That country is where the parcel goes, not where it was.
    const location = DEPARTURE_TO_DESTINATION.test(description) && place === clean(row.oprCountry) ? '' : place;
    for (const text of [description, withoutRoutingPrefix(clean(row.eventDescCn))]) {
      const handoff = HANDOFF.exec(text);
      if (handoff) handoffs.set(handoff[2]!, handoff[1]!.trim());
    }
    const event: CarrierEvent = { description: speedpakEnglish(description) ?? description, ...(time ? { time: time.iso } : { provider_time_text: clean(row.oprTime) || undefined }),
      ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
    if (!events.some(previous => JSON.stringify(previous) === JSON.stringify(event))) events.push(event);
  }
  // The website's trace array is already newest first. Keep undated scans in
  // that order rather than borrowing an older timestamp for the summary.
  const summary = withoutRoutingPrefix(clean(shipment.lastStatus));
  const wording = (summary && (speedpakEnglish(summary) ?? summary)) || events[0]!.description!;
  const mapped = speedpakScanStatus(wording, clean(shipment.lastStatusCn));
  const latest = events[0]!;
  const output: CarrierResult = { status: mapped?.status ?? 'unknown', last_status_text: wording, last_update: latest.time ?? null,
    ...(mapped ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' } : {}),
    ...(mapped?.stage === 'delivered' && latest.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    events: events.slice(0, 100) };
  const country = countryCode(shipment.consigneeCountryCode);
  if (country) output.destination_country = country;
  if (handoffs.size === 1) {
    const [reference, name] = [...handoffs][0]!;
    // Named only when the catalog knows the carrier and its detection offers the reference.
    const partner = carrierIdFromPartner(name);
    if (partner && partner !== 'speedpak' && (detectCarrierMatch(reference).candidates as string[]).includes(partner)) {
      output.delivery_carrier = partner;
    }
    output.delivery_tracking_number = reference;
  }
  return output;
}
