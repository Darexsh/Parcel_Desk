import { DateTime } from 'luxon';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean, type TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeJdNumber } from './parser.js';
import { jdLogisticsStatus } from './status.js';
import { withoutCourierContact } from './wording.js';

const PROVIDER = 'JD Logistics';
export const JD_DOMESTIC_TRACK = 'https://www.jdl.com/waybill/trackNoPin';
export const JD_DOMESTIC_PROXY = 'https://api.jdl.com/waybillQuery/trackWaybill';
const PAGE = 'https://www.jdl.com/orderSearch/';
const NUMBER = /^JD(?:J\d{12}|AZ\d{11})$/;

/** A route suggestion, never evidence that JD holds the number. */
export const jdDomesticCandidate = (number: string): boolean => NUMBER.test(number);
export const jdDomesticUrl = (number: string): string => `${PAGE}?${new URLSearchParams({ waybillCodes: normalizeJdNumber(number) })}`;

/** Drop the part naming a courier, contact or recipient; the scan's status remains. */
export function jdDomesticWording(raw: unknown): string {
  const text = withoutCourierContact(clean(raw, 2000))
    .replace(/由[^，。；;]{1,100}签收/gu, '签收')
    .replace(/((?:已|成功)签收)[，,。；;].*$/u, '$1');
  const contact = /配送员|快递员|揽收员|京东小哥|快递小哥|签收人|收件人|联系电话|联系方式|手机号码?|电话(?:号码?)?|signed(?: for)? by|recipient(?: name)?\s*:|courier(?: name| phone)?\s*:/iu.exec(text);
  const head = (contact ? text.slice(0, contact.index) : text).replace(/[\s，,；;。:：]+$/u, '').trim();
  if (head) return head;
  // A courier-first sentence can still contain one unambiguous status phrase.
  // Keep that phrase, never the group's current status for an older row.
  return /正在(?:为您)?(?:派送|配送)|派送失败|已揽收|揽收成功|已取件|取件成功|已退回|退回成功/u.exec(text)?.[0] ?? '';
}

