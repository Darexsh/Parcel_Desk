import { DateTime } from 'luxon';
import type { CarrierEvent } from '../../core/result/index.js';
import { EXPLICIT_OFFSET_PATTERN } from '../../core/time/index.js';
import type { Stage } from '../../generated/catalog.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { event, place, text } from '../shared/result.js';
import { SUB_STAGES, subStatusStage } from './status.js';

/**
 * A scan the carrier did not date. Besides leaving both readings empty,
 * 17TRACK can write a placeholder such as `01.01.2000, 00:00` into `time_iso`
 * of a scan whose raw clock has no date (DPD Germany's rows for a parcel
 * from abroad); `time_utc` is then empty too.
 */
export function undatedScan(raw: JsonObject): boolean {
  if (raw.time_utc != null) return false;
  return raw.time_iso == null || (isRecord(raw.time_raw) && raw.time_raw.date === null
    && !(typeof raw.time_iso === 'string' && EXPLICIT_OFFSET_PATTERN.test(raw.time_iso)));
}

/**
 * 17TRACK's two readings of a scan usually name one instant. When they
 * disagree, `time_iso` is the clock and offset 17TRACK shows: on India Post's
 * legs `time_utc` lands 30 minutes after it, on scans India Post itself dates.
 */
function scanTime(raw: JsonObject): unknown {
  const { time_utc: utc, time_iso: iso } = raw;
  if (typeof utc === 'string' && typeof iso === 'string' && EXPLICIT_OFFSET_PATTERN.test(iso)) {
    const shown = DateTime.fromISO(iso, { setZone: true });
    const converted = DateTime.fromISO(utc, { setZone: true });
    if (shown.isValid && converted.isValid && shown.toMillis() !== converted.toMillis()) return iso;
  }
  return utc ?? iso;
}

/**
 * Keep scan codes/operator and the origin of 17TRACK's converted timestamp.
 * `placed` is the instant a caller read from the facility's own clock instead.
 */
export function seventeenTrackEvent(raw: JsonObject, operator: JsonObject, placed?: string): CarrierEvent | null {
  // Some completed responses contain undated explanatory rows alongside real
  // scans. Skip only absent dates; malformed nonempty timestamps still fail.
  if (!placed && undatedScan(raw)) return null;
  const time = placed ?? scanTime(raw);
  const code = text(raw.sub_status);
  // Information received is left to the code, which yields only to a scan filed under it.
  const declared = code === 'InfoReceived' ? undefined : raw.stage ?? (Object.hasOwn(SUB_STAGES, code) ? code.split('_')[0] : undefined);
  const parsed = event(time, raw.description, declared);
  if (!parsed) return null;
  const coded = subStatusStage(code, parsed.stage as Stage, parsed.description);
  // A stage the code gives comes from 17TRACK's map, even where its stage name was not one the wording rules read.
  if (coded) Object.assign(parsed, { stage: coded, stage_source: 'carrier_map' });
  // 17TRACK's generic transit bucket loses Swiss Post's delivery-round scan, and
  // its "Registered", the sender's data before Swiss Post has the item, as its
  // own REGISTERED status reads. Refine only that operator's precise native
  // labels; keep their original code.
  if (code === 'InTransit_Other' && operator.reporting_carrier === 'Swiss Post') {
    const label = text(raw.description).toLowerCase();
    if (label === 'loading into delivery vehicle') parsed.stage = 'out_for_delivery';
    else if (label === 'registered') parsed.stage = 'registered';
  }
  if (parsed.stage === 'delivered') parsed.description = 'Delivered';
  const timeRaw = isRecord(raw.time_raw) ? raw.time_raw : null;
  // `address` is never read: it can be the recipient's street.
  const location = place(raw.location);
  return {
    ...parsed,
    ...(location ? { location } : {}),
    ...(code && /^[A-Za-z_]{1,80}$/.test(code) ? { provider_code: code } : {}),
    ...operator,
    ...(typeof raw.time_iso === 'string' ? { provider_time_iso: raw.time_iso } : {}),
    // An inferred offset remains provider-converted time, not independent
    // evidence that China Post knows the destination's local timezone.
    time_provenance: timeRaw?.timezone === null ? 'provider_inferred'
      : typeof timeRaw?.timezone === 'string' ? 'carrier_reported' : 'unspecified',
  };
}
