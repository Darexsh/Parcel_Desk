// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { carrierDefinition } from '../../core/catalog/index.js';
import { detectCarrier } from '../../core/detection/index.js';
import { loadNumberCorpusFiles } from '../../core/testing/corpus.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { DEFAULT_USER_AGENT } from '../../core/transport/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { adapter, speeDeeProgressUrl, speeDeeUnanswered } from './adapter.js';
import { normalizeSpeeDeeNumber } from './parser.js';

const NUMBER = 'SP000000000000000017';
const URL_FOR_NUMBER = `https://packages.speedeedelivery.com/package_progress.php?v=detail&barcode=${NUMBER}`;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered.html');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const environment = (fetcher: typeof fetch, userAgent?: string) => ({ fetcher, userAgent, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

describe('Spee-Dee adapter', () => {
  it('is registered and sends one bounded GET for the package progress page', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html(DELIVERED));
    const registry = new AdapterRegistry(REGISTRY, environment(fetcher, 'ExampleHost/1.0'));
    expect(registry.adapterIdFor('spee-dee')).toBe('spee-dee');
    const instance = registry.for('spee-dee')!;
    expect(instance.steps).toEqual(['direct', 'trawl']);
    expect(instance.recognize).toBeUndefined();
    await expect(instance.track({ number: 'sp 0000 0000 0000 0000 17' })).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(URL_FOR_NUMBER);
    expect(speeDeeProgressUrl(NUMBER)).toBe(URL_FOR_NUMBER);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('User-Agent')).toBe('ExampleHost/1.0');
    expect(headers.has('Cookie')).toBe(false);
    expect(headers.has('Authorization')).toBe(false);
  });

  it("names itself with the default User-Agent when the host sets none", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html(DELIVERED));
    await adapter(environment(fetcher)).track({ number: NUMBER });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('User-Agent')).toBe(DEFAULT_USER_AGENT);
  });

  it('keeps recipient, signer, route and comment data out of the result', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html(DELIVERED));
    const result = await adapter(environment(fetcher)).track({ number: NUMBER });
    expect(result.events).toHaveLength(5);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Signed|Delivered to|00000\)|SP000000000000000025/);
  });

  it.each(['', 'SP123', 'SP00000000000000017', 'SPXABC000000000001', '1Z999AA10123456784', 'SP000000000000000017&v=x'])(
    'rejects %j before any request', async (number) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(adapter(environment(fetcher)).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('answers the not-found page as not found after one request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html(fixture('unknown.html')));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports another package, a challenge or a changed page without calling it missing', async () => {
    const answers: [string, string][] = [
      [DELIVERED.replaceAll(NUMBER, 'SP000000000000000033'), 'schema'],
      ['<html><head><title>Just a moment...</title></head><body></body></html>', 'challenge'],
      ['<html><body>Database error</body></html>', 'schema'],
    ];
    for (const [body, kind] of answers) {
      await expect(adapter(environment(vi.fn<typeof fetch>(async () => html(body)))).track({ number: NUMBER }))
        .rejects.toMatchObject({ kind });
    }
  });

  it.each([
    [403, 'challenge'], [401, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate'],
    [502, 'indeterminate'], [404, 'transport'], [410, 'transport'],
  ])('maps HTTP %i to %s, never to not found, after one request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>(async () => html('Failure', { status }));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the Retry-After of a rate limit', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html('Slow down', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
  });

  it('reads the host\'s per-minute search limit as a rate limit, never as an outage', async () => {
    const limit = 'Searching via Spee Dee Delivery\'s website is limited to 10 search requests per minute.';
    const fetcher = vi.fn<typeof fetch>(async () => html(limit, { status: 503, headers: { 'Retry-After': '60' } }));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const down = vi.fn<typeof fetch>(async () => html('Service Temporarily Unavailable', { status: 503, headers: { 'Retry-After': '60' } }));
    await expect(adapter(environment(down)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'maintenance', retryAfterMs: 60_000 });
  });

  it('does not follow a redirect away from the progress page', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 301, headers: { Location: '/elsewhere.php' } }));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a refused or silent connection as a transport failure', async () => {
    const failure = (cause: unknown) => new TypeError('fetch failed', { cause });
    const code = (value: string) => Object.assign(new Error(value), { code: value });
    const refused = vi.fn<typeof fetch>(async () => { throw failure(code('ECONNREFUSED')); });
    for (const error of [failure(code('ECONNREFUSED')), failure(code('UND_ERR_CONNECT_TIMEOUT')),
      failure(new AggregateError([code('ETIMEDOUT'), code('ENETUNREACH')])), failure(code('EHOSTUNREACH')),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')]) {
      const caught = await adapter(environment(async () => { throw error; })).track({ number: NUMBER }).catch((thrown: unknown) => thrown);
      expect(caught).toMatchObject({ kind: 'transport', reason: 'unanswered', message: expect.stringContaining('refuses some networks') });
      expect(speeDeeUnanswered(caught)).toBe(true);
    }
    // A failed name lookup, a bad certificate or a broken reply stays a plain
    // transport failure: no network filter is blamed, and the live test does
    // not skip it.
    for (const error of [failure(code('ENOTFOUND')), failure(code('CERT_HAS_EXPIRED')), failure(code('ECONNRESET'))]) {
      const caught = await adapter(environment(async () => { throw error; })).track({ number: NUMBER }).catch((thrown: unknown) => thrown);
      expect(caught).toMatchObject({ kind: 'transport' });
      expect((caught as Error).message).not.toContain('refuses');
      expect((caught as { reason?: unknown }).reason).toBeUndefined();
      expect(speeDeeUnanswered(caught)).toBe(false);
    }
    // A host that drops the connection holds the request until its own timeout, not the whole budget.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await adapter(environment(refused)).track({ number: NUMBER }, { budgetMs: 60_000 }).catch(() => undefined);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('blames no network filter when a reply starts and then stalls past the request limit', async () => {
    // The status and headers arrive, then the body stops until the request limit ends it.
    const stalled = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>'));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      },
    }), { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const shortened = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(ms === 10_000 ? 20 : ms));
    try {
      const caught = await adapter(environment(stalled)).track({ number: NUMBER }, { budgetMs: 60_000 }).catch((thrown: unknown) => thrown);
      expect(shortened).toHaveBeenCalledWith(10_000);
      expect(caught).toMatchObject({ kind: 'transport' });
      expect((caught as Error).message).not.toContain('refuses');
      expect((caught as { reason?: unknown }).reason).toBeUndefined();
      expect(speeDeeUnanswered(caught)).toBe(false);
      expect(stalled).toHaveBeenCalledTimes(1);
    } finally {
      shortened.mockRestore();
    }
  });

  it('fails a pre-aborted lookup without a request and passes cancellation and the budget to the request', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(adapter(environment(unused)).track({ number: NUMBER }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = vi.fn<typeof fetch>(async (_input, init) => {
      controller.abort(new Error('caller cancelled'));
      init?.signal?.throwIfAborted();
      return html(DELIVERED);
    });
    await expect(adapter(environment(cancelled)).track({ number: NUMBER }, { signal: controller.signal })).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledTimes(1);

    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(adapter(environment(slow)).track({ number: NUMBER }, { budgetMs: 20 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('bounds the page it reads, with room for the debug dumps it drops', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => html('x'.repeat(256 * 1024 + 1)));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    // Debug dumps in the comments, as the page has carried, count against the cap and are dropped.
    const dumps = `<!-- Array\n(\n${'    [scanloc] => PRIVATE\n    [scanepoch] => 1700000000\n'.repeat(3_000)})\n-->`;
    const page = DELIVERED.replace('</body>', `${dumps}</body>`);
    expect(page.length).toBeGreaterThan(128 * 1024);
    const result = await adapter(environment(vi.fn<typeof fetch>(async () => html(page)))).track({ number: NUMBER });
    expect(result.events).toHaveLength(5);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|1700000000/);
  });

  it('accepts every corpus number detection files under Spee-Dee', () => {
    const records = loadNumberCorpusFiles().find((file) => file.carrier === 'spee-dee')!.records;
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(detectCarrier(record.number)).toBe('spee-dee');
      expect(normalizeSpeeDeeNumber(record.number)).toBe(record.number);
    }
    expect(carrierDefinition('spee-dee')).toMatchObject({ timezone: 'UTC', tracking: { adapter: 'spee-dee', localClocks: true } });
  });
});


