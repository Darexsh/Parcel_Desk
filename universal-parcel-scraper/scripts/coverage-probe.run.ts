/**
 * Live coverage probe: each case's number through its carrier's own adapter and
 * through every universal provider separately, with no stop at the first
 * success. Driven by coverage-probe.mjs, which documents the inputs.
 *
 * Records keep counts, times and stages only: no event text or location, so
 * a record cannot carry recipient data, and no number unless the case is a
 * public one (the benchmark's).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { it } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment } from '../core/adapter/index.js';
import { carrierErrorKind, NoHistoryError } from '../core/errors/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/index.js';
import { isValidS10TrackingNumber } from '../core/detection/s10.js';
import { normalizeTrackingNumber } from '../core/detection/normalize.js';
import type { CarrierResult } from '../core/result/index.js';
import { CARRIER_CATALOG } from '../generated/catalog.js';
import { REGISTRY } from '../generated/registry.js';
import { BROWSER_SOURCES, UniversalTracker } from '../providers/universal.js';
import { COVERAGE_SOURCES } from '../providers/coverage.js';
import type { UniversalSource } from '../providers/shared/result.js';

interface ProbeCase {
  carrier: string; number: string; postcode?: string | null; reference?: number;
  /** The catalog carrier whose adapter answers for `direct`, when not `carrier`. */
  adapter?: string | null;
  /** A public number, kept in its records. */
  public?: boolean;
  /** Only these sources, for a recheck of some. */
  sources?: Source[];
}
type Source = 'direct' | UniversalSource;

const TRAWL_URL = process.env.COVERAGE_PROBE_TRAWL_URL ?? '';
const SOURCES: Source[] = ['direct', ...COVERAGE_SOURCES];
/** ParcelsApp blocked an address after about 145 lookups in 40 minutes (providers/parcelsapp/README.md). */
const PARCELSAPP_GAP_MS = 60_000;
/** The benchmark's longest run of real ParcelsApp negatives was four. */
const PARCELSAPP_BLOCK_STREAK = 10;

function environment(): AdapterEnvironment {
  return {
    trawl: TRAWL_URL ? new TrawlClient(TRAWL_URL) : null,
    browserExecutablePath: process.env.TRACKING_CHROMIUM_PATH ?? null,
    recorder: NOOP_RECORDER,
    env: process.env,
  };
}

/** The catalog zone universal providers get for the carrier in production. */
function zoneOf(carrier: string): string | null {
  const zone = (CARRIER_CATALOG as Record<string, { timezone?: string }>)[carrier]?.timezone;
  return zone && zone !== 'UTC' ? zone : null;
}

function answer(error: unknown): { outcome: string; error: string } {
  const kind = carrierErrorKind(error);
  // Scans without an instant: the provider has a history the library does not use.
  const outcome = (error as { reason?: unknown }).reason === 'undated_history' ? 'undated'
    : kind === 'not_found' || error instanceof NoHistoryError ? 'no_history'
      : kind === 'input_required' ? 'postcode_prompt'
        : kind === 'invalid_input' ? 'refused'
          : kind === 'challenge' ? 'blocked' : 'error';
  const chain: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    const reason = (current as Error & { reason?: unknown }).reason;
    chain.push(`${current.name}${kind && depth === 0 ? `(${kind})` : ''}${typeof reason === 'string' ? `[${reason}]` : ''}`);
  }
  return { outcome, error: chain.join(' <- ') || String(error).slice(0, 80) };
}

function summary(result: CarrierResult) {
  const events = result.events ?? [];
  const dated = events.filter((event) => typeof event.time === 'string' && Number.isFinite(Date.parse(event.time)));
  const newest = dated.reduce<typeof dated[number] | undefined>((best, event) =>
    !best || Date.parse(event.time!) > Date.parse(best.time!) ? event : best, undefined);
  // Of the undated, the scans with the carrier's wall clock, whose zone the feed does not say.
  const walls = events.filter((event) => !dated.includes(event) && typeof event.local_time === 'string').map((event) => event.local_time!);
  return {
    rows: events.length, undated: events.length - dated.length,
    wall: walls.length, wallLatest: walls.sort().at(-1) ?? null,
    latest: newest?.time ?? null, latestStage: newest?.stage ?? result.current_stage ?? null,
    reported: Array.isArray(result.reported_carriers) ? result.reported_carriers.slice(0, 6) : [],
  };
}

