import { describe, expect, it, vi } from 'vitest';
import { UpstreamHttpError } from '../errors/index.js';
import { TrawlClient, TrawlError, trawlBody, trawlEndpoint } from './trawl.js';

function jsonFetcher(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('trawlEndpoint', () => {
  it('normalizes configured URLs to the service root', () => {
    expect(trawlEndpoint('http://trawl:8191/v1').toString()).toBe('http://trawl:8191/');
    expect(trawlEndpoint('http://trawl:8191/scrape/').toString()).toBe('http://trawl:8191/');
    expect(trawlEndpoint('https://trawl.internal/base/?x=1#y').toString()).toBe('https://trawl.internal/base');
    expect(() => trawlEndpoint('ftp://trawl')).toThrow('FLARESOLVERR_URL must be an HTTP(S) URL');
    expect(() => trawlEndpoint('not a url')).toThrow('FLARESOLVERR_URL must be an HTTP(S) URL');
  });

  it('builds the client from the environment only when configured', () => {
    expect(TrawlClient.fromEnvironment({})).toBeNull();
    expect(TrawlClient.fromEnvironment({ FLARESOLVERR_URL: ' http://trawl:8191 ' })?.scrapeUrl().toString()).toBe('http://trawl:8191/scrape');
    expect(new TrawlClient('http://trawl:8191/v1').commandUrl().toString()).toBe('http://trawl:8191/v1');
  });
});

describe('TrawlClient.scrape', () => {
  const options = { provider: 'TRAWL while fetching UPS', timeoutMs: 1_000 };

  it('returns the solved page with cookies and captured responses', async () => {
    const fetcher = jsonFetcher({
      url: 'https://example.test/track', html: '<html/>', tier: 3, statusCode: 200, userAgent: 'UA',
      cookies: [{ name: 'a', value: 'b' }, 'junk'],
      capturedResponses: [{ url: 'https://example.test/api', status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } }],
    });
    const client = new TrawlClient('http://trawl:8191', fetcher);
    const result = await client.scrape({ url: 'https://example.test/track', skipHttp: true, maxTier: 3, maxTimeout: 1_000 }, options);
    expect(result).toMatchObject({ url: 'https://example.test/track', html: '<html/>', tier: 3, statusCode: 200, userAgent: 'UA', cookies: [{ name: 'a', value: 'b' }] });
    expect(result.capturedResponses).toEqual([expect.objectContaining({ url: 'https://example.test/api', status: 200, body: '{"ok":true}', truncated: false })]);
    const [url, init] = (fetcher as unknown as { mock: { calls: [URL, RequestInit][] } }).mock.calls[0]!;
    expect(url.toString()).toBe('http://trawl:8191/scrape');
    expect(JSON.parse(String(init.body))).toMatchObject({ url: 'https://example.test/track', skipHttp: true, maxTier: 3 });
  });

  it('retains a carrier helper’s whole-number request binding across the service boundary', async () => {
    const client = new TrawlClient('http://trawl:8191', jsonFetcher({ html: '', body: [], tier: 3, statusCode: 200,
      capturedResponses: [{ url: 'https://example.test/api', status: 200, body: '{}', trackingNumberSubmitted: 'ASE00000000' }] }));
    const result = await client.scrape({ url: 'https://example.test/track' }, { ...options, requireSolved: false });
    expect(result.capturedResponses[0]).toMatchObject({ trackingNumberSubmitted: 'ASE00000000' });
  });

  it('can retain the latest bounded capture sequence without changing the default window or service request', async () => {
    const captures = Array.from({ length: 60 }, (_, index) => ({ url: 'https://example.test/api', status: index === 59 ? 429 : 200,
      headers: index === 59 ? { 'retry-after': '60' } : {}, body: String(index) }));
    const fetcher = jsonFetcher({ html: '<html/>', tier: 3, statusCode: 200, capturedResponses: captures });
    const client = new TrawlClient('http://trawl:8191', fetcher);
    const first = await client.scrape({ url: 'https://example.test/track' }, options);
    const last = await client.scrape({ url: 'https://example.test/track' }, { ...options, captureWindow: 'last' });
    expect(first.capturedResponses).toHaveLength(50);
    expect(first.capturedResponses[0]?.body).toBe('0');
    expect(first.capturedResponses.at(-1)?.body).toBe('49');
    expect(last.capturedResponses).toHaveLength(50);
    expect(last.capturedResponses[0]?.body).toBe('10');
    expect(last.capturedResponses.at(-1)).toMatchObject({ status: 429, headers: { 'retry-after': '60' }, body: '59' });
    const calls = (fetcher as unknown as { mock: { calls: [URL, RequestInit][] } }).mock.calls;
    expect(calls.map(([, init]) => JSON.parse(String(init.body))))
      .toEqual([{ url: 'https://example.test/track' }, { url: 'https://example.test/track' }]);
  });

  it('turns service errors and unsolved tiers into transport errors, and page statuses into HTTP errors', async () => {
    const client = (payload: unknown) => new TrawlClient('http://trawl:8191', jsonFetcher(payload));
    await expect(client({ error: 'browser crashed' }).scrape({ url: 'https://e.test' }, options)).rejects.toMatchObject({ name: 'TrawlError', kind: 'transport', message: 'browser crashed' });
    for (const error of [{ message: 'browser crashed' }, ['browser crashed']]) {
      await expect(client({ error }).scrape({ url: 'https://e.test' }, options)).rejects.toMatchObject({
        kind: 'transport', message: 'The browser service could not fetch the page',
      });
    }
    await expect(client({ html: '<html/>', tier: 1, statusCode: 200 }).scrape({ url: 'https://e.test' }, options)).rejects.toBeInstanceOf(TrawlError);
    await expect(client({ html: '<html/>', tier: 3, statusCode: 429 }).scrape({ url: 'https://e.test' }, options)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(client({ html: '<html/>', tier: 3, statusCode: 404 }).scrape({ url: 'https://e.test' }, options)).rejects.toBeInstanceOf(UpstreamHttpError);
    await expect(client({ html: '<html/>', tier: 1, statusCode: 200 }).scrape({ url: 'https://e.test' }, { ...options, requireSolved: false })).resolves.toMatchObject({ tier: 1 });
  });

  it.each([
    [{ 'retry-after': '120' }, 120_000],
    [{ 'Retry-After': 'Tue, 01 Jan 2030 00:01:00 GMT' }, 60_000],
    [{ 'retry-after': 'Mon, 31 Dec 2029 23:59:00 GMT' }, 0],
    [{ 'retry-after': 'invalid' }, undefined],
    [{ 'retry-after': { seconds: 120 } }, undefined],
    [null, undefined],
  ])('preserves a captured page cooldown without forwarding response details', async (responseHeaders, retryAfterMs) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00Z'));
    try {
      const client = new TrawlClient('http://trawl:8191', jsonFetcher({ statusCode: 429, responseHeaders }));
      await expect(client.scrape({ url: 'https://e.test' }, options)).rejects.toMatchObject({
        kind: 'rate_limited', retryAfterMs, diagnostics: undefined, request: undefined,
      });
    } finally { now.mockRestore(); }
  });

  it.each([
    ['blocked', 429, 'rate_limited', 90_000],
    ['blocked', 403, 'challenge', 90_000],
    ['needs-js', 200, 'challenge', undefined],
    ['error', 503, 'maintenance', 90_000],
  ])('reads the single HTTP-tier failure inside the service error envelope', async (status, statusCode, kind, retryAfterMs) => {
    const fetcher = jsonFetcher({ error: 'Max tier reached without success', timings: [{
      tier: 1, status, statusCode, responseHeaders: { 'retry-after': '90', 'set-cookie': 'PRIVATE' },
      body: 'PRIVATE challenge material',
    }] }, 500);
    const client = new TrawlClient('http://trawl:8191', fetcher);
    const error: unknown = await client.scrape({ url: 'https://e.test', maxTier: 1 }, options).catch(caught => caught);
    expect(error).toMatchObject({ kind, retryAfterMs });
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: 'Other failure', timings: [{ tier: 1, status: 'blocked', statusCode: 429 }] },
    { error: 'Max tier reached without success', timings: [{ tier: 2, status: 'blocked', statusCode: 429 }] },
    { error: 'Max tier reached without success', timings: [{ tier: 1, status: 'blocked', statusCode: 429 }, { tier: 1, status: 'error' }] },
    { error: 'Max tier reached without success', timings: [{ tier: 1, status: 'error' }] },
  ])('does not infer a page outcome from an ambiguous service failure', async payload => {
    const fetcher = jsonFetcher(payload, 500);
    await expect(new TrawlClient('http://trawl:8191', fetcher).scrape({ url: 'https://e.test', maxTier: 1 }, options))
      .rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('solves through the legacy command API', async () => {
    const fetcher = jsonFetcher({ status: 'ok', solution: { status: 200, response: '<html>solved</html>' } });
    const client = new TrawlClient('http://trawl:8191', fetcher);
    await expect(client.solve('https://e.test/page', options)).resolves.toBe('<html>solved</html>');
    const [url, init] = (fetcher as unknown as { mock: { calls: [URL, RequestInit][] } }).mock.calls[0]!;
    expect(url.toString()).toBe('http://trawl:8191/v1');
    expect(JSON.parse(String(init.body))).toEqual({ cmd: 'request.get', url: 'https://e.test/page', maxTimeout: 1_000, solveEmbeddedCaptchas: true });
    await expect(new TrawlClient('http://trawl:8191', jsonFetcher({ status: 'error' })).solve('https://e.test', options)).rejects.toBeInstanceOf(TrawlError);
  });
});

describe('trawlBody', () => {
  it('decodes the body representations used by different service releases', () => {
    expect(trawlBody({ body: 'plain' })).toBe('plain');
    expect(trawlBody({ body: [104, 105] })).toBe('hi');
    expect(trawlBody({ body: { type: 'Buffer', data: [104, 105] } })).toBe('hi');
    expect(trawlBody({ body: { '0': 104, '1': 105 } })).toBe('hi');
    expect(trawlBody({ body: { '1': 104 } })).toBe('');
    expect(trawlBody({ body: [300] })).toBe('');
    expect(trawlBody({})).toBe('');
  });
});

describe('dead browser recovery', () => {
  const closed = () => Response.json({ error: 'Max tier reached without success', timings: [
    { reason: 'newPage: Target page, context or browser has been closed' },
  ] }, { status: 500 });
  const options = { provider: 'TRAWL', timeoutMs: 30_000 };
  it('retries once only after readiness confirms spare live browser capacity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(closed())
      .mockResolvedValueOnce(Response.json({ status: 'ok', pool: { live: 1, available: 1 } }))
      .mockResolvedValueOnce(Response.json({ tier: 3, statusCode: 200, html: '<html/>', cookies: [] }));
    await expect(new TrawlClient('http://trawl:8191', fetcher).scrape({ url: 'https://example.test' }, options))
      .resolves.toMatchObject({ statusCode: 200 });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'http://trawl:8191/scrape', 'http://trawl:8191/health', 'http://trawl:8191/scrape',
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body)).maxTimeout).toBeLessThan(30_000);
  });
  it('does not retry a saturated or still-restarting pool', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(closed())
      .mockResolvedValueOnce(Response.json({ status: 'ok', pool: { live: 1, available: 0 } }));
    await expect(new TrawlClient('http://trawl:8191', fetcher).scrape({ url: 'https://example.test' }, options)).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not loop when the replacement browser also fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(closed())
      .mockResolvedValueOnce(Response.json({ status: 'ok', pool: { live: 1, available: 1 } }))
      .mockResolvedValueOnce(closed());
    await expect(new TrawlClient('http://trawl:8191', fetcher).scrape({ url: 'https://example.test' }, options)).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not start or recover a cancelled scrape', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return closed();
    });
    const client = new TrawlClient('http://trawl:8191', fetcher);
    await expect(client.scrape({ url: 'https://example.test' }, { ...options, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.scrape({ url: 'https://example.test' }, { ...options, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a deadline as a browser service that did not answer, and a cancellation as the caller gave it', async () => {
    const stalled = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const client = new TrawlClient('http://trawl:8191', stalled);
    // The lookup's budget timer: the service's own allowance would outlast it.
    for (const call of [
      () => client.scrape({ url: 'https://example.test' }, { ...options, signal: AbortSignal.timeout(20) }),
      () => client.solve('https://example.test', { ...options, signal: AbortSignal.timeout(20) }),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'transport', cause: expect.objectContaining({ name: 'TimeoutError' }) });
    }
    const expired = AbortSignal.abort(new DOMException('The operation timed out', 'TimeoutError'));
    await expect(client.scrape({ url: 'https://example.test' }, { ...options, signal: expired })).rejects.toMatchObject({ name: 'TrawlError', kind: 'transport' });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = client.scrape({ url: 'https://example.test' }, { ...options, signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(stalled).toHaveBeenCalledTimes(3);
  });

  it('cancels readiness without starting a second browser attempt', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(closed()).mockImplementationOnce(async (_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Response.json({ status: 'ok', pool: { live: 1, available: 1 } });
    });
    await expect(new TrawlClient('http://trawl:8191', fetcher).scrape({ url: 'https://example.test' },
      { ...options, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation to the recovery request while preserving the caller fetcher', async () => {
    const controller = new AbortController();
    const unused = vi.fn<typeof fetch>();
    const override = vi.fn<typeof fetch>().mockResolvedValueOnce(closed())
      .mockResolvedValueOnce(Response.json({ status: 'ok', pool: { live: 1, available: 1 } }))
      .mockImplementationOnce(async (_input, init) => {
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        return Response.json({ tier: 3, statusCode: 200, html: '<html/>' });
      });
    await expect(new TrawlClient('http://trawl:8191', unused).scrape({ url: 'https://example.test' },
      { ...options, fetcher: override, signal: controller.signal })).rejects.toThrow();
    expect(override).toHaveBeenCalledTimes(3);
    expect(unused).not.toHaveBeenCalled();
  });
});
