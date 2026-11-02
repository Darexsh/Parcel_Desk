import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment } from '../../core/adapter/index.js';
import { trackCarrier } from '../../core/adapter/track.js';
import { carrierAdapter, carrierDefinition, tracksAutomatically } from '../../core/catalog/index.js';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker, TrackingError } from '../../facade/index.js';
import { REGISTRY } from '../../generated/registry.js';
import type { UniversalTracker } from '../../providers/universal.js';

const number = 'EM000000000001CA';
const consolidator = 'YT0000000000000001';
const history: unknown = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const reply = () => new Response(JSON.stringify(history), { headers: { 'Content-Type': 'application/json' } });
const direct = () => new Response(readFileSync(new URL('./fixtures/delivered.xml', import.meta.url), 'utf8'));
const absent = () => new Response(readFileSync(new URL('./fixtures/not-found.xml', import.meta.url), 'utf8'));
const endpoint = 'https://www.emileps.com/emile/track';

describe('Emile catalog and tracking', () => {
  it('uses an enabled provider after the direct service explicitly finds no history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url) === endpoint ? absent() : reply());
    const answer = await createTracker({ providers: ['ParcelsApp'], fetcher }).track({ number, carrier: 'emile' });
    expect(answer).toMatchObject({
      carrier: 'emile', source: 'ParcelsApp', attempts: [{ source: 'emile', kind: 'not_found' }, { source: 'ParcelsApp', kind: 'ok' }],
      result: { status: 'delivered', current_stage: 'delivered' },
    });
    expect(answer.result.events.map(event => [event.time, event.description])).toEqual([
      ['2026-01-06T15:00:00.000Z', 'Delivered'],
      ['2026-01-06T13:00:00.000Z', 'OUT FOR DELIVERY'],
      ['2026-01-05T18:00:00.000Z', 'ORDER SORTED'],
      ['2026-01-05T09:00:00.000Z', 'ARRIVE TRANSITHUB'],
      ['2026-01-02T08:00:00.000Z', 'Shipment information received'],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(endpoint);
    expect(String(fetcher.mock.calls[1]![0])).toBe('https://parcelsapp.com/api/v2/parcels');
  });

  it('dispatches a consumer router\'s Emile lookup to its direct adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => direct());
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const universalFetch = vi.fn().mockResolvedValue({ status: 'in_transit', current_stage: 'in_transit', tracking_provider: 'ParcelsApp',
      events: [{ time: '2026-01-05T09:00:00Z', description: 'ARRIVE TRANSITHUB', stage: 'in_transit' }] });
    const universal = { fetch: universalFetch } as unknown as UniversalTracker;
    const signal = new AbortController().signal;
    const result = await trackCarrier('emile', { number, postcode: null }, { registry, universal, signal, budgetMs: 5_000 });
    expect(universalFetch).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('leaves an unconfirmed number unknown when only a provider has history', async () => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['emile'] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url) === endpoint ? absent() : reply());
    const answer = await createTracker({ providers: ['ParcelsApp'], fetcher }).track({ number });
    expect(answer).toMatchObject({ carrier: 'unknown', source: 'ParcelsApp' });
  });

  it('keeps provider fallbacks opt-in and advertises a direct adapter without an assumed scan timezone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => absent());
    expect(carrierAdapter('emile')).toBe('emile');
    expect(tracksAutomatically('emile')).toBe(true);
    expect(carrierDefinition('emile').timezone).toBe('UTC');
    await expect(createTracker({ fetcher, providers: [] }).track({ number, carrier: 'emile' })).rejects.toBeInstanceOf(TrackingError);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(endpoint);
  });

  it('confirms a consolidator\'s proposed handoff through Emile\'s own service', async () => {
    expect(hasDirectHandoffAdapter('emile', number)).toBe(true);
    expect(deliveryHandoff('yunexpress', consolidator, { delivery_carrier: 'emile', delivery_tracking_number: number }))
      .toMatchObject({ carrier: 'emile', number });
    const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
    const track = vi.fn().mockResolvedValue({
      status: 'in_transit', delivery_carrier: 'emile', delivery_tracking_number: number,
      events: [{ time: '2026-01-05T09:00:00Z', description: 'ARRIVE TRANSITHUB', stage: 'in_transit' }],
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => direct());
    const configured = new AdapterRegistry({ factories: { ...REGISTRY.factories,
      yunexpress: () => ({ id: 'yunexpress', steps: ['direct'], track }) }, carriers: REGISTRY.carriers }, { ...environment, fetcher });
    const answer = await createTracker({ registry: configured, providers: ['ParcelsApp'], fetcher }).track({ number: consolidator, carrier: 'yunexpress' });
    expect(answer).toMatchObject({ carrier: 'yunexpress', source: 'yunexpress', result: { delivery_carrier: 'emile', delivery_tracking_number: number } });
    expect(answer.handoff).toMatchObject({ carrier: 'emile', number, confirmed: true, result: { current_stage: 'delivered' } });
    expect(track).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(endpoint);
  });
});
