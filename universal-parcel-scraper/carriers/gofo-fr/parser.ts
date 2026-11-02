import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isRegionalGofoNumber, isRegionalGofoWaybill, type GofoRegion } from '../../core/detection/gofo.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { gofoFranceStage } from './status.js';

export { regionalGofoRequestNumber, type GofoRegion } from '../../core/detection/gofo.js';

/** The national waybill families the official support pages describe. */
export function normalizeRegionalGofoNumber(raw: string, region: GofoRegion): string {
  const number = normalizeTrackingNumber(raw);
  if (!isRegionalGofoNumber(number, region)) {
    throw new InvalidInputError(`GOFO ${region}`, 'GOFO requires a supported whole shipment identifier');
  }
  return number;
}

export const normalizeGofoFranceNumber = (raw: string) => normalizeRegionalGofoNumber(raw, 'FR');

function identity(value: unknown, provider: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{3,39}$/.test(value.trim()) || !/\d/.test(value)) {
    throw new SchemaError(provider, 'GOFO returned an invalid shipment identifier');
  }
  return normalizeTrackingNumber(value.trim());
}

/** The shipper's reference is free text the official client shows only when present. */
function shipperReference(value: unknown, provider: string): string | undefined {
  if (value != null && typeof value !== 'string') throw new SchemaError(provider, 'GOFO returned an invalid shipper reference');
  const text = clean(value, 100);
  return text ? normalizeTrackingNumber(text) : undefined;
}

function scanClock(value: unknown, provider: string): Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string } {
  if (value == null || value === '') return {};
  if (typeof value !== 'string') throw new SchemaError(provider, 'GOFO returned a non-text scan clock');
  const raw = clean(value, 64);
  const match = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?)(Z|[+-](?:0\d|1[0-4]):?[0-5]\d)?$/.exec(raw);
  if (!match) {
    if (raw.includes('T') && /(?:Z|[+-][\d:]+)$/i.test(raw)) throw new SchemaError(provider, 'GOFO returned an invalid scan timestamp');
    return raw ? { provider_time_text: raw } : {};
  }
  const local = DateTime.fromISO(match[1]!, { zone: 'UTC' });
  if (!local.isValid) throw new SchemaError(provider, 'GOFO returned an invalid scan date');
  if (!match[2]) return { local_time: local.toISO({ includeOffset: false, suppressMilliseconds: true }) };
  const offset = match[2].replace(':', '');
  if (offset !== 'Z' && Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3)) > 840) {
    throw new SchemaError(provider, 'GOFO returned an invalid scan offset');
  }
  const instant = explicitOffsetTime(raw);
  if (!instant) throw new SchemaError(provider, 'GOFO returned an invalid scan timestamp');
  return { time: instant.iso };
}

const DELIVERED: Record<GofoRegion, string> = { FR: 'Livré', IT: 'Consegnato', NL: 'Bezorgd', ES: 'Entregado' };
// GOFO can name a hub by a code rather than a town: "GOFO-" and its province's letters
// ("GOFO-NA" near Naples), or in Italy the province's letters and the hub's own ("FI-ARS"
// in Florence's) and in France the department's number and the hub's ("75-LED"). A French
// town can be written alike ("ST-LO"). Such a code, or the country alone, is no place.
const HUB_CODES: Record<GofoRegion, RegExp> = {
  FR: /^(?:GOFO|\d{2})-[A-Z0-9]{2,4}$/, IT: /^(?:GOFO|[A-Z]{2})-[A-Z0-9]{2,4}$/, NL: /^GOFO-[A-Z0-9]{2,4}$/, ES: /^GOFO-[A-Z0-9]{2,4}$/,
};
// Lowercase between the words of a French town's name: "Champagne-sur-Seine", "L'Isle-d'Abeau".
const FRENCH_PARTICLES = new Set(['au', 'aux', 'd', 'de', 'des', 'du', 'en', 'et', 'l', 'la', 'le', 'les', 'lès', 'lez', 'sous', 'sur']);

/**
 * A GOFO scan's place as the adapter gives it: none for a hub's code or the country alone, and a
 * French town some scans write in capitals ("MARSEILLE") in the case its other scans use.
 */
export function gofoPlace(location: string, region: GofoRegion): string {
  const place = location.trim();
  if (place === region || HUB_CODES[region].test(place)) return '';
  if (region !== 'FR' || /\p{Ll}/u.test(place)) return place;
  return place.toLocaleLowerCase('fr-FR').replace(/\p{L}+/gu, (word: string, offset: number, lower: string) => (
    FRENCH_PARTICLES.has(word) && !/(?:^|,)\s*$/.test(lower.slice(0, offset)) ? word : word[0]!.toLocaleUpperCase('fr-FR') + word.slice(1)));
}

