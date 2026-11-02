import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { carrierDefinition } from '../../core/catalog/index.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { adapter } from './adapter.js';
import { CHINA_POST_APP_API, CHINA_POST_CHECK_PATH, CHINA_POST_TRACE_PATH } from './app.js';
import { chinaPostCodeStatus, chinaPostEnglish, chinaPostStateStatus, statusMap } from './status.js';
import { CHINA_POST_WEB_FLAG, CHINA_POST_WEB_TRACE } from './web.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'LZ123456785CN';
const BODY = JSON.stringify({ mailNo: NUMBER });
const HOST_USER_AGENT = 'ChinaPostTest/1.0';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers } });

/** Answers the check step and the trace with the given replies, in order. */
function transport(...replies: (() => Response)[]) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    init?.signal?.throwIfAborted();
    const next = replies.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  });
}

const open = () => json(text('check-open'));
const instance = (fetcher: typeof fetch) =>
  adapter({ fetcher, env: {}, userAgent: HOST_USER_AGENT, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('China Post adapter', () => {
  it('is the registered direct adapter for Chinese S10 numbers', () => {
    expect(REGISTRY.carriers['china-post']).toBe('china-post');
    expect(carrierDefinition('china-post').tracking).toMatchObject({ adapter: 'china-post', localClocks: true });
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'china-post', confidence: 'high' });
    const registry = new AdapterRegistry(REGISTRY, { fetcher: transport(), env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
    expect(registry.for('china-post')?.steps).toEqual(['direct', 'trawl']);
  });

  it('signs a check step then the trace, and returns the bound history', async () => {
    const fetcher = transport(open, () => json(text('delivered')));
    const result = await instance(fetcher).track({ number: 'lz123456785cn' });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'US', history_truncated: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const signatures = new Set<string>();
    for (const [index, path] of [CHINA_POST_CHECK_PATH, CHINA_POST_TRACE_PATH].entries()) {
      const [url, init] = fetcher.mock.calls[index]!;
      const headers = new Headers(init?.headers);
      expect(url).toBe(`${CHINA_POST_APP_API}${path}`);
      expect(init).toMatchObject({ method: 'POST', body: BODY, redirect: 'error' });
      // The included key signs each path; the signer's vectors are in app.test.ts.
      const signature = headers.get('user-sign')!;
      expect(signature).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      signatures.add(signature);
      expect(headers.get('user-channel')).toBe('APP');
      expect(headers.get('content-type')).toBe('application/json;charset=UTF-8');
      expect(headers.get('user-agent')).toBe(HOST_USER_AGENT);
      expect(headers.get('cookie')).toBeNull();
    }
    expect(signatures.size).toBe(2);
  });

  it('returns no courier, signer, recipient or map data', async () => {
    const result = await instance(transport(open, () => json(text('returned')))).track({ number: NUMBER });
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Returned' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|10000000000|11183|0\.00000|example\.invalid|签收|快递员|电话/);
  });

  it('rejects numbers outside its scope before any request', async () => {
    const fetcher = transport();
    for (const number of ['LZ123456780CN', 'LZ123456785FR', '1100000000000', 'XX12']) {
      await expect(instance(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops at the check step when the app would', async () => {
    const phone = transport(() => json('{"code":"000000","info":2,"msg":"SUCCESS"}'));
    await expect(instance(phone).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'input_required' });
    expect(phone).toHaveBeenCalledTimes(1);
    const closed = transport(() => json('{"code":"000000","info":3,"msg":"SUCCESS"}'));
    await expect(instance(closed).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(closed).toHaveBeenCalledTimes(1);
    const refused = transport(() => json(text('signature-refused')));
    await expect(instance(refused).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('asks the check step about a ZS number and reports its phone request', async () => {
    const phone = transport(() => json('{"code":"000000","info":2,"msg":"SUCCESS"}'));
    await expect(instance(phone).track({ number: 'ZS00000000001' }))
      .rejects.toMatchObject({ kind: 'input_required', field: 'recipient verification' });
    expect(phone).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(phone.mock.calls[0]![1]?.body))).toEqual({ mailNo: 'ZS00000000001' });
    const closed = transport(() => json('{"code":"000000","info":3,"msg":"SUCCESS"}'));
    await expect(instance(closed).track({ number: 'ZS00000000001' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('recognizes a ZS number China Post holds from the phone request alone', async () => {
    const zc = transport(() => json('{"code":"000000","info":2,"msg":"SUCCESS"}'));
    await expect(instance(zc).recognize!('ZC00000000001')).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(JSON.parse(String(zc.mock.calls[0]![1]?.body))).toEqual({ mailNo: 'ZC00000000001' });
    const za = transport(() => json('{"code":"000000","info":2,"msg":"SUCCESS"}'));
    await expect(instance(za).recognize!('ZA00000000001')).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(JSON.parse(String(za.mock.calls[0]![1]?.body))).toEqual({ mailNo: 'ZA00000000001' });
    const phone = transport(() => json('{"code":"000000","info":2,"msg":"SUCCESS"}'));
    await expect(instance(phone).recognize!('ZS00000000001')).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(phone).toHaveBeenCalledTimes(1);
    // "No information" answers unissued and unscanned numbers alike.
    const closed = transport(() => json('{"code":"000000","info":3,"msg":"SUCCESS"}'));
    await expect(instance(closed).recognize!('ZS00000000001')).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = transport();
    await expect(instance(fetcher).recognize!('ZS0000000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance(transport(open, () => json(text('delivered')))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    // Recognition's request is a recorded step.
    const step = vi.fn();
    await adapter({ fetcher: transport(open, () => json(text('delivered'))), env: {}, userAgent: HOST_USER_AGENT,
      recorder: { ...NOOP_RECORDER, step }, trawl: null, browserExecutablePath: null }).recognize!(NUMBER);
    expect(step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'china-post', step: 'direct', outcome: 'ok' }));
  });

  it.each([
    ['no-information', 'indeterminate', 'NoHistoryError'],
    ['trace-not-opened', 'indeterminate', 'IndeterminateError'],
    ['signature-refused', 'challenge', 'ChallengeError'],
  ])('keeps the %s trace reply %s instead of not found', async (name, kind, type) => {
    await expect(instance(transport(open, () => json(text(name)))).track({ number: NUMBER })).rejects.toMatchObject({ kind, name: type });
  });

  it('rejects another shipment and malformed replies', async () => {
    const other = text('delivered').replaceAll(NUMBER, 'LZ000000005CN');
    await expect(instance(transport(open, () => json(other))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(instance(transport(open, () => json('{"code":"000000"'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(instance(transport(() => json('[]'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('treats a web page in place of JSON as a challenge', async () => {
    const page = () => new Response('<!DOCTYPE html><html><title>安全验证</title></html>', { headers: { 'Content-Type': 'text/html' } });
    await expect(instance(transport(page)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(instance(transport(open, page)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    for (const fragment of ['<script>location.href="/verify"</script>', '<body>blocked</body>']) {
      const reply = () => new Response(fragment, { headers: { 'Content-Type': 'text/html' } });
      await expect(instance(transport(open, reply)).track({ number: NUMBER }), fragment).rejects.toMatchObject({ kind: 'challenge' });
    }
    // The ems.com.cn firewall's block page arrives with HTTP 405.
    const blocked = () => new Response('<html><title>405</title><body>您的访问被阻断。应用防火墙会尽快进行分析和确认。</body></html>',
      { status: 405, headers: { 'Content-Type': 'text/html' } });
    await expect(instance(transport(blocked)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(instance(transport(open, blocked)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    const refused = () => new Response('<html><title>error</title></html>', { status: 405, headers: { 'Content-Type': 'text/html' } });
    await expect(instance(transport(refused)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport', status: 405 });
  });

  it.each([
    [401, {}, { kind: 'challenge' }],
    [403, {}, { kind: 'challenge' }],
    [404, {}, { kind: 'transport', status: 404 }],
    [410, {}, { kind: 'transport', status: 410 }],
    [429, { 'Retry-After': '120' }, { kind: 'rate_limited', status: 429, retryAfterMs: 120_000 }],
    [500, {}, { kind: 'indeterminate', status: 500 }],
    [502, {}, { kind: 'indeterminate', status: 502 }],
    [503, {}, { kind: 'maintenance', status: 503 }],
  ])('maps HTTP %i without forwarding the signed request', async (status, headers, expected) => {
    const body = '{"code":"500","msg":"PRIVATE_BODY"}';
    for (const fetcher of [transport(() => json(body, status, headers)), transport(open, () => json(body, status, headers))]) {
      const error = await instance(fetcher).track({ number: NUMBER }).catch((caught: unknown) => caught);
      expect(error).toMatchObject(expected);
      expect(JSON.stringify(error)).not.toMatch(/PRIVATE_BODY|USER-SIGN|user-sign|mailNo/);
      expect((error as Error).cause).toBeUndefined();
      expect(error).not.toHaveProperty('request');
      expect(error).not.toHaveProperty('diagnostics');
    }
  });

  it('reports a network failure as transport without its cause', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed PRIVATE_SOCKET'); });
    const error = await instance(fetcher).track({ number: NUMBER }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'transport' });
    expect((error as Error).cause).toBeUndefined();
    expect(String((error as Error).message)).not.toContain('PRIVATE');
  });

  it('sends nothing for an aborted lookup and stops at once when aborted', async () => {
    const fetcher = transport();
    await expect(instance(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();

    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const stalled = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      signals.push(init!.signal!);
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = instance(stalled).track({ number: NUMBER }, { signal: controller.signal });
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it('ends the lookup when its budget is spent', async () => {
    const stalled = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    await expect(instance(stalled).track({ number: NUMBER }, { budgetMs: 20 })).rejects.toMatchObject({ kind: 'budget' });
    expect(stalled).toHaveBeenCalledTimes(1);
    await expect(instance(transport()).track({ number: NUMBER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it.each([
    ['phone gate', [() => json('{"code":"000000","info":2}')], 'input_required'],
    ['empty check', [() => json('{"code":"000000","info":3}')], 'indeterminate'],
    ['empty trace', [open, () => json('{"code":"000000","info":null}')], 'indeterminate'],
  ] as const)('recovers the app %s through the anonymous preview and keeps its provenance', async (_name, replies, reason) => {
    const number = 'ZS00000000001';
    const browserFetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toMatchObject({ url: `https://www.ems.com.cn/queryList?mailNo=${number}`,
        captureResponses: [CHINA_POST_WEB_FLAG, CHINA_POST_WEB_TRACE] });
      return json(JSON.stringify({ tier: 3, status: 'success', statusCode: 200, html: '', capturedResponses: [{
        url: CHINA_POST_WEB_TRACE, status: 200, trackingNumberSubmitted: number, headers: {},
        body: JSON.stringify({ success: true, match: true, scans: [{ number, time: '2030-01-02 12:30', code: 'O_051', state: '到达境外目的地' }] }),
      }] }));
    });
    const step = vi.fn(), lookup = vi.fn();
    const carrier = adapter({ fetcher: transport(...replies), env: {}, recorder: { step, lookup },
      trawl: new TrawlClient('http://browser.test', browserFetcher), browserExecutablePath: null });
    await expect(carrier.track({ number })).resolves.toMatchObject({ current_stage: 'in_transit', history_truncated: true });
    expect(step.mock.calls.map(([row]) => [row.step, row.outcome])).toEqual([['direct', reason], ['trawl', 'ok']]);
    expect(step.mock.calls[1]![0]).toMatchObject({ fallbackFrom: 'direct', fallbackReason: reason,
      fallbackErrorType: reason === 'indeterminate' ? 'NoHistoryError' : 'InputRequiredError' });
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ finalStep: 'trawl', outcome: 'ok' }));
  });

  it('keeps an empty browser answer inconclusive after an empty app answer', async () => {
    const number = 'ZS00000000001';
    const browserFetcher = vi.fn<typeof fetch>(async () => json(JSON.stringify({ tier: 3, status: 'success', statusCode: 200,
      html: '', capturedResponses: [{ url: CHINA_POST_WEB_FLAG, status: 200, trackingNumberSubmitted: number, headers: {},
        body: JSON.stringify({ success: false, reason: 'empty' }) }] })));
    const carrier = adapter({ fetcher: transport(() => json('{"code":"000000","info":3}')), env: {}, recorder: NOOP_RECORDER,
      trawl: new TrawlClient('http://browser.test', browserFetcher), browserExecutablePath: null });
    await expect(carrier.track({ number })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    expect(browserFetcher).toHaveBeenCalledTimes(1);
  });

  it('does not send other inconclusive app failures to the browser', async () => {
    for (const reply of [() => json(text('trace-not-opened')), () => json('{"code":"500","msg":"busy"}', 500)]) {
      const browserFetcher = vi.fn<typeof fetch>();
      const carrier = adapter({ fetcher: transport(open, reply), env: {}, recorder: NOOP_RECORDER,
        trawl: new TrawlClient('http://browser.test', browserFetcher), browserExecutablePath: null });
      await expect(carrier.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(browserFetcher).not.toHaveBeenCalled();
    }
  });

  it('keeps HTTP recognition out of the browser even when the app asks for phone digits', async () => {
    const browserFetcher = vi.fn<typeof fetch>();
    const carrier = adapter({ fetcher: transport(() => json('{"code":"000000","info":2}')), env: {}, recorder: NOOP_RECORDER,
      trawl: new TrawlClient('http://browser.test', browserFetcher), browserExecutablePath: null });
    await expect(carrier.recognize!('ZS00000000001')).resolves.toMatchObject({ known: true });
    expect(browserFetcher).not.toHaveBeenCalled();
  });

  it('keeps an empty HTTP recognition inconclusive without opening the browser', async () => {
    const browserFetcher = vi.fn<typeof fetch>();
    const carrier = adapter({ fetcher: transport(() => json('{"code":"000000","info":3}')), env: {}, recorder: NOOP_RECORDER,
      trawl: new TrawlClient('http://browser.test', browserFetcher), browserExecutablePath: null });
    await expect(carrier.recognize!('ZS00000000001')).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    expect(browserFetcher).not.toHaveBeenCalled();
  });

  it('records the same stage for every mapped code and label', () => {
    expect(statuses.carrier).toBe('china-post');
    for (const entry of statuses.entries as { code?: string; wording?: string; stage: string }[]) {
      const mapped = entry.code ? chinaPostCodeStatus(entry.code) : chinaPostStateStatus(entry.wording!);
      expect(mapped?.stage, entry.code ?? entry.wording).toBe(entry.stage);
    }
  });

  it('shows every state label in English, which its map answers with the same stage', () => {
    for (const entry of statuses.entries as { wording?: string; english?: string; stage: string }[]) {
      if (!entry.wording) continue;
      expect(entry.english, entry.wording).toBeTruthy();
      expect(chinaPostEnglish(entry.wording), entry.wording).toBe(entry.english);
      expect(statusMap.stage(null, normalizeStatusWording(entry.english!)), entry.english).toBe(entry.stage);
    }
  });
});
