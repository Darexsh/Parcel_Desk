import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InputRequiredError, NoHistoryError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { TrawlScrapeResponse } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { chinaClock, chinaPostDescription, PROVIDER } from './parser.js';
import { chinaPostEnglish, chinaPostStatus } from './status.js';

export const CHINA_POST_WEB = 'https://www.ems.com.cn/queryList';
export const CHINA_POST_WEB_FLAG = 'https://www.ems.com.cn/ems-web/trackTestQuery/getLogisticsTestFlag';
export const CHINA_POST_WEB_TRACE = 'https://www.ems.com.cn/ems-web/mailTrack/queryTrack';

/** Read only the helper's identity-bound, privacy-filtered guest preview. */
export function parseChinaPostWebPreview(page: TrawlScrapeResponse, number: string): CarrierResult {
  const entries = page.capturedResponses.filter(row => [CHINA_POST_WEB_FLAG, CHINA_POST_WEB_TRACE].includes(row.url));
  const entry = entries.at(-1);
  if (!entry || entries.length > 10) throw new ChallengeError(PROVIDER, 'China Post returned no verified guest preview');
  if (entry.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'China Post browser request did not match the shipment');
  if (entry.status === 429) {
    const retry = entry.headers['retry-after'] ?? '';
    const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    throw new RateLimitedError(PROVIDER, Number.isFinite(delay) ? Math.max(0, delay) : undefined);
  }
  if ([401, 403, 405, 412].includes(entry.status)) throw new ChallengeError(PROVIDER, 'China Post refused the guest preview');
  if (entry.status >= 500) throw new UpstreamHttpError(PROVIDER, entry.status);
  if (entry.status !== 200) throw new TransportError(PROVIDER, 'China Post guest preview is unavailable', { status: entry.status });
  if (entry.error === 'invalid-json') throw new SchemaError(PROVIDER, 'China Post returned invalid guest preview JSON');
  if (entry.error || entry.truncated || entry.base64Encoded || entry.body === null || Buffer.byteLength(entry.body) > 1_000_000) {
    throw new TransportError(PROVIDER, 'China Post returned an incomplete guest preview');
  }
  let payload: unknown;
  try { payload = JSON.parse(entry.body); } catch { throw new SchemaError(PROVIDER, 'China Post returned invalid guest preview JSON'); }
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'China Post returned an invalid guest preview');
  if (!payload.success) {
    if (payload.reason === 'rate_limit') throw new RateLimitedError(PROVIDER);
    if (payload.reason === 'phone') throw new InputRequiredError(PROVIDER, 'recipient verification', 'China Post asks for contact phone verification');
    if (payload.reason === 'empty') throw new NoHistoryError(PROVIDER, 'China Post has no guest tracking information for this number');
    if (payload.reason === 'verification') throw new ChallengeError(PROVIDER, 'China Post refused the character verification');
    throw new IndeterminateError(PROVIDER, 'China Post did not open the guest preview');
  }
  if (entry.url !== CHINA_POST_WEB_TRACE) throw new ChallengeError(PROVIDER, 'China Post verification returned no tracking preview');
  if (payload.match !== true || !Array.isArray(payload.scans) || payload.scans.length > 100) {
    throw new SchemaError(PROVIDER, 'China Post guest preview did not match the shipment');
  }
  if (!payload.scans.length) throw new NoHistoryError(PROVIDER, 'China Post returned no guest scans');
  const scans: readonly unknown[] = payload.scans;
  const events: CarrierEvent[] = [];
  // Each scan's state label, which stages it; the event shows its English.
  const labels: string[] = [];
  for (const scan of [...scans].reverse()) {
    if (!isRecord(scan) || scan.number !== number || typeof scan.time !== 'string'
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(scan.time)
      || typeof scan.code !== 'string' || !/^[A-Z0-9_]{0,20}$/.test(scan.code) || typeof scan.state !== 'string') {
      throw new SchemaError(PROVIDER, 'China Post returned an invalid guest scan');
    }
    const date = DateTime.fromISO(scan.time.replace(' ', 'T'), { zone: 'UTC' });
    const description = chinaPostDescription('', scan.state);
    if (!date.isValid || !description) throw new SchemaError(PROVIDER, 'China Post returned an unreadable guest scan');
    const stage = chinaPostStatus(scan.code, description)?.stage;
    labels.push(description);
    // The preview dates the destination post's scans on China's clock too: on its own,
    // a delivery or a round out for delivery would fall after the preview showed it.
    events.push({ ...chinaClock(date.toFormat("yyyy-MM-dd'T'HH:mm:ss")), description: chinaPostEnglish(description) ?? description,
      ...(scan.code ? { provider_code: scan.code } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  const current = chinaPostStatus(events[0]!.provider_code ?? '', labels[0]!);
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description, last_update: events[0]!.time ?? null, last_update_local: events[0]!.local_time,
    history_truncated: true, events };
}
