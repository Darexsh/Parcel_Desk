import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EmileTracker } from './adapter.js';

const NUMBER = 'EM000000000001CA';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Emile HTTP adapter', () => {
  it('uses one anonymous XML POST through the supplied transport and records it once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EmileTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.emileps.com/emile/track');
    expect(init).toMatchObject({ method: 'POST', headers: { Accept: 'application/xml', 'Content-Type': 'application/xml', 'User-Agent': 'SyntheticHost/1.0' },
      body: `<tracks><language>en</language><track><barcode>${NUMBER}</barcode></track></tracks>`, signal: expect.any(AbortSignal) });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'emile', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps detection ambiguous, makes Emile eligible for HTTP recognition and routes a confirmed number', async () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['emile'] });
    expect(recognitionAskedCarriers(NUMBER)).toEqual(['emile']);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture()));
    // Recognition deliberately leaves old shipments unselected because numbers
    // can be reused. Keep this synthetic history recent for the routing check.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    try {
      const response = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER }, { budgetMs: 3000 });
      expect(response).toMatchObject({ carrier: 'emile', source: 'emile', result: { current_stage: 'delivered', events: expect.any(Array) } });
      expect(fetcher.mock.calls.every(([url]) => String(url) === 'https://www.emileps.com/emile/track')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('recognizes matching activity and explicit absence without a browser or recipient inputs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture())).mockResolvedValueOnce(new Response(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-03T16:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('EM000000001CA')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Unavailable', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('rejects invalid inputs and pre-aborted lookups without sending requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '<track/>' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging HTTP read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves blocked HTTP 200 and malformed replies instead of calling them missing parcels', async () => {
    for (const [body, kind] of [['<html><title>Just a moment...</title></html>', 'challenge'], ['<root>', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
    }
  });
});