describe('Spee-Dee remote network recovery', () => {
  const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
  const reply = (html: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
    url: URL_FOR_NUMBER, html, statusCode: 200, tier: 1, ...extra,
  }));
  const setup = (fetcher: typeof fetch, recorder = NOOP_RECORDER) => adapter({ ...environment(fetcher), recorder,
    trawl: new TrawlClient('https://browser.invalid') });

  it('recovers through the configured transport, keeps the failed attempt and drops private fields', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockResolvedValueOnce(reply(DELIVERED));
    const step = vi.fn(), lookup = vi.fn();
    const result = await setup(fetcher, { step, lookup }).track({ number: NUMBER }, { budgetMs: 25_000 });
    expect(result.events).toHaveLength(5);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Signed|Delivered to|00000\)/);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://browser.invalid/scrape');
    expect(JSON.parse(String(init?.body))).toEqual({ url: URL_FOR_NUMBER, maxTier: 1, maxTimeout: 10_000 });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(step.mock.calls.map(([event]) => [event.step, event.outcome])).toEqual([['direct', 'transport'], ['trawl', 'ok']]);
    expect(step.mock.calls[1]![0]).toMatchObject({ fallbackFrom: 'direct', fallbackReason: 'transport', fallbackError: { reason: 'unanswered' } });
  });

  it.each([
    [html(DELIVERED), null],
    [html(fixture('unknown.html')), 'not_found'],
    [html('denied', { status: 403 }), 'challenge'],
    [html('slow', { status: 429 }), 'rate_limited'],
    [html('down', { status: 503 }), 'maintenance'],
    [html('changed'), 'schema'],
  ])('does not retry an answered direct request', async (response, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = setup(fetcher).track({ number: NUMBER });
    if (kind) await expect(pending).rejects.toMatchObject({ kind });
    else await expect(pending).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [fixture('unknown.html'), {}, 'not_found'],
    [DELIVERED.replaceAll(NUMBER, 'SP000000000000000033'), {}, 'schema'],
    ['<html><title>Just a moment...</title></html>', {}, 'challenge'],
    [DELIVERED, { url: 'https://packages.speedeedelivery.com/login' }, 'schema'],
    [DELIVERED, { tier: 2 }, 'schema'],
    ['x'.repeat(256 * 1024 + 1), {}, 'schema'],
  ])('validates remote identity, bounds and final outcome', async (body, extra, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockResolvedValueOnce(reply(body, extra));
    await expect(setup(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });

  it.each([[404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])(
    'preserves remote HTTP %i without treating a missing endpoint as a missing package', async (statusCode, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockResolvedValueOnce(
        reply('Unavailable', { statusCode, responseHeaders: { 'retry-after': '120' } }));
      const error = await setup(fetcher).track({ number: NUMBER }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      if (statusCode === 429 || statusCode === 503) expect(error).toMatchObject({ retryAfterMs: 120_000 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('reads the search limit the service relays as a rate limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockResolvedValueOnce(reply(
      'Searching via Spee Dee Delivery\'s website is limited to 10 search requests per minute.',
      { statusCode: 503, responseHeaders: { 'retry-after': '60' } }));
    await expect(setup(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
  });

  it('caps waiting for the service even when the caller has a larger budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockImplementationOnce((_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })));
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const shortened = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 10_000 ? 20 : ms));
    try {
      await expect(setup(fetcher).track({ number: NUMBER }, { budgetMs: 60_000 })).rejects.toMatchObject({ kind: 'transport' });
      expect(shortened).toHaveBeenCalledWith(10_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { shortened.mockRestore(); }
  });

  it('passes cancellation and the remaining budget through recovery', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockImplementationOnce(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).maxTimeout).toBeLessThanOrEqual(1000);
      controller.abort(new Error('cancelled'));
      expect(init?.signal?.aborted).toBe(true);
      init?.signal?.throwIfAborted();
      return reply(DELIVERED);
    });
    await expect(setup(fetcher).track({ number: NUMBER }, { signal: controller.signal, budgetMs: 1000 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