function clock(row: Record<string, unknown>): { time?: string; local_time?: string } {
  // The official page uses createTime, otherwise trackDay + trackTime. An
  // explicitly supplied epoch/offset stays an instant; an offset-less clock
  // stays local. This does not guess a zone from the page's Chinese locale.
  const raw = row.createTime ?? (typeof row.trackDay === 'string' && typeof row.trackTime === 'string'
    ? `${row.trackDay} ${row.trackTime}` : null);
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 946684800000 && raw < 4102444800000) {
    return { time: DateTime.fromMillis(raw, { zone: 'UTC' }).toISO()! };
  }
  if (typeof raw !== 'string' || raw.length > 80) throw new SchemaError(PROVIDER, 'JD domestic history has no readable scan clock');
  const value = raw.trim();
  if (/(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) {
    const stated: ParsedTime | null = explicitOffsetTime(value);
    if (!stated) throw new SchemaError(PROVIDER, 'JD domestic history has an invalid stated clock');
    return { time: stated.iso };
  }
  const wall = value.replace('T', ' ').replace(/\//g, '-');
  for (const format of ['yyyy-MM-dd HH:mm:ss.SSS', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm']) {
    const date = DateTime.fromFormat(wall, format, { zone: 'UTC' });
    if (date.isValid && date.toFormat(format) === wall) return { local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  }
  throw new SchemaError(PROVIDER, 'JD domestic history has an invalid scan clock');
}

export function parseJdDomestic(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJdNumber(raw);
  if (!isRecord(payload) || payload.code !== 1 || !Array.isArray(payload.obj) || !payload.obj.length) {
    // In particular, -200010 after a guest-session mismatch is not NotFound.
    throw new IndeterminateError(PROVIDER, 'JD domestic tracking returned no verified shipment');
  }
  if (payload.obj.length !== 1 || !isRecord(payload.obj[0]) || returnedTrackingNumber(payload.obj[0].rawWaybillCode) !== number) {
    throw new SchemaError(PROVIDER, 'JD domestic tracking returned a different or ambiguous shipment');
  }
  const item = payload.obj[0];
  if (item.exists === false) throw new NotFoundError(PROVIDER);
  if (item.exists !== true || !Array.isArray(item.traceAllVoList) || item.traceAllVoList.length > 100) {
    throw new SchemaError(PROVIDER, 'JD domestic tracking returned an incomplete shipment');
  }
  const events: CarrierEvent[] = [];
  let rows = 0, wordless = 0;
  for (const group of item.traceAllVoList) {
    if (!isRecord(group) || !Array.isArray(group.traceVoList) || group.traceVoList.length > 200) {
      throw new SchemaError(PROVIDER, 'JD domestic tracking returned incomplete history');
    }
    for (const row of group.traceVoList) {
      if (!isRecord(row) || ++rows > 2000) throw new SchemaError(PROVIDER, 'JD domestic history exceeds its limits');
      if (row.operateMessage != null && typeof row.operateMessage !== 'string') {
        throw new SchemaError(PROVIDER, 'JD domestic history has an incomplete scan');
      }
      const time = clock(row);
      const description = jdDomesticWording(row.operateMessage);
      // Contact-only or wordless rows cannot describe progress. Keep the
      // remaining verified scans, but never present the shortened list as full.
      if (!description) { wordless++; continue; }
      const code = typeof row.state === 'string' || typeof row.state === 'number' ? clean(String(row.state), 40) : '';
      const mapped = code ? jdLogisticsStatus(code, description) : undefined;
      const classification = classifyWording(description);
      events.push({ description, ...time, ...(code ? { provider_code: code } : {}),
        ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' }
          : classification.source !== 'none' ? { stage: classification.stage, stage_source: classification.source } : {}) });
    }
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'JD domestic tracking returned a known shipment without scans');
  // Only explicit instants can be sorted exactly. Unresolved wall clocks keep
  // the carrier's group/row order, rather than guessing one shared time zone.
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const seen = new Set<string>();
  const unique = events.filter(event => { const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true; });
  const kept = unique.slice(0, 100), latest = kept[0]!;
  const coded = latest.provider_code ? jdLogisticsStatus(latest.provider_code, latest.description!) : undefined;
  const classification = classifyWording(latest.description!);
  return { status: coded?.status ?? (classification.source !== 'none' ? languageStageStatus(classification.stage) : 'unknown'),
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(wordless || unique.length > kept.length ? { history_truncated: true } : {}), events: kept };
}

export async function jdDomesticBrowser(trawl: TrawlClient, number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
  const timeoutMs = Math.min(40_000, Math.floor(remainingMs - 2000));
  if (timeoutMs < 5000) throw new BudgetExceededError(PROVIDER, remainingMs);
  const page = await trawl.scrape({ url: jdDomesticUrl(number), skipHttp: true, maxTier: 3,
    captureResponses: [JD_DOMESTIC_TRACK, JD_DOMESTIC_PROXY], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
  { provider: PROVIDER, timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 2_000_000 });
  signal.throwIfAborted();
  const rows = page.capturedResponses.filter(row => [JD_DOMESTIC_TRACK, JD_DOMESTIC_PROXY].includes(row.url));
  const response = rows.at(-1);
  if (!response) {
    const marker = page.capturedResponses.filter(row => row.url === PAGE).at(-1);
    if (marker?.error === 'jd-domestic-budget') throw new BudgetExceededError(PROVIDER, remainingMs);
    if (marker?.status === 429 || page.statusCode === 429) throw new RateLimitedError(PROVIDER);
    if (marker?.status === 403 || page.statusCode === 403) throw new ChallengeError(PROVIDER);
    if (!marker || !['jd-domestic-unreadable', 'jd-domestic-stale_puzzle', 'jd-domestic-guest_session_changed', 'jd-domestic-verification_refused'].includes(marker.error ?? '')) {
      throw new TransportError(PROVIDER, 'JD domestic browser service did not prepare tracking');
    }
    throw new ChallengeError(PROVIDER, 'JD domestic verification did not produce a bound tracking request', { reason: 'verification_unreadable' });
  }
  if (rows.length > 3 || rows.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'JD domestic response is not bound to the requested waybill');
  if (response.status === 429) throw new RateLimitedError(PROVIDER);
  if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER);
  if (response.status !== 200 || response.error || response.truncated || response.base64Encoded || !response.body) {
    throw new TransportError(PROVIDER, 'JD domestic tracking response is incomplete');
  }
  let payload: unknown;
  try { payload = JSON.parse(response.body); } catch { throw new SchemaError(PROVIDER, 'JD domestic tracking returned invalid JSON'); }
  return parseJdDomestic(payload, number);
}
