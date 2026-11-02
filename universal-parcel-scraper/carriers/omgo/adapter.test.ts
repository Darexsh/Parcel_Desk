import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, OmgoTracker } from './adapter.js';

const NUMBER = 'OMGO0000000000001';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const page = () => new Response(fixture('tracking-page.html'));

describe('OMGO direct adapter', () => {
  it('bootstraps a fresh nonce and posts only the whole number through the caller transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response(fixture('tracking.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OmgoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 3000 }))
      .resolves.toMatchObject({ status: 'in_transit', destination_country: 'CA' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [pageUrl, pageInit] = fetcher.mock.calls[0]!;
    expect(String(pageUrl)).toMatch(/^https:\/\/omgoexpress\.cn\/track-package\/\?_=[0-9]+$/);
    expect(pageInit).toMatchObject({ headers: { 'User-Agent': 'SyntheticHost/1.0' }, signal: expect.any(AbortSignal) });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://omgoexpress.cn/wp-admin/admin-ajax.php');
    expect(init).toMatchObject({ method: 'POST', headers: { 'User-Agent': 'SyntheticHost/1.0' }, signal: expect.any(AbortSignal) });
    expect(Object.fromEntries((init!.body as FormData).entries())).toEqual({ action: 'shi_get_tracking_info', nonce: 'aabbccddee', tracking_codes: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'omgo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledOnce();
  });

  it('recognizes exact local-clock history without inventing an activity instant', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response(fixture('tracking.json')))
      .mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response(fixture('unknown.json')));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-05T10:45:00' });
    await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('X' + NUMBER)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response('Unavailable', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('distinguishes WordPress nonce rejection from missing shipments and browser protection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response('-1', { status: 403, headers: { 'Content-Type': 'text/html' } }));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'nonce_expired', cause: { status: 403 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid numbers and pre-aborted lookups before requesting a nonce', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'OMGO1' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends the second request within the remaining lookup budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.slice(1).every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps blocked HTML and malformed bootstrap distinct before submitting the number', async () => {
    for (const [body, kind] of [['<html><title>Just a moment...</title></html>', 'challenge'], ['<html>Changed page</html>', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('preserves blocked AJAX HTTP 200 and malformed JSON after a valid bootstrap', async () => {
    for (const [body, kind] of [['<html><title>Just a moment...</title></html>', 'challenge'], ['{', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response(body));
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
});
