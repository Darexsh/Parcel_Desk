// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../../core/transport/index.js';
import { adapter, SagawaTracker } from './adapter.js';
import { SAGAWA_APP_KEY, SAGAWA_APP_USER_AGENT, SAGAWA_WIDGET_API, sagawaUserAgent } from './app.js';
import { normalizeSagawaNumber, parseSagawaWidget, sagawaRejection } from './parser.js';
import { sagawaState, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '300000000005';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered.json');
const NO_DATA = fixture('no-data.json');
const REFUSED = fixture('registration-refused.json');
const DENIED = fixture('access-denied.html');
const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json', ...headers } });
const html = (status: number, headers: Record<string, string> = {}) =>
  new Response(DENIED, { status, headers: { 'Content-Type': 'text/html', ...headers } });
const widget = (change: (info: Record<string, unknown>) => void) => {
  const payload = JSON.parse(DELIVERED) as { baggageInfo: Record<string, unknown> };
  change(payload.baggageInfo);
  return payload;
};
const environment = (fetcher: typeof fetch, userAgent?: string) =>
  ({ fetcher, env: {}, userAgent, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
const track = (fetcher: typeof fetch, number = NUMBER) => adapter(environment(fetcher)).track({ number });

describe('Sagawa Express waybill', () => {
  it('takes a 10- or 12-digit waybill and drops the printed hyphens', () => {
    expect(normalizeSagawaNumber(' 3000-0000-0005 ')).toBe(NUMBER);
    expect(normalizeSagawaNumber('1234567890')).toBe('1234567890');
    for (const number of ['12345678901', '3000000000051', '30000000000A', '', '9'.repeat(65)]) {
      expect(() => normalizeSagawaNumber(number)).toThrow(InvalidInputError);
    }
  });

  it('rejects other shapes before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(track(fetcher, '30000000000A')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Sagawa Express widget reply', () => {
  it('reads the current state only, bound to the echoed waybill, with no history or times', () => {
    const result = normalizeCarrierResult(parseSagawaWidget(JSON.parse(DELIVERED), NUMBER));
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: '0051', last_status_text: '【配達完了】 お荷物のお届けが完了致しました。ご利用頂きありがとうございました。',
      last_update: null, expected_delivery: null, timezone: 'Asia/Tokyo', summary_only: true, events: [] });
    // provider_code is a declared result field, so normalization keeps it only as text.
    expect(() => normalizeCarrierResult({ ...result, provider_code: 51 })).toThrow(TypeError);
    expect(parseSagawaWidget(widget(info => { info.trackingNo = '3000-0000-0005'; }), NUMBER).status).toBe('delivered');
    for (const entry of statuses.entries) expect(sagawaState(entry.code)?.stage).toBe(entry.stage);
  });

  it('refuses a reply about another waybill or without a usable state', () => {
    for (const payload of [
      widget(info => { info.trackingNo = '300000000016'; }),
      widget(info => { delete info.trackingNo; }),
      widget(info => { info.trackingNo = 300000000005; }),
      widget(info => { info.state = 51; }),
      widget(info => { info.state = '51'; }),
      widget(info => { delete info.stateMassage; }),
      widget(info => { info.stateMassage = '  '; }),
      widget(info => { info.stateMassage = 'x'.repeat(1_001); }),
      { ...JSON.parse(DELIVERED), code: '201' },
      { code: '200', message: '' },
      [], null, 'ok',
    ]) expect(() => parseSagawaWidget(payload, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('answers the app by the state code alone, and leaves the unexplained codes unknown', () => {
    const answer = (providerCode: string | null, description: string) => statusMapAnswer({ carrier: 'sagawa', providerCode, description });
    for (const entry of statuses.entries) {
      expect(answer(entry.code, entry.wording)).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(answer(null, entry.wording)).toEqual({ kind: 'unknown' });
    }
    for (const code of ['0052', '0055', '0061']) expect(answer(code, '【お知らせ】 状態を確認中です。')).toEqual({ kind: 'unknown' });
    expect(statusMap.gaps).toEqual([]);
  });

  it('keeps an unmapped state as unknown, with no stage', () => {
    const result = parseSagawaWidget(widget(info => { info.state = '0052'; info.stateMassage = '【お知らせ】 状態を確認中です。'; }), NUMBER);
    expect(result).toMatchObject({ status: 'unknown', provider_code: '0052', last_status_text: '【お知らせ】 状態を確認中です。', summary_only: true });
    expect(result.current_stage).toBeUndefined();
  });

  it('keeps only the label of a state sentence that names a phone number', () => {
    const labelled = widget(info => { info.state = '0099'; info.stateMassage = '【お知らせ】 担当店 03-0000-0000 までご連絡ください。'; });
    expect(parseSagawaWidget(labelled, NUMBER).last_status_text).toBe('【お知らせ】');
    const bare = widget(info => { info.state = '0099'; info.stateMassage = '担当店（ＴＥＬ）までご連絡ください。'; });
    expect(parseSagawaWidget(bare, NUMBER).last_status_text).toBeNull();
  });

  it('projects no recipient, sender, address or staff data the reply might carry', () => {
    const result = parseSagawaWidget(widget(info => Object.assign(info, {
      receiverName: 'PRIVATE_SYNTHETIC_RECEIVER', senderName: 'PRIVATE_SYNTHETIC_SENDER', address: 'PRIVATE_SYNTHETIC_ADDRESS',
      driverName: 'PRIVATE_SYNTHETIC_DRIVER', driverTel: '090-0000-0000', latitude: 35.6, longitude: 139.7, signature: 'PRIVATE_SYNTHETIC',
    })), NUMBER);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SYNTHETIC|090-0000|35\.6|139\.7|updateFlg/);
  });

  it('reads only the no-data code as an unknown waybill', () => {
    expect(() => sagawaRejection(JSON.parse(NO_DATA))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => sagawaRejection(JSON.parse(REFUSED))).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = JSON.parse(NO_DATA) as { errors: unknown[] };
    mixed.errors.push(...(JSON.parse(REFUSED) as { errors: unknown[] }).errors);
    expect(() => sagawaRejection(mixed)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const payload of [{ code: '422', errors: [] }, { code: '422' }, { code: '422', errors: ['E015020'] },
      { ...JSON.parse(NO_DATA), code: '200' }, null]) {
      expect(() => sagawaRejection(payload)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Sagawa Express app request', () => {
  it('posts the waybill to the widget refresh with the app key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(track(fetcher, '3000-0000-0005')).resolves.toMatchObject({ status: 'delivered', summary_only: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SAGAWA_WIDGET_API);
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({ trackingNo: NUMBER, callType: '2' });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe(SAGAWA_APP_KEY);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe(DEFAULT_USER_AGENT);
  });

  it('names the host unless its User-Agent is a browser one, which the edge has refused', async () => {
    expect(sagawaUserAgent(undefined)).toBe(DEFAULT_USER_AGENT);
    expect(sagawaUserAgent('ExampleHost/2.1')).toBe('ExampleHost/2.1');
    expect(sagawaUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe(SAGAWA_APP_USER_AGENT);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await adapter(environment(fetcher, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).track({ number: NUMBER });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('user-agent')).toBe(SAGAWA_APP_USER_AGENT);
  });

  it('turns the no-data refusal into not-found and other refusals into inconclusive answers', async () => {
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(NO_DATA, 422)))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(REFUSED, 422)))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The no-data body under another status is not an answer about the waybill.
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(NO_DATA, 200)))).rejects.toMatchObject({ kind: 'schema' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(NO_DATA, 400)))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('reads an edge refusal, or an HTML page in place of an answer, as a challenge, never as not-found', async () => {
    for (const response of [html(403), html(200), html(422), json('', 401), json(NO_DATA, 403),
      new Response(NO_DATA, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })]) {
      await expect(track(vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toMatchObject({ kind: 'challenge' });
    }
  });

  it('keeps HTTP failures apart from answers', async () => {
    const cases: Array<[Response, Record<string, unknown>]> = [
      [json('{}', 429, { 'Retry-After': '120' }), { kind: 'rate_limited', retryAfterMs: 120_000 }],
      [json(NO_DATA, 429), { kind: 'rate_limited' }],
      [json(NO_DATA, 404), { kind: 'transport', status: 404 }],
      [json('', 410), { kind: 'transport', status: 410 }],
      [json('', 500), { kind: 'indeterminate' }],
      [json('', 503), { kind: 'maintenance' }],
      // An error or maintenance page from the edge or the origin is not a refusal.
      [html(503, { 'Retry-After': '600' }), { kind: 'maintenance', status: 503, retryAfterMs: 600_000 }],
      [html(500), { kind: 'indeterminate', status: 500 }],
      [html(502), { kind: 'indeterminate', status: 502 }],
      [html(504), { kind: 'indeterminate', status: 504 }],
      [html(400), { kind: 'transport', status: 400 }],
      [json('{}', 400), { kind: 'transport' }],
      [json('{"code":', 200), { kind: 'schema' }],
      [json('{"code":', 422), { kind: 'schema' }],
      [json(`{"code":"200","pad":"${'x'.repeat(70_000)}"}`), { kind: 'indeterminate' }],
    ];
    for (const [response, expected] of cases) {
      await expect(track(vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toMatchObject(expected);
    }
  });

  it('reports a network failure without the request, key or waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const error: unknown = await track(fetcher).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: 'transport', message: 'Sagawa Express app API request failed' });
    expect((error as Error).cause).toBeUndefined();
    const visible = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(visible).not.toContain(NUMBER);
    expect(visible).not.toMatch(/x-api-key|headers|https?:/i);
    expect(visible.includes(SAGAWA_APP_KEY)).toBe(false);
  });

  it('starts nothing after cancellation and stops the request when cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    const idle = vi.fn<typeof fetch>();
    await expect(adapter(environment(idle)).track({ number: NUMBER }, { signal: controller.signal })).rejects.toThrow();
    expect(idle).not.toHaveBeenCalled();

    const running = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal;
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), { once: true });
    });
    const result = adapter(environment(hanging)).track({ number: NUMBER }, { signal: running.signal, budgetMs: 1_000 });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    running.abort(new Error('Cancelled'));
    await expect(result).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('ends the request inside the caller budget', async () => {
    const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), { once: true });
    });
    await expect(new SagawaTracker({ fetcher: hanging }).fetch(NUMBER, { budgetMs: 15 })).rejects.toMatchObject({ kind: 'budget' });
    // The request's own deadline can fire a moment before the step's.
    const timeout = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(track(timeout)).rejects.toMatchObject({ kind: 'budget' });
  });
});
