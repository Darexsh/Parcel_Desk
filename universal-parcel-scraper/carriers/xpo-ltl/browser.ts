import { BudgetExceededError, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { normalizeXpoLtlNumber, PROVIDER, XPO_LTL_MAX_BYTES } from './parser.js';
import { xpoLtlEventStage, xpoLtlSummaryStatus } from './status.js';

const ORIGIN = 'https://ext-web.ltl-xpo.com';
const API = 'https://api.ltl.xpo.com/public-tracking/1.0/shipments/';
const SUMMARY: Readonly<Record<string, Stage>> = { Pickup: 'accepted', 'In Transit': 'in_transit',
  'Out for Delivery': 'out_for_delivery', Delivered: 'delivered' };
const NOISE = /^(?:Pro inquiry|Record updated|System unload of final delivered pro)$/i;

/** The current public tracker supplies epoch clocks and both milestones and full history. */
export function parseXpoBrowser(payload: unknown, raw: string): CarrierResult {
  const number = normalizeXpoLtlNumber(raw);
  if (!isRecord(payload) || payload.code !== '200' || !isRecord(payload.data)
    || payload.data.proNbr !== number || !Array.isArray(payload.data.shipmentTracking)
    || payload.data.shipmentTracking.length !== 1 || !isRecord(payload.data.shipmentTracking[0])) {
    throw new SchemaError(PROVIDER, 'XPO returned an invalid browser shipment');
  }
  const shipment = payload.data.shipmentTracking[0];
  if (shipment.proNbr !== number) throw new SchemaError(PROVIDER, 'XPO returned a different browser PRO');
  const summary = shipment.shipmentTrackingSummaryEvents;
  const details = shipment.shipmentTrackingDetailedEvents;
  if (!Array.isArray(summary) || !Array.isArray(details) || summary.length > 100 || details.length > 1000) {
    throw new SchemaError(PROVIDER, 'XPO returned invalid browser scans');
  }
  const stageAt = new Map<number, Stage>();
  for (const row of summary) {
    if (!isRecord(row) || !isRecord(row.eventHdr)) throw new SchemaError(PROVIDER, 'XPO returned an invalid milestone');
    const header = row.eventHdr;
    if (!Number.isSafeInteger(header.eventTmst) || typeof header.eventTypeCd !== 'string') throw new SchemaError(PROVIDER, 'XPO returned an invalid milestone clock');
    const stage = header.isException === true ? 'exception' : Object.hasOwn(SUMMARY, header.eventTypeCd) ? SUMMARY[header.eventTypeCd] : undefined;
    if (stage) stageAt.set(header.eventTmst as number, stage);
  }
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  const detailTimes = new Set<number>();
  const scan = (row: unknown): void => {
    if (!isRecord(row) || !isRecord(row.eventHdr) || typeof row.eventHdr.eventDesc !== 'string'
      || !row.eventHdr.eventDesc.trim() || !Number.isSafeInteger(row.eventHdr.eventTmst)
      || Number(row.eventHdr.eventTmst) < 0 || Number(row.eventHdr.eventTmst) > 8_640_000_000_000_000) {
      throw new SchemaError(PROVIDER, 'XPO returned an invalid browser scan');
    }
    const header = row.eventHdr;
    const description = clean(header.eventDesc, 500).replace(/\s+-\s+P&D route:.*$/i, '');
    if (NOISE.test(description)) return;
    const stamp = header.eventTmst as number;
    const stage = header.isException === true ? 'exception' : stageAt.get(stamp) ?? xpoLtlEventStage(description);
    const place = isRecord(row.eventOccrdLoc) ? row.eventOccrdLoc : {};
    if (place.cityName != null && typeof place.cityName !== 'string') throw new SchemaError(PROVIDER, 'XPO returned an invalid service center');
    const city = typeof place.cityName === 'string' ? clean(place.cityName, 200) : '';
    const state = typeof place.stateCd === 'string' && /^[A-Z]{2}$/.test(place.stateCd) ? place.stateCd : '';
    const event: CarrierEvent = { description, time: new Date(stamp).toISOString(), ...(city ? { location: state ? `${city}, ${state}` : city } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  };
  for (const row of details) {
    scan(row);
    if (isRecord(row) && isRecord(row.eventHdr) && typeof row.eventHdr.eventTmst === 'number') detailTimes.add(row.eventHdr.eventTmst);
  }
  for (const row of summary) if (isRecord(row) && isRecord(row.eventHdr) && !detailTimes.has(Number(row.eventHdr.eventTmst))) scan(row);
  events.sort((left, right) => Date.parse(right.time!) - Date.parse(left.time!));
  if (!events.length) throw new IndeterminateError(PROVIDER, 'XPO returned no browser shipment activity');
  const mapped = typeof shipment.statusCd === 'string' ? xpoLtlSummaryStatus(shipment.statusCd)?.stage : undefined;
  const current = events.find(event => event.stage);
  const stage: Stage | undefined = mapped ?? (events.some(event => event.stage === 'delivered') ? 'delivered' : current?.stage as Stage | undefined);
  const wording = typeof shipment.statusMessage === 'string' ? clean(shipment.statusMessage, 500) : '';
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage, current_stage_source: stage ? 'carrier_map' : undefined,
    last_status_text: wording || events[0]!.description, last_update: events[0]!.time, events: events.slice(0, 100),
    ...(typeof shipment.statusCd === 'string' && /^\d{1,3}$/.test(shipment.statusCd) ? { provider_code: shipment.statusCd } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}) };
}

export async function xpoBrowser(trawl: TrawlClient, raw: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
  const number = normalizeXpoLtlNumber(raw);
  const endpoint = `${API}${number}/tracking`;
  const timeoutMs = Math.floor(remainingMs - 2000);
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  const page = await trawl.scrape({ url: `${ORIGIN}/public-app/shipments?referenceNumber=${number}`, skipHttp: true, maxTier: 3,
    captureResponses: [endpoint], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
  { provider: PROVIDER, timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 6 * XPO_LTL_MAX_BYTES });
  signal.throwIfAborted();
  const responses = page.capturedResponses.filter(row => row.url === endpoint);
  const response = responses.at(-1);
  if (!response || responses.length > 10) throw new ChallengeError(PROVIDER, 'XPO returned no matching browser tracking response');
  if (response.status === 429) throw new RateLimitedError(PROVIDER);
  if ([401, 403, 428].includes(response.status)) throw new ChallengeError(PROVIDER);
  if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
  if (response.status !== 200 || response.error || response.truncated || response.base64Encoded || !response.body) {
    throw new TransportError(PROVIDER, 'XPO returned an incomplete browser response');
  }
  if (Buffer.byteLength(response.body) > XPO_LTL_MAX_BYTES) throw new SchemaError(PROVIDER, 'XPO returned excessive browser data');
  let payload: unknown;
  try { payload = JSON.parse(response.body); } catch { throw new SchemaError(PROVIDER, 'XPO returned invalid browser JSON'); }
  return parseXpoBrowser(payload, number);
}
