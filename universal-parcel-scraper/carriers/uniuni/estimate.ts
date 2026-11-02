import { DateTime, IANAZone } from 'luxon';
import { SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeUniuniNumber } from './parser.js';

const PAGE = 'https://www.uniuni.com/tracking/';
const ENDPOINT = 'https://sj.uniexpress.ca/version2/orders/edd_information';
const PROVIDER = 'UniUni estimate';
const MAX_SCRIPTS = 12;

/** Read the current anonymous request builder; never persist its website key. */
export function estimateKey(source: string): string | null {
  const keys = [...source.matchAll(/https:\/\/sj\.uniexpress\.ca\/version2\/orders\/edd_information["']\s*,\s*\{\s*key\s*:\s*["']([a-zA-Z0-9]{16,128})["']/g)]
    .map(match => match[1]!);
  return keys.length === 1 ? keys[0]! : null;
}

export function estimateScripts(html: string): string[] {
  const urls = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
    .map(match => {
      try {
        const url = new URL(match[1]!, PAGE);
        return url.origin === new URL(PAGE).origin && /^\/_next\/static\/chunks\/[\w.~%-]+\.js$/.test(url.pathname)
          && !url.search && !url.hash ? url.href : null;
      } catch { return null; }
    }).filter((url): url is string => url !== null);
  // Route-specific chunks follow the shared libraries in the official page.
  return [...new Set(urls)].reverse().slice(0, MAX_SCRIPTS);
}

type Estimate = Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'>;

/** Estimate clocks use their own zone, independently of every scan clock. */
function estimateClock(day: string, clock: string, zone: unknown): string {
  const local = `${day}T${clock}`;
  if (typeof zone !== 'string' || zone.length > 80 || !IANAZone.isValidZone(zone)) return local;
  const value = firstOccurrence(DateTime.fromISO(local, { zone }));
  return value.isValid && value.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local && value.getPossibleOffsets().length === 1
    ? value.toISO({ suppressMilliseconds: true }) : local;
}

export function parseUniuniEstimate(payload: unknown, rawNumber: string): Estimate {
  const number = normalizeUniuniNumber(rawNumber);
  if (!isRecord(payload) || payload.status !== 'SUCCESS' || !Array.isArray(payload.data)
    || payload.data.length > 25 || !payload.data.every(isRecord)) throw new SchemaError(PROVIDER);
  // One request asks for one parcel. Extra or duplicated identities are inconclusive.
  if (payload.data.length !== 1 || payload.data[0]!.tno !== number) throw new SchemaError(PROVIDER, 'UniUni estimate did not identify the requested parcel');
  const item = payload.data[0]!;
  if (item.edd_enabled !== true || item.delivery_estimate == null) return {};
  if (!isRecord(item.delivery_estimate)) throw new SchemaError(PROVIDER);
  const estimate = item.delivery_estimate;
  const day = estimate.estimated_delivery_date;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return {};
  const date = DateTime.fromISO(day, { zone: 'UTC' });
  if (!date.isValid || date.toISODate() !== day) return {};
  const start = estimate.estimated_delivery_time_start;
  const end = estimate.estimated_delivery_time_end;
  const validClock = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
  if (!validClock(start) || !validClock(end) || start >= end) return { expected_delivery: day };
  return { expected_delivery_from: estimateClock(day, start, estimate.timezone), expected_delivery: estimateClock(day, end, estimate.timezone) };
}

export class UniuniEstimates {
  private configuration: { key: string; expires: number } | undefined;

  constructor(private readonly options: { fetcher?: typeof fetch; userAgent: string }) {}

  async fetch(number: string, context: { signal: AbortSignal; remainingMs: number }): Promise<Estimate> {
    // Enrichment has a small separate ceiling, while leaving time to return history.
    const allowance = Math.min(4_000, Math.floor(context.remainingMs) - 100);
    if (allowance < 500 || context.signal.aborted) return {};
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(allowance)]);
    const deadline = performance.now() + allowance;
    const read = async (url: string, maxBytes: number, body?: string) => {
      const { bytes } = await fetchBounded(url, { signal, ...(body ? { method: 'POST', body } : {}),
        headers: { Accept: body ? 'application/json' : '*/*', 'User-Agent': this.options.userAgent,
          ...(body ? { 'Content-Type': 'application/json' } : {}) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes, fetcher: this.options.fetcher,
      });
      return bytes;
    };
    if (!this.configuration || this.configuration.expires <= Date.now()) {
      const html = new TextDecoder().decode(await read(PAGE, 250_000));
      let key: string | null = null;
      for (const url of estimateScripts(html)) {
        signal.throwIfAborted();
        key = estimateKey(new TextDecoder().decode(await read(url, 500_000)));
        if (key) break;
      }
      if (!key) throw new SchemaError(PROVIDER, 'UniUni estimate configuration was not found');
      this.configuration = { key, expires: Date.now() + 3_600_000 };
    }
    let bytes: Uint8Array;
    try { bytes = await read(ENDPOINT, 50_000, JSON.stringify({ key: this.configuration.key, tnos: [number] })); }
    catch (error) {
      if (error instanceof UpstreamHttpError && [401, 403].includes(error.status)) this.configuration = undefined;
      throw error;
    }
    const payload = parseJsonBytes(bytes, PROVIDER);
    if (!isRecord(payload) || payload.status !== 'SUCCESS') this.configuration = undefined;
    return parseUniuniEstimate(payload, number);
  }
}
