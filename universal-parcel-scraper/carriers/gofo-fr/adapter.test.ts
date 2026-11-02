import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter as spainAdapter, GofoSpainTracker } from '../gofo-es/adapter.js';
import { adapter as italyAdapter, GofoItalyTracker } from '../gofo-it/adapter.js';
import { adapter as netherlandsAdapter, GofoNetherlandsTracker } from '../gofo-nl/adapter.js';
import { adapter as franceAdapter, GofoFranceTracker } from './adapter.js';

const cases = [
  { region: 'fr', number: 'GFFR00000000000001', adapter: franceAdapter, Tracker: GofoFranceTracker },
  { region: 'it', number: 'GFIT00000000000001', adapter: italyAdapter, Tracker: GofoItalyTracker },
  { region: 'nl', number: 'GFNL00000000000001', adapter: netherlandsAdapter, Tracker: GofoNetherlandsTracker },
  { region: 'es', number: 'GFES00000000000001', adapter: spainAdapter, Tracker: GofoSpainTracker },
];
const reply = (region: string) => new Response(readFileSync(new URL(`../gofo-${region}/fixtures/delivered.json`, import.meta.url), 'utf8'));

describe.each(cases)('GOFO $region direct retrieval', ({ region, number, adapter, Tracker }) => {
  it('uses one anonymous national POST with the host user agent, signal and HTTP recognition', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(region));
    const instance = adapter({ fetcher, userAgent: 'ParcelTest/1.0', trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await instance.track({ number: number.toLowerCase() });
    expect(await instance.recognize!(number)).toMatchObject({ known: true, lastActivityAt: expect.any(String) });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe(`https://www.gofo.com/${region}/open-api/official/track/queryTrackV2`);
      expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
      expect(JSON.parse(String(init?.body))).toEqual({ numberList: [number] });
      const headers = new Headers(init?.headers); expect(headers.get('lang')).toBe(region); expect(headers.get('User-Agent')).toBe('ParcelTest/1.0');
      expect(headers.has('Cookie') || headers.has('Authorization')).toBe(false); expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('answers an empty valid lookup as no history during tracking and keeps recognition inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"code":200,"data":[]}'));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.track({ number })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(instance.recognize!(number)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(await instance.recognize!('GFUS00000000000001')).toEqual({ known: false }); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s separate from absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new Tracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind }); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retains an HTTP 200 challenge and rejects malformed or oversized responses', async () => {
    const challenge = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/a"></script></html>'));
    await expect(new Tracker({ fetcher: challenge }).fetch(number)).rejects.toMatchObject({ kind: 'challenge' });
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Failure</html>'));
    await expect(new Tracker({ fetcher: malformed }).fetch(number)).rejects.toMatchObject({ kind: 'schema' });
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new Tracker({ fetcher: huge }).fetch(number)).rejects.toThrow('unexpectedly large');
  });

  it('rejects invalid input and cancellation before I/O and aborts a slow request within the remaining budget', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new Tracker({ fetcher: unused }).fetch(`${number}&other=1`)).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new Tracker({ fetcher: unused }).fetch(number, { signal: AbortSignal.abort() })).rejects.toThrow(); expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return new Response('{}');
    });
    await expect(new Tracker({ fetcher: slow }).fetch(number, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(slow.mock.calls.length).toBeLessThanOrEqual(1);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });
});

it('prints the French shipper reference exactly for the request after facade normalization', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('fr'));
  await new GofoFranceTracker({ fetcher }).fetch('PK00000000000000000010');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ numberList: ['PK-0000000000000000001-0'] });
});
