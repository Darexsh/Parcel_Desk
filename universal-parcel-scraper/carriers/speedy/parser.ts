import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { speedyPlace } from './place.js';
import { CONTENTS_CHECK_CODES, speedyOperation, speedyPhase } from './status.js';

export const PROVIDER = 'Speedy';
export const SPEEDY_MAX_BYTES = 512_000;

/** Speedy's shipment and parcel numbers are eleven digits. */
export function normalizeSpeedyNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{11}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Speedy shipment numbers are eleven digits');
  return number;
}

// MySpeedy's "the requested resource does not exist" page. The public tracker
// shows it as an invalid shipment number; a removed route returns it too.
const MISSING_PAGE = /Заявеният ресурс не съществува/;
// The managed challenge www.speedy.bg answers with; MySpeedy's own pages only load Cloudflare's passive script.
const CHALLENGE_PAGE = /<title>\s*Just a moment|_cf_chl_opt|cf-turnstile/i;

// Delivery partners Speedy and DPD Romania name for a receiving leg, by their name for them.
const PARTNERS: Readonly<Record<string, string>> = { ACS: 'acs-courier' };

// An estimate is kept while the parcel is still on its way to the recipient.
const ON_THE_WAY = new Set<Stage>(['registered', 'accepted', 'in_transit', 'out_for_delivery', 'customs']);

/** Read one reply of the public track endpoint: a shipment, a missing one, or a failure of its own kind. */
export function parseSpeedyReply(status: number, body: string, rawNumber: string): CarrierResult {
  if (status === 404) {
    if (MISSING_PAGE.test(body)) throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'Speedy tracking endpoint is unavailable');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Speedy answered with a browser challenge', { cause });
    throw new SchemaError(PROVIDER, 'Speedy returned invalid tracking JSON', { cause });
  }
  return parseSpeedy(payload, rawNumber);
}

const comments = (row: Record<string, unknown>) =>
  (Array.isArray(row.comments) ? row.comments.slice(0, 20) : []).filter(isRecord);

/** The "Expected Delivery Date: DD.MM.YYYY" note on a scan, as an ISO day. */
function estimateOf(row: Record<string, unknown>): string | null {
  for (const comment of comments(row)) {
    const match = /^Expected Delivery Date:\s*(\d{2})\.(\d{2})\.(\d{4})$/i.exec(clean(comment.text, 64));
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  }
  return null;
}

/** The office or locker a scan names through its office-map link: its name only, never its address. */
function officeOf(row: Record<string, unknown>): string {
  const office = comments(row).find(comment => /^https:\/\/services\.speedy\.bg\/officesmap/i.test(clean(comment.url, 300)));
  return office ? clean(office.text, 160) : '';
}

/** The partner a reply's `externalCarriermappings` names for the receiving leg, with its number, when it is one that can be asked. */
export function speedyDeliveryPartner(mappings: unknown, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (!Array.isArray(mappings)) return {};
  for (const mapping of mappings.slice(0, 10)) {
    if (!isRecord(mapping) || mapping.mappingFor !== 'RECEIVER') continue;
    const carrier = PARTNERS[clean(mapping.externalCarrier, 32)];
    const reference = returnedTrackingNumber(mapping.barcode, true);
    if (carrier && /^[A-Z0-9]{4,40}$/.test(reference) && reference !== number) {
      return { delivery_carrier: carrier, delivery_tracking_number: reference };
    }
  }
  return {};
}

export function parseSpeedy(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeSpeedyNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.events) || payload.events.length > 300) throw new SchemaError(PROVIDER);
  if (cleanScalar(payload.barcode, 32) !== number) throw new SchemaError(PROVIDER, 'Speedy did not identify the requested shipment');
  const info = isRecord(payload.info) ? payload.info : {};

  const scans: { event: CarrierEvent; at: number; row: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const row of payload.events) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Speedy returned an incomplete scan');
    const code = /^-?\d{1,6}$/.test(cleanScalar(row.operationCode, 8)) ? cleanScalar(row.operationCode, 8) : '';
    const at = explicitOffsetTime(row.dateTime);
    if (!code || !at) throw new SchemaError(PROVIDER, 'Speedy returned a scan without a code or clock');
    const { wording, stage } = speedyOperation(code);
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
  const phase = speedyPhase(phaseCode);
  if (!events.length && !phase) throw new SchemaError(PROVIDER, 'Speedy returned a shipment without scans or a known phase');
  const staged = events.find(event => event.stage);
  const stage = (staged ? staged.stage : phase?.stage) as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;

  // The office or locker the parcel waits at, or was collected from: the
  // newest one Speedy prepared it at, when nothing moved it after that.
  const deliveredIndex = delivered ? events.indexOf(delivered) : -1;
  const collected = deliveredIndex >= 0
    && lastMovement(events.slice(deliveredIndex + 1).filter(event => !CONTENTS_CHECK_CODES.has(event.provider_code ?? ''))) === 'ready_for_pickup';
  const prepared = stage === 'ready_for_pickup' || collected ? ordered.find(({ event }) => event.provider_code === '134') : undefined;
  const pickupPoint = prepared ? officeOf(prepared.row) : '';

  const estimate = stage && ON_THE_WAY.has(stage) ? ordered.map(({ row }) => estimateOf(row)).find(Boolean) ?? null : null;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]?.description ?? phase!.wording,
    ...(events.length ? {} : { provider_code: phaseCode, summary_only: true }),
    last_update: events[0]?.time ?? null,
    expected_delivery: estimate,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...speedyDeliveryPartner(payload.externalCarriermappings, number),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