export function parseRegionalGofo(payload: unknown, rawNumber: string, region: GofoRegion,
  stageOf: (code: string, description: string) => Stage | undefined): CarrierResult {
  const provider = `GOFO ${region}`;
  const number = normalizeRegionalGofoNumber(rawNumber, region);
  if (!isRecord(payload)) throw new SchemaError(provider);
  if (payload.code !== 200) throw new IndeterminateError(provider, 'GOFO returned an unsuccessful tracking response');
  if (!Array.isArray(payload.data) || !payload.data.every(isRecord)) throw new SchemaError(provider);
  // The API answers an empty list for any number it has no scans for, a label
  // not yet scanned or one never issued: an answer about the number, not an
  // outage, and not a not-found.
  if (!payload.data.length) throw new NoHistoryError(provider, 'GOFO returned no matching parcel history');
  if (payload.data.length !== 1) throw new SchemaError(provider, 'GOFO returned ambiguous parcel history');
  const item = payload.data[0]!;
  const waybill = identity(item.waybillNo, provider);
  const reference = shipperReference(item.trackingNumber, provider);
  if (!isRegionalGofoWaybill(waybill, region) || waybill !== number && reference !== number
    || reference && /^(?:GF|CI)(?:US|FR|IT|NL|ES)/.test(reference) && (!isRegionalGofoWaybill(reference, region) || reference !== waybill)) {
    throw new SchemaError(provider, 'GOFO returned a different parcel or national network');
  }
  if (countryCode(item.toCountry) !== region) throw new SchemaError(provider, 'GOFO returned a parcel outside the national service');
  if (!Array.isArray(item.trackEventList) || !item.trackEventList.every(isRecord) || item.trackEventList.length > 500) throw new SchemaError(provider);
  const rows = item.trackEventList;
  if (!rows.length) throw new NoHistoryError(provider, 'GOFO lists the parcel without scans');
  if (!Number.isInteger(item.trackEventCount) || Number(item.trackEventCount) < rows.length || Number(item.trackEventCount) > 500) {
    throw new IndeterminateError(provider, 'GOFO returned an inconsistent scan count');
  }
  const summary = item.lastTrackEvent;
  if (!isRecord(summary) || ['processCode', 'processDate', 'processContent', 'mainContent', 'processLocation']
    .some(field => summary[field] !== rows[0]![field])) {
    throw new IndeterminateError(provider, 'GOFO latest summary does not match its first scan');
  }
  const events: CarrierEvent[] = [], seen = new Set<string>();
  // The regional clients render the latest-first list as returned. Equal or
  // unresolved clocks keep this order instead of acquiring an invented zone.
  for (const row of rows) {
    const rowReference = shipperReference(row.trackingNumber, provider);
    if (row.waybillNo != null && identity(row.waybillNo, provider) !== waybill || rowReference && rowReference !== reference) {
      throw new SchemaError(provider, 'GOFO returned a scan for a different parcel');
    }
    const code = cleanScalar(row.processCode, 32);
    if (row.mainContent != null && typeof row.mainContent !== 'string' || row.processContent != null && typeof row.processContent !== 'string'
      || row.processLocation != null && typeof row.processLocation !== 'string') throw new SchemaError(provider, 'GOFO returned an invalid scan field');
    const wording = clean(row.mainContent || row.processContent, 500);
    if (!code || !wording) throw new SchemaError(provider, 'GOFO returned an incomplete scan');
    const stage = stageOf(code, wording);
    if (code === '205' && stage !== 'delivered') throw new IndeterminateError(provider, 'GOFO returned contradictory delivery wording');
    // Delivery prose can embed recipient details. Keep its milestone alone;
    // subContent, notices, POD data and unrelated references are not projected.
    const description = code === '205' ? DELIVERED[region] : wording;
    const location = gofoPlace(clean(row.processLocation, 160), region);
    const event: CarrierEvent = { ...scanClock(row.processDate, provider), description, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!, stage = latest.stage as Stage | undefined;
  const service = clean(item.serviceName, 80);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: null, destination_country: region, canonical_tracking_number: waybill,
    ...(stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}), ...(service ? { service_name: service } : {}),
    ...(Number(item.trackEventCount) > rows.length || events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}

export const parseGofoFrance = (payload: unknown, number: string) => parseRegionalGofo(payload, number, 'FR', gofoFranceStage);
