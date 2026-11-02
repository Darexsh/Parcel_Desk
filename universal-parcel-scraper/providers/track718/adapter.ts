import { DateTime } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { classifyEvent, hasPrivateDeliveryDetails, isNotice, result, text } from '../shared/result.js';

const SOURCE = 'Track718';
export const TRACK718_API = 'https://apigetway.track718.net/track/real_query_multi';
const KEY = 'www.juxiex.com';

export function juxiNumber(raw: string, carrier?: string | null): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^JXC[A-Z]{2}\d{10}YQ$/.test(number) || carrier && !['unknown', 'juxi-express'].includes(carrier)) {
    throw new InvalidInputError(SOURCE, 'Track718 is enabled only for Juxi Express');
  }
  return number;
}

/** One complete identifier and the Juxi source key must agree in every reply. */
export function parseTrack718(payloads: unknown[], raw: string): CarrierResult {
  const number = juxiNumber(raw), events: CarrierEvent[] = [];
  let pending = true, terminal = false, partial = false;
  for (const payload of payloads) {
    if (!isRecord(payload) || !isRecord(payload.status) || !Number.isInteger(payload.status.code)) throw new SchemaError(SOURCE);
    const code = payload.status.code;
    if (code === 2 || code === 7 || code === 8) throw new ChallengeError(SOURCE);
    if (code === 5) throw new RateLimitedError(SOURCE);
    if (code === 6) throw new IndeterminateError(SOURCE, 'Track718 is temporarily busy');
    if (code !== 0 && code !== 3) throw new SchemaError(SOURCE, 'Track718 returned an unknown outcome');
    if (!Array.isArray(payload.data) || payload.data.length !== 1 || !isRecord(payload.data[0])) throw new SchemaError(SOURCE);
    const row = payload.data[0];
    if (row.track !== number || row.fromKey !== KEY) throw new SchemaError(SOURCE, 'Track718 returned a different parcel or carrier');
    pending = payload.pending === true || code === 3;
    terminal ||= code === 0 && row.origin === '04' && row.result === 0;
    partial ||= row.isMerge === true || row.mergeType === 10 || row.mergeType === 20;
    for (const field of ['from', 'to', 'frist', 'wms']) {
      if (!Array.isArray(row[field]) || row[field].length > 500) throw new SchemaError(SOURCE, 'Track718 returned invalid scans');
      for (const scan of row[field]) {
        if (!isRecord(scan) || typeof scan.ondate !== 'string' || typeof scan.status !== 'string') throw new SchemaError(SOURCE);
        const description = text(scan.status);
        if (!description || isNotice(description) || hasPrivateDeliveryDetails(description)) continue;
        const instant = explicitOffsetTime(scan.ondate);
        const wall = !instant && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(scan.ondate)
          ? DateTime.fromISO(scan.ondate.replace(' ', 'T'), { zone: 'utc' }) : null;
        if (!instant && !wall?.isValid) throw new SchemaError(SOURCE, 'Track718 returned an invalid scan clock');
        events.push({ description, ...classifyEvent(description), ...(text(scan.address) ? { location: text(scan.address) } : {}),
          ...(instant ? { time: instant.iso } : { local_time: wall!.toFormat("yyyy-MM-dd'T'HH:mm:ss") }) });
        if (events.length > 1000) throw new SchemaError(SOURCE, 'Track718 returned too many scans');
      }
    }
  }
  if (!events.length) {
    if (terminal && !pending) throw new NotFoundError(SOURCE, 'Track718 has no available Juxi history');
    throw new IndeterminateError(SOURCE, 'Track718 has not completed the Juxi lookup');
  }
  return { ...result(events, SOURCE), ...(pending || partial ? { history_truncated: true } : {}) };
}

export const adapter: AdapterFactory = environment => ({
  id: 'track718', recordsSteps: true, steps: ['trawl'],
  track: async (input, context: TrackingContext = {}) => {
    const number = juxiNumber(input.number, input.carrier);
    return runSteps({ carrier: SOURCE, signal: context.signal, budgetMs: context.budgetMs ?? 35000, recorder: environment.recorder }, [
      { id: 'trawl', run: async ({ signal, remainingMs }) => {
        if (!environment.trawl) throw new ChallengeError(SOURCE, 'Track718 requires the browser tracking service');
        const timeoutMs = Math.floor(remainingMs - 2000);
        if (timeoutMs < 1) throw new BudgetExceededError(SOURCE, remainingMs);
        const page = await environment.trawl.scrape({ url: `https://www.track718.com/en/detail?nums=${number}&cb=678`,
          skipHttp: true, maxTier: 3, maxTimeout: timeoutMs, settleTimeout: timeoutMs, captureResponses: [TRACK718_API] },
        { provider: SOURCE, timeoutMs, signal, fetcher: environment.fetcher, maxBytes: 4_000_000, requireSolved: false, captureWindow: 'last' });
        const rows = page.capturedResponses.filter(row => row.url === TRACK718_API);
        if (!rows.length && page.statusCode === 429) throw new RateLimitedError(SOURCE);
        if (!rows.length && page.statusCode >= 500) throw new UpstreamHttpError(SOURCE, page.statusCode);
        if (!rows.length) throw new ChallengeError(SOURCE, 'Track718 returned no bound Juxi response');
        const payloads: unknown[] = [];
        for (const row of rows) {
          if (row.status === 429) throw new RateLimitedError(SOURCE);
          if ([401, 403, 428].includes(row.status)) throw new ChallengeError(SOURCE);
          if (row.status >= 400) throw new UpstreamHttpError(SOURCE, row.status);
          if (row.trackingNumberSubmitted !== number) throw new SchemaError(SOURCE, 'Track718 did not bind the requested Juxi number');
          if (row.error || row.truncated || row.base64Encoded || !row.body || row.body.length > 1_000_000) throw new TransportError(SOURCE);
          try { payloads.push(JSON.parse(row.body)); } catch { throw new SchemaError(SOURCE); }
        }
        signal.throwIfAborted();
        return parseTrack718(payloads, number);
      } },
    ]);
  },
});
