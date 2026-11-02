import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { speedyDeliveryPartner } from '../speedy/parser.js';
import { speedyPlace } from '../speedy/place.js';
import { dpdRoOperation, dpdRoPhase } from './status.js';

export const PROVIDER = 'DPD Romania';
export const DPD_RO_MAX_BYTES = 512_000;

/** DPD Romania's waybills, return waybills included, are eleven digits starting with 8. */
export function normalizeDpdRoNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^8\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'DPD Romania waybills are eleven digits starting with 8');
  return number;
}

// MyDPD's "the specified options were not found" page, which the endpoint
// answers for a waybill it does not know; a removed route returns it too.
const MISSING_PAGE = /Optiunile specificate nu au fost gasite/;
// Cloudflare's interstitial. MyDPD's own pages load Cloudflare's passive
// script, and its sign-in page a Turnstile widget, so neither marks a challenge.
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Un instant)|_cf_chl_opt/i;

// An estimate is kept while the parcel is still on its way to the recipient.
const ON_THE_WAY = new Set<Stage>(['registered', 'accepted', 'in_transit', 'out_for_delivery', 'customs']);

/** Read one reply of the public track endpoint: a shipment, a missing one, or a failure of its own kind. */
export function parseDpdRoReply(status: number, body: string, rawNumber: string): CarrierResult {
  if (status === 404) {
    if (MISSING_PAGE.test(body)) throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'DPD Romania tracking endpoint is unavailable');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DPD Romania answered with a browser challenge', { cause });
    throw new SchemaError(PROVIDER, 'DPD Romania returned invalid tracking JSON', { cause });
  }
  return parseDpdRo(payload, rawNumber);
}

/** The "Expected Delivery Date: DD.MM.YYYY" note on a scan, as an ISO day. Other notes are dropped. */
function estimateOf(row: Record<string, unknown>): string | null {
  for (const comment of (Array.isArray(row.comments) ? row.comments.slice(0, 20) : []).filter(isRecord)) {
    const match = /^Expected Delivery Date:\s*(\d{2})\.(\d{2})\.(\d{4})$/i.exec(clean(comment.text, 64));
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  }
  return null;
}

export function parseDpdRo(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDpdRoNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.events) || payload.events.length > 300) throw new SchemaError(PROVIDER);
  if (cleanScalar(payload.barcode, 32) !== number) throw new SchemaError(PROVIDER, 'DPD Romania did not identify the requested waybill');
  const info = isRecord(payload.info) ? payload.info : {};

  const scans: { event: CarrierEvent; at: number; row: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const row of payload.events) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DPD Romania returned an incomplete scan');
    const code = /^-?\d{1,6}$/.test(cleanScalar(row.operationCode, 8)) ? cleanScalar(row.operationCode, 8) : '';
    const at = explicitOffsetTime(row.dateTime);
    if (!code || !at) throw new SchemaError(PROVIDER, 'DPD Romania returned a scan without a code or clock');
    const { wording, stage } = dpdRoOperation(code);
    const location = speedyPlace(row.place);
    const event: CarrierEvent = { time: at.iso, description: clean(row.description, 200) || wording, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); scans.push({ event, at: at.timestamp, row }); }
  }
  // The reply lists scans oldest first; equal clocks keep their order, reversed.
  const ordered = scans.map((scan, index) => ({ ...scan, index }))
    .sort((left, right) => right.at - left.at || right.index - left.index);
  const events = ordered.map(({ event }) => event);

  const phaseCode = clean(info.phase, 64);
  const phase = dpdRoPhase(phaseCode);
  if (!events.length && !phase) throw new SchemaError(PROVIDER, 'DPD Romania returned a shipment without scans or a known phase');
  const staged = events.find(event => event.stage);
  const stage = (staged ? staged.stage : phase?.stage) as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  const estimate = stage && ON_THE_WAY.has(stage) ? ordered.map(({ row }) => estimateOf(row)).find(Boolean) ?? null : null;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]?.description ?? phase!.wording,
    ...(events.length ? {} : { provider_code: phaseCode, summary_only: true }),
    last_update: events[0]?.time ?? null,
    expected_delivery: estimate,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    // Parcels for Cyprus, Shein's and Temu's among them, go on to ACS under its own number.
    ...speedyDeliveryPartner(payload.externalCarriermappings, number),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
