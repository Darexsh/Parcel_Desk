import { DateTime } from 'luxon';
import { BudgetExceededError, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';

type TrawlPage = Awaited<ReturnType<TrawlClient['scrape']>>;
import { isRecord } from '../../core/types.js';
import { asendiaTrackingApiUrl, asendiaTrackingUrl, normalizeAsendiaTrackingNumber } from './probe.js';
import { classifyAsendiaStatus } from './status.js';

const PROVIDER = 'Asendia';
const MAX_BYTES = 1_000_000;

/** The portal may disclose a summary while requiring recipient verification for scans. */
export function parseAsendiaGlobalResponse(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAsendiaTrackingNumber(raw);
  if (!isRecord(payload) || payload.context_code !== 1000 || !Array.isArray(payload.data) || payload.data.length > 5) {
    throw new SchemaError(PROVIDER, 'Asendia returned an invalid global tracking response');
  }
  if (!payload.data.length) throw new NotFoundError(PROVIDER);
  const matches = payload.data.filter(row => isRecord(row) && [row.tracking_id, row.upper_tracking_id]
    .some(value => typeof value === 'string' && value.toUpperCase() === number));
  if (matches.length !== 1 || !isRecord(matches[0])) throw new SchemaError(PROVIDER, 'Asendia returned a different or ambiguous shipment');
  const parcel = matches[0];
  const wording = clean(parcel.status, 300);
  if (!wording) throw new SchemaError(PROVIDER, 'Asendia returned no current parcel status');
  if (parcel.events !== undefined && (!Array.isArray(parcel.events) || parcel.events.length > 500)) {
    throw new SchemaError(PROVIDER, 'Asendia returned an invalid global history');
  }
  const scans = Array.isArray(parcel.events) ? (parcel.events as unknown[]).slice().reverse() : [];
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const scan of scans) {
    if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'Asendia returned an invalid global scan');
    const description = clean(scan.labelBC, 500) || clean(scan.harmonized_label, 500);
    const stamp = clean(scan.event_time, 64);
    if (!description || !stamp) throw new SchemaError(PROVIDER, 'Asendia returned an incomplete global scan');
    const instant = explicitOffsetTime(stamp);
    const wall = instant ? null : DateTime.fromISO(stamp, { zone: 'UTC' });
    if (!instant && (!wall?.isValid || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(stamp))) {
      throw new SchemaError(PROVIDER, 'Asendia returned an invalid global scan clock');
    }
    const classified = classifyAsendiaStatus(description);
    const event: CarrierEvent = {
      ...(instant ? { time: instant.iso } : { local_time: wall!.toFormat("yyyy-MM-dd'T'HH:mm:ss") }),
      description, location: clean(scan.location_name, 200),
      ...(classified.status !== 'unknown' ? { stage: classified.stage } : {}),
    };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (events.length && events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const current = classifyAsendiaStatus(wording.replaceAll('_', ' '));
  const country = clean(parcel.destination_country_name, 100);
  return {
    status: current.status, ...(current.status !== 'unknown' ? { current_stage: current.stage } : {}),
    last_status_text: wording, last_update: events[0]?.time ?? null,
    ...(events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
    ...(country ? { destination_country_name: country } : {}),
    ...(!events.length ? { summary_only: true } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}),
    events: events.slice(0, 100), tracking_url: asendiaTrackingUrl(number), tracking_source: 'structured-web-response',
  };
}

type Captured = TrawlPage['capturedResponses'][number];

function captured(response: Captured | undefined): unknown {
  if (!response) throw new ChallengeError(PROVIDER, 'Asendia returned no matching verified tracking response');
  if (response.status === 429) throw new RateLimitedError(PROVIDER);
  if ([400, 401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Asendia rejected browser verification');
  if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
  if (response.status !== 200 || response.error || response.truncated || response.base64Encoded || !response.body) {
    throw new TransportError(PROVIDER, 'Asendia returned an incomplete browser response');
  }
  if (Buffer.byteLength(response.body) > MAX_BYTES) throw new SchemaError(PROVIDER, 'Asendia returned excessive browser data');
  try { return JSON.parse(response.body); } catch { throw new SchemaError(PROVIDER, 'Asendia returned invalid browser JSON'); }
}

export async function asendiaBrowser(trawl: TrawlClient, raw: string, signal: AbortSignal, remainingMs: number,
  postcode: string | null = null): Promise<CarrierResult> {
  const number = normalizeAsendiaTrackingNumber(raw);
  const endpoint = asendiaTrackingApiUrl();
  const timeoutMs = Math.floor(remainingMs - 2000);
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  const url = `${asendiaTrackingUrl(number)}${postcode ? `#trawl-postcode=${encodeURIComponent(postcode)}` : ''}`;
  const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3,
    captureResponses: [endpoint], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
  { provider: PROVIDER, timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 6 * MAX_BYTES });
  signal.throwIfAborted();
  const responses = page.capturedResponses.filter(row => row.url === endpoint && row.trackingNumberSubmitted === number);
  if (responses.length > 10) throw new ChallengeError(PROVIDER, 'Asendia returned no matching verified tracking response');
  const open = responses.filter(row => row.postcodeSubmitted !== true).at(-1);
  const verified = postcode ? responses.filter(row => row.postcodeSubmitted === true).at(-1) : undefined;
  if (!verified) return parseAsendiaGlobalResponse(captured(open ?? responses.at(-1)), number);
  // The status shown before the postcode stands when the portal refuses the postcode or its answer.
  const summary = open ? parseAsendiaGlobalResponse(captured(open), number) : null;
  try {
    const result = parseAsendiaGlobalResponse(captured(verified), number);
    return result.events?.length || !summary ? result : summary;
  } catch (error) {
    if (!summary) throw error;
    return summary;
  }
}
