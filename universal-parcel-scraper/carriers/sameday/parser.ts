import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { samedayCode, samedayStage } from './status.js';

export const PROVIDER = 'Sameday';
const MAX_PARCELS = 200;
const MAX_SCANS = 500;
const MAX_EVENTS = 100;
const NUMBER = /^[A-Z0-9]{5,28}$/;
// A page asking for a verification instead of the JSON reply.
const VERIFICATION = /captcha|turnstile|cf-chl|just a moment|attention required|access denied/i;

/** The site's own check: it drops a leading # and takes 5 to 28 characters. */
export function normalizeSamedayNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw).replace(/^#/, '');
  if (!NUMBER.test(number) || !/\d/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Sameday requires an AWB or parcel number of 5 to 28 letters and digits');
  }
  return number;
}

interface Scan {
  event: CarrierEvent;
  instant: number;
  state: string;
  status: string;
  stateWording: string;
  inReturn: boolean;
}

function scan(raw: unknown, parcel: string | null): Scan {
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Sameday returned an invalid scan');
  if (parcel !== null && raw.parcelAwbNumber != null && clean(raw.parcelAwbNumber, 40).toUpperCase() !== parcel) {
    throw new SchemaError(PROVIDER, 'Sameday returned a scan of another parcel');
  }
  const time = explicitOffsetTime(raw.statusDate);
  if (!time) throw new SchemaError(PROVIDER, 'Sameday returned a scan without an offset clock');
  const state = cleanScalar(raw.statusStateId, 8);
  const status = cleanScalar(raw.statusId, 8);
  if (!/^\d{1,6}$/.test(state) || !/^\d{1,8}$/.test(status)) throw new SchemaError(PROVIDER, 'Sameday returned a scan without its codes');
  const stateWording = clean(raw.statusState, 300);
  const description = clean(raw.status, 500) || stateWording;
  if (!description) throw new SchemaError(PROVIDER, 'Sameday returned a scan without wording');
  // The site shows the county and country of the scan, and nothing without a county.
  const county = clean(raw.county, 100);
  const location = county ? [county, clean(raw.country, 100)].filter(Boolean).join(', ') : '';
  return {
    event: { time: time.iso, description, ...(location ? { location } : {}), provider_code: samedayCode(state, status) },
    instant: time.timestamp, state, status, stateWording, inReturn: raw.inReturn === true,
  };
}

/**
 * A history reply, bound to the requested number: the AWB itself, or one of
 * its parcels (the AWB and a three-digit suffix), which the API answers with
 * the whole AWB. A parcel reads its own scans; an AWB with one parcel reads
 * that parcel's, as the site shows them; an AWB with several reads the AWB's
 * history.
 */
export function parseSamedayHistory(payload: Record<string, unknown>, requested: string): CarrierResult {
  const number = normalizeSamedayNumber(requested);
  const awb = clean(payload.awbNumber, 40).toUpperCase();
  const parcels = payload.parcelsList;
  const history = payload.awbHistory;
  if (!NUMBER.test(awb) || !isRecord(parcels) || Object.keys(parcels).length > MAX_PARCELS
    || !Array.isArray(history) || history.length > MAX_SCANS) {
    throw new SchemaError(PROVIDER, 'Sameday returned an incomplete tracking reply');
  }
  let parcel: string | null = null;
  if (awb === number) {
    const keys = Object.keys(parcels);
    if (keys.length === 1) parcel = keys[0]!;
  } else if (Object.hasOwn(parcels, number)) {
    parcel = number;
  } else {
    throw new SchemaError(PROVIDER, 'Sameday returned another shipment');
  }
  let rows: unknown = parcel === null ? history : parcels[parcel];
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Sameday returned an invalid scan list');
  // An AWB whose only parcel has no scans yet still has the AWB's own.
  if (!rows.length && awb === number) {
    rows = history;
    parcel = null;
  }
  const list = rows as unknown[];
  if (!list.length) throw new IndeterminateError(PROVIDER, 'Sameday returned no scans for the shipment');

  const scans = list.map((row) => scan(row, parcel));
  // Parcel lists come oldest first and the AWB's history newest first; equal
  // clocks keep their order once both read newest first.
  if (scans.length > 1 && scans[0]!.instant < scans.at(-1)!.instant) scans.reverse();
  scans.sort((left, right) => right.instant - left.instant);
  const seen = new Set<string>();
  const unique = scans.filter(({ event }) => {
    const key = JSON.stringify([event.time, event.description, event.location, event.provider_code]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The AWB's return flag is the site's reading of its current state.
  if (payload.isReturn === true) unique[0]!.inReturn = true;

  // Oldest first: an instruction keeps the stage the scans before it set,
  // without becoming the parcel's stage.
  let current: { scan: Scan; stage: ClassifiedWording } | null = null;
  for (const row of [...unique].reverse()) {
    const mapped = samedayStage(row.state, row.status, row.inReturn, row.event.description!, row.stateWording);
    const stage = mapped ?? { stage: current?.stage.stage ?? 'pending', source: 'none' };
    Object.assign(row.event, { stage: stage.stage, stage_source: stage.source });
    if (mapped) current = { scan: row, stage: mapped };
  }
  const settled: ClassifiedWording = current?.stage ?? { stage: 'pending', source: 'none' };
  const latest = unique[0]!.event;
  return {
    status: languageStageStatus(settled.stage),
    current_stage: settled.stage,
    current_stage_source: settled.source,
    last_status_text: latest.description ?? null,
    last_update: latest.time ?? null,
    ...(settled.stage === 'delivered' && current ? { delivered_at: current.scan.event.time ?? null } : {}),
    expected_delivery: null,
    ...(awb !== number ? { canonical_tracking_number: awb } : {}),
    events: unique.slice(0, MAX_EVENTS).map(({ event }) => event),
  };
}

/**
 * One country's reply to the history request. Null when that country's
 * network does not know the number: its JSON 404. A page instead of JSON is a
 * verification or a block, never a missing parcel.
 */
export function parseSamedayReply(status: number, text: string, requested: string): CarrierResult | null {
  const number = normalizeSamedayNumber(requested);
  const body = text.replace(/^\uFEFF/, '').trim();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (VERIFICATION.test(body.slice(0, 5_000)) || (status === 200 && body.startsWith('<'))) {
      throw new ChallengeError(PROVIDER, 'Sameday answered with a web page instead of tracking data', { cause });
    }
    throw new SchemaError(PROVIDER, 'Sameday returned invalid tracking JSON', { cause });
  }
  if (status === 404) {
    if (isRecord(payload) && isRecord(payload.error) && payload.error.code === 404) return null;
    throw new SchemaError(PROVIDER, 'Sameday returned an unexpected not-found reply');
  }
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (payload.error != null) throw new IndeterminateError(PROVIDER, 'Sameday returned an inconclusive tracking reply');
  return parseSamedayHistory(payload, number);
}
