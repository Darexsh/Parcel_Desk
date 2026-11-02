import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { omgoStage } from './status.js';

export const OMGO_MAX_BYTES = 1_000_000;
export const OMGO_ENDPOINT = 'https://omgoexpress.cn/wp-admin/admin-ajax.php';
const PROVIDER = 'OMGO';
const challenge = (text: string) => /<title>\s*Just a moment|cf-chl-|challenge-platform|cf-turnstile/i.test(text);

export function normalizeOmgoNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^OMGO\d{13}$/.test(number)) throw new InvalidInputError(PROVIDER, 'OMGO requires OMGO followed by thirteen digits');
  return number;
}

/** Read the page-issued value as JSON, without executing its scripts or trusting a new destination. */
export function parseOmgoNonce(html: string): string {
  if (challenge(html)) throw new ChallengeError(PROVIDER);
  if (new TextEncoder().encode(html).length > OMGO_MAX_BYTES) throw new SchemaError(PROVIDER, 'OMGO returned an excessive tracking page');
  const matches = [...html.matchAll(/\bvar\s+shiAjax\s*=\s*(\{[^;]*?\});/g)];
  let config: unknown;
  try { config = matches.length === 1 ? JSON.parse(matches[0]![1]!) : undefined; } catch { /* Invalid bootstrap is schema drift. */ }
  if (!isRecord(config) || config.ajax_url !== OMGO_ENDPOINT || typeof config.nonce !== 'string' || !/^[a-f0-9]{10}$/i.test(config.nonce)) {
    throw new SchemaError(PROVIDER, 'OMGO returned invalid tracking page configuration');
  }
  return config.nonce;
}

function clock(value: unknown): { time?: string; local_time?: string; provider_time_text?: string } {
  if (value == null || value === '') return {};
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, 'OMGO returned an invalid scan clock');
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(raw)) {
    const instant = explicitOffsetTime(raw.replace(' ', 'T'));
    if (instant) return { time: instant.iso };
  }
  if (/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)) {
    const local = raw.replace(' ', 'T');
    if (DateTime.fromISO(local, { zone: 'UTC' }).isValid) return { local_time: local };
  }
  return raw ? { provider_time_text: clean(raw, 64) } : {};
}

export function parseOmgoTrackingJson(json: string, rawNumber: string): CarrierResult {
  const number = normalizeOmgoNumber(rawNumber);
  if (challenge(json)) throw new ChallengeError(PROVIDER);
  if (new TextEncoder().encode(json).length > OMGO_MAX_BYTES) throw new SchemaError(PROVIDER, 'OMGO returned excessive tracking data');
  let root: unknown;
  try { root = JSON.parse(json); } catch { throw new SchemaError(PROVIDER, 'OMGO returned invalid tracking JSON'); }
  if (!isRecord(root) || typeof root.success !== 'boolean' || !isRecord(root.data)) throw new SchemaError(PROVIDER);
  // The site's generic negative does not name the requested parcel or prove absence. Its not-found
  // wording and an empty result still answer the one number asked, so the reason tells them from an outage.
  if (!root.success) {
    throw new IndeterminateError(PROVIDER, 'OMGO returned an inconclusive tracking response',
      /^Tracking Code not Found\.?$/i.test(clean(root.data.message, 80)) ? { reason: 'portal_not_found' } : {});
  }
  const data = root.data;
  if (data.total_found === 0 && Array.isArray(data.tracking_data) && data.tracking_data.length === 0) {
    throw new IndeterminateError(PROVIDER, 'OMGO returned no identity-bound history', { reason: 'portal_not_found' });
  }
  if (data.total_found !== 1 || data.total_not_found !== 0 || !Array.isArray(data.tracking_data) || data.tracking_data.length !== 1
    || !Array.isArray(data.found) || data.found.length !== 1 || typeof data.found[0] !== 'string'
    || normalizeTrackingNumber(data.found[0]) !== number || !Array.isArray(data.not_found) || data.not_found.length !== 0) {
    throw new SchemaError(PROVIDER, 'OMGO did not return one unambiguous parcel');
  }
  const parcel: unknown = data.tracking_data[0];
  if (!isRecord(parcel) || typeof parcel.trackingNumber !== 'string' || normalizeTrackingNumber(parcel.trackingNumber) !== number) {
    throw new SchemaError(PROVIDER, 'OMGO returned a different shipment');
  }
  if (!Array.isArray(parcel.trackHistory)) throw new SchemaError(PROVIDER, 'OMGO returned invalid tracking history');
  if (!parcel.trackHistory.length) throw new IndeterminateError(PROVIDER, 'OMGO returned no parcel history');
  if (parcel.trackHistory.length > 500) throw new SchemaError(PROVIDER, 'OMGO returned excessive tracking history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // The public client uses the feed's newest-first sequence directly. Preserve
  // it across countries instead of sorting clocks without established offsets.
  for (const scan of parcel.trackHistory) {
    if (!isRecord(scan) || typeof scan.message !== 'string' || !scan.message.trim()
      || scan.location != null && typeof scan.location !== 'string') throw new SchemaError(PROVIDER, 'OMGO returned an invalid public scan');
    const description = clean(scan.message);
    const mapped = omgoStage(description);
    const wording = mapped ? undefined : classifyWording(description, 'pending');
    const stage = mapped ?? wording?.stage;
    const event: CarrierEvent = { description, ...clock(scan.time),
      ...(clean(scan.location) ? { location: clean(scan.location) } : {}),
      ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : wording!.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!;
  const milestone = events.find(event => event.stage && event.stage !== 'pending');
  const stage = milestone?.stage as Stage | undefined;
  const country = countryCode(parcel.destinationCountry);
  const destination = clean(parcel.destinationCountry, 100);
  const service = clean(parcel.shippingMethod, 80);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: milestone!.stage_source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: null, ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...(service ? { service_name: service } : {}), ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
