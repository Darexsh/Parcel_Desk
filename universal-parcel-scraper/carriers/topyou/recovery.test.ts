import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, TOPYOU_API } from './adapter.js';
import { TOPYOU_MAX_BYTES } from './parser.js';

const NUMBER = 'TYZRZ0000000001YQ';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const notFound = fixture('not-found').replaceAll('TYZRZ0000000009YQ', NUMBER);
const announced = fixture('announced').replaceAll('TYZRZ0000000002YQ', NUMBER);
const remote = (html = delivered, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  url: TOPYOU_API, statusCode: 200, tier: 1, html, ...extra,
}));
const setup = (fetcher: typeof fetch, recorder = NOOP_RECORDER) => adapter({
  fetcher, recorder, userAgent: 'SyntheticHost/1.0', env: {}, trawl: new TrawlClient('https://service.test'), browserExecutablePath: null,
});

describe('TopYou TRAWL HTTP recovery', () => {
  it.each(['network', 'challenge'] as const)('recovers a %s failure with the same POST through the supplied transport', async failure => {
    const fetcher = vi.fn<typeof fetch>();
    if (failure === 'network') fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    else fetcher.mockResolvedValueOnce(new Response('<html><title>Just a moment...</title></html>'));
    fetcher.mockResolvedValueOnce(remote());
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const result = await setup(fetcher, recorder).track({ number: NUMBER });
    expect(result).toMatchObject({ current_stage: 'delivered' });
    expect(result.events).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://service.test/scrape');
    expect(JSON.parse(String(init?.body))).toEqual({ url: TOPYOU_API, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' },
      body: JSON.stringify({ ids: [NUMBER] }), maxTier: 1, maxTimeout: 12_000 });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(recorder.step.mock.calls.map(([event]) => [event.step, event.outcome]))
      .toEqual([['direct', failure === 'network' ? 'transport' : 'challenge'], ['trawl', 'ok']]);
    expect(recorder.step.mock.calls[1]![0]).toMatchObject({ fallbackFrom: 'direct', fallbackReason: failure === 'network' ? 'transport' : 'challenge' });
  });

  it('reads the service’s serialized HTTP response bytes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(remote('', { body: { type: 'Buffer', data: [...new TextEncoder().encode(delivered)] } }));
    await expect(setup(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it.each([
    [delivered, 200, null], [notFound, 200, 'not_found'], [announced, 200, 'indeterminate'],
    ['{}', 200, 'schema'], ['', 429, 'rate_limited'], ['', 503, 'maintenance'], ['', 404, 'transport'], ['', 410, 'transport'],
  ])('does not repeat an answered direct request', async (body, status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { status }));
    const pending = setup(fetcher).track({ number: NUMBER });
    if (kind) await expect(pending).rejects.toMatchObject({ kind });
    else await expect(pending).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [notFound, {}, 'not_found'], [announced, {}, 'indeterminate'],
    [delivered.replaceAll(NUMBER, 'TYZRZ0000000008YQ'), {}, 'indeterminate'],
    ['<html><title>Just a moment...</title></html>', {}, 'challenge'],
    ['{}', {}, 'schema'], [delivered, { url: 'https://track.szty56.com/login' }, 'transport'],
    [delivered, { tier: 2 }, 'transport'], ['x'.repeat(TOPYOU_MAX_BYTES + 1), {}, 'schema'],
  ])('validates remote identity, outcome, endpoint and size', async (body, extra, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(remote(body, extra));
    await expect(setup(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])(
    'preserves remote HTTP %i as %s', async (statusCode, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(remote('', { statusCode, responseHeaders: { 'retry-after': '120' } }));
      const error: unknown = await setup(fetcher).track({ number: NUMBER }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      if (statusCode === 429 || statusCode === 503) expect(error).toMatchObject({ retryAfterMs: 120_000 });
    });

  it('keeps HTTP recognition independent of the configured service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><title>Just a moment...</title></html>'));
    await expect(setup(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(TOPYOU_API);
  });

  it('reserves transport time and starts no service call when the budget cannot fit it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(setup(fetcher).track({ number: NUMBER }, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation and the remaining budget to recovery', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).maxTimeout).toBeLessThanOrEqual(1000);
      controller.abort(new Error('cancelled'));
      expect(init?.signal?.aborted).toBe(true);
      init?.signal?.throwIfAborted();
      return remote();
    });
    await expect(setup(fetcher).track({ number: NUMBER }, { signal: controller.signal, budgetMs: 16_000 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