async function probe(item: ProbeCase, source: Source, registry: AdapterRegistry, tracker: UniversalTracker) {
  const base = { carrier: item.carrier, reference: item.reference ?? 0, ...(item.public ? { number: item.number } : {}),
    source, checked: new Date().toISOString().slice(0, 10) };
  const started = Date.now();
  try {
    let result: CarrierResult;
    if (source === 'direct') {
      const adapter = registry.for(item.adapter ?? item.carrier);
      if (!adapter) return { ...base, outcome: 'no_adapter', ms: 0 };
      result = await adapter.track({ number: normalizeTrackingNumber(item.number), postcode: item.postcode ?? null, timezone: null });
    } else if (source === 'UPU' && !isValidS10TrackingNumber(item.number)) {
      return { ...base, outcome: 'n/a', ms: 0 };
    } else {
      result = await tracker.fetchSource(source, item.number, source === 'UPU' ? undefined : 45_000, item.postcode ?? null, zoneOf(item.carrier),
        undefined, undefined, item.carrier);
    }
    const counted = summary(result);
    return { ...base, outcome: counted.rows ? 'history' : 'summary_only', ...counted, ms: Date.now() - started };
  } catch (error) {
    return { ...base, ...answer(error), ms: Date.now() - started };
  }
}

it('probes every case through every source', async () => {
  const cases = JSON.parse(readFileSync(process.env.COVERAGE_PROBE_CASES!, 'utf8')) as ProbeCase[];
  const output = process.env.COVERAGE_PROBE_OUT!;
  const only = process.env.COVERAGE_PROBE_SOURCES ? new Set(process.env.COVERAGE_PROBE_SOURCES.split(',')) : null;
  const env = environment();
  const registry = new AdapterRegistry(REGISTRY, env);
  const tracker = new UniversalTracker({ enablePostalNinja: true, environment: env, ...(TRAWL_URL ? {} : { trawlUrl: '' }) });
  // Browser-service lookups run one at a time, beside the HTTP ones. ParcelsApp's have a
  // paced lane of their own.
  const laneOf = (source: Source) => source === 'ParcelsApp' ? 'paced'
    : BROWSER_SOURCES.has(source as UniversalSource) ? 'browser' : 'http';
  const write = (record: Awaited<ReturnType<typeof probe>>) => {
    appendFileSync(output, `${JSON.stringify(record)}\n`);
    console.log(`${record.carrier} ${record.source} ${record.ms} ms ${record.outcome}${'rows' in record ? ` ${record.rows}` : ''}${'error' in record ? ` ${record.error}` : ''}`);
  };
  const lane = async (name: string, gapMs = 0) => {
    let started = -Infinity;
    // A blocked ParcelsApp address answers NO_DATA to everything: negatives wait for the next
    // answer, and a long run of them ends the lane as blocked.
    const negatives: Awaited<ReturnType<typeof probe>>[] = [];
    for (const item of cases) {
      for (const source of SOURCES) {
        if ((only && !only.has(source)) || (item.sources && !item.sources.includes(source)) || laneOf(source) !== name) continue;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + gapMs - Date.now())));
        started = Date.now();
        const record = await probe(item, source, registry, tracker);
        if (name === 'paced' && record.outcome === 'no_history') {
          negatives.push(record);
          if (negatives.length < PARCELSAPP_BLOCK_STREAK) continue;
          for (const held of negatives) write({ ...held, outcome: 'blocked', error: 'NO_DATA while ParcelsApp blocked the address' });
          console.log(`ParcelsApp answered ${negatives.length} NO_DATA in a row: stopped its lane`);
          return;
        }
        negatives.splice(0).forEach(write);
        write(record);
      }
    }
    negatives.forEach(write);
  };
  await Promise.all([lane('browser'), lane('http'), lane('paced', PARCELSAPP_GAP_MS)]);
}, 6 * 3_600_000);
