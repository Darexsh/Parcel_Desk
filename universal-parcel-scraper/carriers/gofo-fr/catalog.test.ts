import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { trackCarrier } from '../../core/adapter/track.js';
import { carrierAdapter, carrierDefinition, tracksAutomatically } from '../../core/catalog/index.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { recognitionCandidates } from '../../core/recognition/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker, TrackingError } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';
import type { UniversalTracker } from '../../providers/universal.js';

const reference = 'PK00000000000000000010';
const reply = (region: string) => new Response(readFileSync(new URL(`../gofo-${region}/fixtures/delivered.json`, import.meta.url), 'utf8'));
afterEach(() => vi.useRealTimers());

describe.each([
  { id: 'gofo-fr' as const, region: 'fr', zone: 'Europe/Paris', number: 'GFFR00000000000001' },
  { id: 'gofo-it' as const, region: 'it', zone: 'Europe/Rome', number: 'GFIT00000000000001' },
  { id: 'gofo-nl' as const, region: 'nl', zone: 'Europe/Amsterdam', number: 'GFNL00000000000001' },
  { id: 'gofo-es' as const, region: 'es', zone: 'Europe/Madrid', number: 'GFES00000000000001' },
])('$id routing', ({ id, region, zone, number }) => {
  it('detects only its national network and routes ordinary tracking to its own direct HTTP adapter', async () => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: id, confidence: 'high' });
    for (const near of [`${number}0`, number.slice(0, -2)]) {
      expect(detectCarrierMatch(near).carrier).not.toBe(id); expect(detectCarrierMatch(near).candidates ?? []).not.toContain(id);
    }
    expect(carrierAdapter(id)).toBe(id); expect(tracksAutomatically(id)).toBe(true); expect(carrierDefinition(id).timezone).toBe(zone);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(region));
    expect(await createTracker({ providers: [], fetcher }).track({ number })).toMatchObject({ carrier: id, source: id,
      result: { current_stage: 'delivered', destination_country: region.toUpperCase() } });
    expect(fetcher).toHaveBeenCalledOnce(); expect(String(fetcher.mock.calls[0]![0])).toContain(`/${region}/open-api/`);
  });

  it('dispatches a consumer router directly and leaves an empty service answer inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(region));
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const universalFetch = vi.fn();
    const universal = { fetch: universalFetch } as unknown as UniversalTracker;
    expect(await trackCarrier(id, { number }, { registry, universal, budgetMs: 5_000 })).toMatchObject({ status: 'delivered' });
    expect(universalFetch).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
    const empty = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"code":200,"data":[]}'));
    await expect(createTracker({ providers: [], fetcher: empty }).track({ number, carrier: id })).rejects.toBeInstanceOf(TrackingError);
    expect(empty).toHaveBeenCalledOnce();
  });
});

it('asks France over HTTP for a generic shipper reference and routes only after identity confirmation', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
  expect(detectCarrierMatch(reference)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['gofo-fr'] });
  expect(recognitionCandidates(reference).map(candidate => candidate.carrier)).toEqual(['gofo-fr']);
  expect(recognitionCandidates(reference, { phase: 'browser' })).toEqual([]);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('fr'));
  expect(await createTracker({ providers: [], fetcher }).track({ number: reference })).toMatchObject({ carrier: 'gofo-fr', source: 'gofo-fr' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, init] of fetcher.mock.calls) expect(JSON.parse(String(init?.body))).toEqual({ numberList: ['PK-0000000000000000001-0'] });
});
