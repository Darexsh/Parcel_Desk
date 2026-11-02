import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, lookupBudget, readerLanguage, type AdapterEnvironment } from './index.js';
import { TransportError } from '../errors/index.js';
import { trackCarrier } from './track.js';
import { NOOP_RECORDER } from '../telemetry/index.js';
import type { UniversalTracker } from '../../providers/universal.js';

const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER };

describe('consumer dispatch', () => {
  it('forwards parcel inputs and cancellation through the mapped adapter', async () => {
    const track = vi.fn().mockResolvedValue({ status: 'delivered', current_stage: 'delivered' });
    const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', steps: ['direct'], track }) },
      carriers: { alias: 'test' } }, environment);
    const signal = new AbortController().signal;
    const result = await trackCarrier('alias', { number: 'TEST0001', postcode: '00000' }, {
      registry, signal, universal: {} as UniversalTracker,
    });
    expect(result.current_stage).toBe('delivered');
    expect(track).toHaveBeenCalledWith({ number: 'TEST0001', postcode: '00000' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('holds back the scans an adapter enters at their planned time until they are due', async () => {
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const track = vi.fn().mockResolvedValue({ status: 'in_transit', last_update: soon, events: [
      { time: soon, description: 'Departed facility', stage: 'in_transit' },
      { time: '2026-01-02T09:00:00Z', description: 'Arrived at facility', stage: 'in_transit' },
    ] });
    const registry = (plannedScans: boolean) => new AdapterRegistry({ factories: { test: () => ({ id: 'test', steps: ['direct'], plannedScans, track }) },
      carriers: { test: 'test' } }, environment);
    const result = await trackCarrier('test', { number: 'TEST0001' }, { registry: registry(true), universal: {} as UniversalTracker });
    expect(result).toMatchObject({ last_status_text: 'Arrived at facility', last_update: '2026-01-02T09:00:00Z', events: [{ description: 'Arrived at facility' }] });
    expect(result.events).toHaveLength(1);
    // Another carrier's scan dated ahead keeps its time, for the app to flag.
    expect((await trackCarrier('test', { number: 'TEST0001' }, { registry: registry(false), universal: {} as UniversalTracker })).events).toHaveLength(2);
  });

  it('gives the adapter and the universal chain the normalized number, as createTracker() does', async () => {
    // A letter O typed in an S10 serial is the zero its check digit asks for.
    const track = vi.fn().mockResolvedValue({ status: 'in_transit' });
    const universal = { fetch: vi.fn().mockResolvedValue({ status: 'in_transit' }) } as unknown as UniversalTracker;
    const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', steps: ['direct'], track }) },
      carriers: { test: 'test', fallback: 'universal' } }, environment);
    await trackCarrier('test', { number: 'cio 0000001 4nl', postcode: '00000' }, { registry, universal });
    expect(track).toHaveBeenCalledWith({ number: 'CI000000014NL', postcode: '00000' });
    await trackCarrier('fallback', { number: 'CIO00000014NL' }, { registry, universal });
    expect(universal.fetch).toHaveBeenCalledWith('CI000000014NL', undefined, { signal: undefined, budgetMs: undefined }, undefined, 'fallback');
  });

  it('records one lookup and leaves an adapter that owns its steps to record them', async () => {
    const recorder = { ...NOOP_RECORDER, lookup: vi.fn(), step: vi.fn() };
    for (const recordsSteps of [false, true]) {
      recorder.lookup.mockClear();
      const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', recordsSteps,
        steps: ['direct'], track: async () => ({ status: 'in_transit' }) }) }, carriers: { test: 'test' } }, environment);
      await trackCarrier('test', { number: 'TEST0001' }, { registry, recorder, universal: {} as UniversalTracker });
      expect(recorder.lookup).toHaveBeenCalledTimes(recordsSteps ? 0 : 1);
    }
  });

  it('answers a cancelled lookup with the caller\'s reason and a spent budget with a budget failure', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    for (const recordsSteps of [false, true]) {
      const track = vi.fn().mockImplementation(async () => { controller.abort(reason); throw new TransportError('Test', 'interrupted'); });
      const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', recordsSteps, steps: ['direct'], track }) },
        carriers: { test: 'test' } }, environment);
      await expect(trackCarrier('test', { number: 'TEST0001' }, { registry, signal: controller.signal, universal: {} as UniversalTracker }))
        .rejects.toBe(reason);
    }
    const track = vi.fn();
    const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', steps: ['direct'], track }) }, carriers: { test: 'test' } }, environment);
    for (const budgetMs of [0, -5]) {
      await expect(trackCarrier('test', { number: 'TEST0001' }, { registry, budgetMs, universal: {} as UniversalTracker }))
        .rejects.toMatchObject({ kind: 'budget' });
    }
    await expect(trackCarrier('test', { number: 'TEST0001' }, { registry, budgetMs: Number.NaN, universal: {} as UniversalTracker }))
      .rejects.toThrow(TypeError);
    expect(track).not.toHaveBeenCalled();
  });

  it('gives a lookup one signal and one clock, and types a budget that is already spent', async () => {
    expect(() => lookupBudget({ signal: AbortSignal.abort(new Error('caller cancelled')) }, 1_000)).toThrow('caller cancelled');
    for (const spent of [0, -1]) expect(() => lookupBudget({ budgetMs: spent }, 1_000, 'dpd')).toThrow(expect.objectContaining({ kind: 'budget', provider: 'dpd' }));
    for (const unusable of [Number.NaN, Infinity]) expect(() => lookupBudget({ budgetMs: unusable }, 1_000)).toThrow(TypeError);
    const budget = lookupBudget({}, 250);
    expect(budget.budgetMs).toBe(250);
    expect(budget.remainingMs()).toBeGreaterThan(200);
    expect(budget.remainingMs()).toBeLessThanOrEqual(250);
    // A budget longer than a timer can hold is one that never ends the lookup, not one that ends it at once.
    for (const long of [2 ** 31, 2 ** 40]) {
      const held = lookupBudget({ budgetMs: long }, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(held.signal.aborted).toBe(false);
      expect(held.remainingMs()).toBeGreaterThan(2 ** 31 - 1_000);
      expect(held.remainingMs()).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  it("reads the primary subtag of the reader's language among those an adapter supports", () => {
    const supported = ['en', 'de', 'fr', 'it'] as const;
    expect(readerLanguage({ language: 'fr' }, supported)).toBe('fr');
    expect(readerLanguage({ language: 'de-CH' }, supported)).toBe('de');
    expect(readerLanguage({ language: ' IT_ch ' }, supported)).toBe('it');
    for (const language of [undefined, null, '', 'es', 'french', 'fr;q=0.9', 'zh-Hant-TW', 'f']) {
      expect(readerLanguage({ language }, supported)).toBeUndefined();
    }
    expect(readerLanguage({ language: 42 as unknown as string }, supported)).toBeUndefined();
  });

  it('refuses a placeholder number before any adapter is asked, and hands every other number on as given', async () => {
    // Methods that read their own adapter keep it.
    class Adapter {
      readonly id = 'test';
      readonly steps = ['direct'];
      readonly asked: unknown[][] = [];
      async track(...args: unknown[]) { this.asked.push(args); return { status: 'delivered' }; }
      async recognize(...args: unknown[]) { this.asked.push(args); return { known: true }; }
      async recognizeWithBrowser(...args: unknown[]) { this.asked.push(args); return { known: true, lastActivityAt: null }; }
    }
    const instance = new Adapter();
    const registry = new AdapterRegistry({ factories: { test: () => instance as never }, carriers: { test: 'test' } }, environment);
    const adapter = registry.for('test')!;
    for (const number of ['0000000000', 'TBA000000000000', '123456789', 'rr 123456785 cn']) {
      const refusal = { kind: 'invalid_input', provider: 'test', reason: 'placeholder_number' };
      await expect(trackCarrier('test', { number }, { registry, universal: {} as UniversalTracker })).rejects.toMatchObject(refusal);
      await expect(adapter.track({ number })).rejects.toMatchObject(refusal);
      await expect(adapter.recognize!(number)).resolves.toEqual({ known: false });
      await expect(adapter.recognizeWithBrowser!(number)).resolves.toEqual({ known: false, lastActivityAt: null });
    }
    expect(instance.asked).toEqual([]);
    await expect(adapter.track({ number: 'TEST0001' })).resolves.toEqual({ status: 'delivered' });
    await expect(adapter.recognize!('TEST0001')).resolves.toEqual({ known: true });
    expect(instance.asked).toEqual([[{ number: 'TEST0001' }], ['TEST0001']]);
  });

  it('uses the consumer-configured universal chain only for universal carriers, naming the carrier', async () => {
    const universal = { fetch: vi.fn().mockResolvedValue({ status: 'in_transit' }) } as unknown as UniversalTracker;
    const registry = new AdapterRegistry({ factories: {}, carriers: { test: 'universal', manual: null } }, environment);
    const signal = new AbortController().signal;
    await trackCarrier('test', { number: 'TEST0001', postcode: '00000', countryHint: 'FR' }, { registry, universal, signal, budgetMs: 5_000 });
    expect(universal.fetch).toHaveBeenCalledExactlyOnceWith('TEST0001', '00000', { signal, budgetMs: 5_000 }, 'FR', 'test');
    await expect(trackCarrier('manual', { number: 'TEST0001' }, { registry, universal })).rejects.toThrow('No tracking adapter');
  });
});
