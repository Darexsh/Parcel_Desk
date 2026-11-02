import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { kolayGelsinStage } from './status.js';

export const PROVIDER = 'Kolay Gelsin';
export const KOLAY_GELSIN_MAX_BYTES = 1_000_000;
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/i;
const CLOCK = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/;
const BLOCKED = /_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

/** These public own-label shapes remain shared with other Turkish carriers. */
export function normalizeKolayGelsinNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{12}(?:\d{2})?$/.test(number)) throw new InvalidInputError(PROVIDER, 'Kolay Gelsin tracking numbers have twelve or fourteen digits');
  return number;
}

function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value === 'string' && value.length <= 64) return normalizeTrackingNumber(value);
  return null;
}

function wallClock(value: unknown): string {
  if (typeof value !== 'string' || !CLOCK.test(value)) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid milestone clock');
  const date = DateTime.fromFormat(value, 'dd.MM.yyyy HH:mm', { zone: 'UTC' });
  if (!date.isValid || date.toFormat('dd.MM.yyyy HH:mm') !== value) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid milestone day');
  // UTC validates the calendar digits only; the row states no offset.
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function statedTime(value: unknown): { time: string; minute: string } | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || !OFFSET_ISO.test(value)) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid summary timestamp');
  const date = DateTime.fromISO(value, { setZone: true });
  if (!date.isValid) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid summary day');
  return { time: value, minute: date.toFormat("yyyy-MM-dd'T'HH:mm") };
}

/** The verified guest landing page's same-number Next.js shipment object. */
export function parseKolayGelsin(html: string, raw: string, isKg?: boolean, qid?: string): CarrierResult {
  const number = normalizeKolayGelsinNumber(raw);
  if (new TextEncoder().encode(html).byteLength > KOLAY_GELSIN_MAX_BYTES) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an oversized tracking page');
  const $ = load(html);
  const scripts = $('script#__NEXT_DATA__');
  if (scripts.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Kolay Gelsin answered with a browser check');
    throw new SchemaError(PROVIDER, 'Kolay Gelsin returned no unique tracking payload');
  }
  let payload: unknown;
  try { payload = JSON.parse(scripts.text()); } catch { throw new SchemaError(PROVIDER, 'Kolay Gelsin returned invalid tracking JSON'); }
  if (!isRecord(payload) || payload.page !== '/tracking' || !isRecord(payload.query)
    || !isRecord(payload.props) || !isRecord(payload.props.pageProps)) throw new SchemaError(PROVIDER, 'Kolay Gelsin changed its tracking envelope');
  const page = payload.props.pageProps;
  if (identity(payload.query.q) !== number || identity(page.q) !== number) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin answered for another tracking query');
  if (typeof payload.query.qid !== 'string' || !payload.query.qid) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned no verified tracking query');
  if (qid !== undefined && payload.query.qid !== qid) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin returned another verified tracking query');
  const shipment = page.shipmentDetails;
  if (shipment == null) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin returned no bound shipment');
  if (!isRecord(shipment) || identity(shipment.TrackingNumber) === null) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid shipment identity');
  if (identity(shipment.TrackingNumber) !== number) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin answered for another shipment');
  if (typeof shipment.isKGShipment !== 'boolean') throw new IndeterminateError(PROVIDER, 'Kolay Gelsin did not identify its tracking platform');
  if (isKg !== undefined && shipment.isKGShipment !== isKg) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin answered from another tracking platform');
  for (const flag of ['IsOtpRequired', 'IsReturnShipment']) {
    if (shipment[flag] != null && typeof shipment[flag] !== 'boolean') throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid shipment flag');
  }
  if (shipment.IsOtpRequired === true) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin requires recipient verification');
  if (shipment.IsReturnShipment === true) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin returned an unsupported return journey');
  if (shipment.RelatedTrackingIds != null) {
    if (!Array.isArray(shipment.RelatedTrackingIds)) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned invalid related shipments');
    if (shipment.RelatedTrackingIds.length > 1 || shipment.RelatedTrackingIds.some(value => identity(value) !== number)) {
      throw new IndeterminateError(PROVIDER, 'Kolay Gelsin returned several related shipments');
    }
  }
  const created = statedTime(shipment.ShipmentDate);
  const delivered = statedTime(shipment.DeliveryDate);
  if (!Array.isArray(shipment.Statuses)) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned invalid milestones');
  if (shipment.Statuses.length > 100) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned too many milestones');
  const scans: { event: CarrierEvent; local: string; staged: ReturnType<typeof kolayGelsinStage> }[] = [];
  const seen = new Set<string>();
  for (const row of shipment.Statuses) {
    if (!isRecord(row) || typeof row.Active !== 'boolean') throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid milestone');
    // Unreached and undated rail steps are not scans.
    if (!row.Active || row.Date == null || row.Date === '') continue;
    const local = wallClock(row.Date);
    if (typeof row.Message !== 'string' || row.Message.length > 2000) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned invalid milestone wording');
    const description = clean(load(row.Message, null, false).text(), 300);
    if (!description) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an unnamed milestone');
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = kolayGelsinStage(description);
    const stated = staged?.stage === 'registered' ? created : staged?.stage === 'delivered' ? delivered : null;
    const precise = stated && stated.minute === local.slice(0, 16) ? stated.time : null;
    const event: CarrierEvent = { ...(precise ? { time: precise } : { local_time: local }), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    scans.push({ event, local, staged });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  scans.sort((left, right) => right.local.localeCompare(left.local));
  const current = scans.find(scan => scan.staged)?.staged;
  const latest = scans[0]!;
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: latest.event.description!, last_update: latest.event.time ?? null,
    ...(!latest.event.time ? { last_update_local: latest.local } : {}),
    expected_delivery: null, history_truncated: true, events: scans.map(scan => scan.event),
  };
}
