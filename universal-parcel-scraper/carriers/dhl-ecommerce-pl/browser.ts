import { BudgetExceededError, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { dhlPolandScanStage } from './status.js';

const PROVIDER = 'DHL eCommerce Poland';
const ENDPOINT = 'https://sprawdz.dhl.com.pl/';
const MAX_BODY = 300_000;

/** Facility clocks remain local: international rows do not identify their zone. */
export function parseDhlPolandHistory(payload: unknown, waybill: string): CarrierResult {
  if (isRecord(payload) && payload.challenge === true) throw new ChallengeError(PROVIDER);
  if (!/^\d{11}$/.test(waybill) || !isRecord(payload) || payload.number !== waybill
    || !Array.isArray(payload.events) || payload.events.length > 500) {
    throw new SchemaError(PROVIDER, 'DHL Poland returned a different or invalid history');
  }
  const events: CarrierEvent[] = payload.events.map((row: unknown) => {
    if (!isRecord(row) || typeof row.date !== 'string' || typeof row.time !== 'string'
      || typeof row.location !== 'string' || row.location.length > 200
      || typeof row.description !== 'string' || row.description.length > 500) {
      throw new SchemaError(PROVIDER, 'DHL Poland returned an invalid scan');
    }
    const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(row.date);
    const day = date && calendarDay(Number(date[3]), Number(date[2]), Number(date[1]));
    if (!day || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time)) throw new SchemaError(PROVIDER, 'DHL Poland returned an invalid scan clock');
    const description = clean(row.description, 500).replace(/\s*(?:The (?:shipment|parcel) (?:was )?received by|Przesyłka odebrana przez)\b[\s\S]*$/i, '').trim()
      // A terminal the page leaves unnamed has an empty slot.
      .replace(/^(The shipment has reached DHL terminal) in \./i, '$1.');
    if (!description) throw new SchemaError(PROVIDER, 'DHL Poland returned an empty scan');
    const stage = dhlPolandScanStage(description);
    const location = clean(row.location, 200);
    return { local_time: `${day}T${row.time}:00`, description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  if (!events.length) throw new IndeterminateError(PROVIDER, 'DHL Poland returned no scan history');
  return { summary_only: false, events: events.slice(0, 100), last_update_local: events[0]!.local_time,
    ...(events.length > 100 ? { history_truncated: true } : {}) };
}

export async function dhlPolandBrowser(trawl: TrawlClient, waybill: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
  const timeoutMs = Math.floor(remainingMs - 2000);
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  // Leave room for the carrier's already-confirmed summary if the service stalls.
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(remainingMs - 500)))]);
  const page = await trawl.scrape({ url: `${ENDPOINT}?sn=${waybill}&lang=en-gb`, skipHttp: true, maxTier: 3,
    captureResponses: [ENDPOINT], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
  { provider: PROVIDER, timeoutMs, signal: bounded, requireSolved: false, captureWindow: 'last', maxBytes: 4 * MAX_BODY });
  signal.throwIfAborted();
  const responses = page.capturedResponses.filter(row => row.url === ENDPOINT);
  const response = responses.at(-1);
  const status = response?.status ?? page.statusCode;
  if (status === 429) throw new RateLimitedError(PROVIDER);
  if ([401, 403, 428].includes(status)) throw new ChallengeError(PROVIDER);
  if (status >= 400) throw new UpstreamHttpError(PROVIDER, status);
  if (!response) throw new ChallengeError(PROVIDER, 'DHL Poland did not complete browser verification');
  if (responses.length > 10 || response.status !== 200 || response.error || response.truncated || response.base64Encoded || !response.body) {
    throw new TransportError(PROVIDER, 'DHL Poland returned an incomplete browser response');
  }
  if (response.trackingNumberSubmitted !== waybill || Buffer.byteLength(response.body) > MAX_BODY) {
    throw new SchemaError(PROVIDER, 'DHL Poland returned unbound browser history');
  }
  let payload: unknown;
  try { payload = JSON.parse(response.body); } catch { throw new SchemaError(PROVIDER, 'DHL Poland returned invalid browser history'); }
  return parseDhlPolandHistory(payload, waybill);
}
