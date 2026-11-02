import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { failureKind } from '../../core/errors/hint.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, STO_SALT, STO_SOURCE, StoTracker } from './adapter.js';
import { normalizeStoNumber, parseSto } from './parser.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { statusMap, stoScan } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '777000000000001';
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const fixture = () => read('delivered');
const reply = (body: unknown = fixture()) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const instance = (fetcher: typeof fetch) =>
  adapter({ fetcher, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1.0' });
const PRIVATE = /1300000000|0571-|0510-|示例快递员|示例收件人|示例揽收员|示例操作员|示例驿站|示例路|取件码|000001001/;

describe('STO trace parser', () => {
  it('returns identity-bound scans on China time without courier, signer or station details', () => {
    const result = normalizeCarrierResult(parseSto(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', timezone: 'Asia/Shanghai',
      last_status_text: 'Delivered', last_update: '2026-01-03T18:00:00+08:00', delivered_at: '2026-01-03T18:00:00+08:00', weight_kg: 1.25 });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted']);
    expect(result.events?.map(event => event.provider_code)).toEqual(['客户签收', '驿站代收', '派件', '到件', '发件', '收件']);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', location: '示例目的公司, 浙江省示例市', stage_source: 'carrier_map' });
    expect(result.events?.[4]).toMatchObject({ description: 'Departed for 示例转运中心', location: '示例始发公司, 江苏省示例始发市', time: '2026-01-01T22:00:00+08:00' });
    expect(result.events?.every(event => event.provider_leg === undefined && event.time?.endsWith('+08:00'))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('accepts current and older waybill lengths and rejects other forms', () => {
    expect(normalizeStoNumber(' 777-000-000-000-001 ')).toBe(NUMBER);
    for (const number of ['000000000001', '0000000000001']) expect(normalizeStoNumber(number)).toBe(number);
    for (const number of ['77700000000001', '7770000000000011', 'STO000000000001', '123']) {
      expect(() => normalizeStoNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('asks recognition only about current waybills', () => {
    const asked = (number: string) => recognitionCandidates(number, { hint: 'sto' }).map(({ carrier }) => carrier);
    expect(detectCarrierMatch('000000000001').candidates).toContain('sto');
    expect(asked('000000000001')).not.toContain('sto');
    expect(asked(NUMBER)[0]).toBe('sto');
  });

  it('treats an empty trace as not found and a refused signature as a challenge', () => {
    expect(() => parseSto(read('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSto(read('verify-fail'), NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSto({ ...read('verify-fail'), errorCode: 'VERIFY_MISSING' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSto({ success: false, errorCode: 'SYSTEM_ERROR' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'STO returned the error SYSTEM_ERROR' }));
    expect(() => parseSto({ success: false, errorCode: '示例 13000000000' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'STO returned an inconclusive error' }));
  });

  it.each([null, [], {}, { success: 'true', data: [] }, { success: true }, { success: true, data: {} }])('rejects the malformed envelope %j', value => {
    expect(() => parseSto(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['wrong', 'missing', 'mixed', 'not-a-record', 'no-type'])('rejects %s scan evidence', mode => {
    const value = fixture();
    if (mode === 'wrong') for (const scan of value.data) scan.waybillNo = '777000000000002';
    if (mode === 'missing') delete value.data[0].waybillNo;
    if (mode === 'mixed') value.data[3].waybillNo = '777000000000002';
    if (mode === 'not-a-record') value.data.push(null);
    if (mode === 'no-type') value.data[2].scanType = '';
    expect(() => parseSto(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('places each scan by its facility, province and city', () => {
    const value = fixture();
    Object.assign(value.data[0], { opOrgProvinceName: '上海市', opOrgCityName: '上海市', opOrgName: '示例公司' });
    Object.assign(value.data[1], { opOrgProvinceName: '', opOrgCityName: '', opOrgName: '示例公司' });
    Object.assign(value.data[2], { opOrgProvinceName: '浙江省', opOrgCityName: '示例市', opOrgName: '' });
    delete value.data[3].opOrgProvinceName;
    delete value.data[3].opOrgName;
    expect(parseSto(value, NUMBER).events?.slice(0, 4).map(event => event.location))
      .toEqual(['示例公司, 上海市', '示例公司', '浙江省示例市', '示例市']);
  });

  it('keeps the newest weight a scan measured', () => {
    const value = fixture();
    value.data[0].weight = '0.0';
    value.data[2].weight = 'about 2';
    expect(parseSto(value, NUMBER).weight_kg).toBe(1.25);
    value.data[3].weight = 0;
    expect(parseSto(value, NUMBER).weight_kg).toBe(1.2);
    value.data[1].weight = 0.75;
    expect(parseSto(value, NUMBER).weight_kg).toBe(0.75);
    for (const scan of value.data) delete scan.weight;
    expect(parseSto(value, NUMBER)).not.toHaveProperty('weight_kg');
  });

  it('declares the stage the parser gives every scan, on the way out and back', () => {
    const value = fixture();
    const back = fixture();
    back.data.splice(3, 0, { ...back.data[3], scanType: '退回件', opTime: '2026-01-02 22:00:00' });
    for (const events of [parseSto(value, NUMBER).events!, parseSto(back, NUMBER).events!]) {
      for (const event of events) {
        expect(statusMap.stage(event.provider_code!, normalizeStatusWording(event.description!)), event.description).toBe(event.stage);
      }
    }
  });

  it('keeps an unknown scan type unmapped with its own label', () => {
    const value = fixture();
    value.data.unshift({ ...value.data[0], scanType: '问题件', opTime: '2026-01-04 10:00:00' });
    const result = parseSto(value, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '问题件', last_update: '2026-01-04T10:00:00+08:00' });
    expect(result.current_stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_code: '问题件', description: '问题件' });
    expect(result.events?.[0]!.stage).toBeUndefined();
  });

  it('puts delivery-side scans after a return scan on the way back to the sender', () => {
    const value = fixture();
    value.data.splice(3, 0, { ...value.data[3], scanType: '退回件', opTime: '2026-01-02 22:00:00' });
    const result = parseSto(value, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to the sender' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.slice(0, 4).map(event => [event.stage, event.description])).toEqual([
      ['returned', 'Returned to the sender'], ['ready_for_pickup', 'In a parcel locker or station on its way back'],
      ['out_for_delivery', 'Out for delivery back to the sender'], ['exception', 'Return to the sender started']]);
    expect(result.events?.[3]).toMatchObject({ provider_code: '退回件', stage_source: 'carrier_map' });
    expect(result.events?.slice(0, 4).every(event => event.provider_leg === 'return')).toBe(true);
    expect(result.events?.slice(4).every(event => event.provider_leg === undefined)).toBe(true);
  });

  it('reads a newest return scan as an exception', () => {
    const value = fixture();
    value.data.splice(0, 2, { ...value.data[2], scanType: '退回件', opTime: '2026-01-03 20:00:00' });
    const result = normalizeCarrierResult(parseSto(value, NUMBER));
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Return to the sender started', last_update: '2026-01-03T20:00:00+08:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_code: '退回件', stage: 'exception', stage_source: 'carrier_map', provider_leg: 'return' });
  });

  it.each(['2026-02-30 18:00:00', '2026-01-03', '2026-01-03 25:00:00', 'unknown', ''])('keeps the clock %s unresolved without borrowing an older scan instant', clock => {
    const value = fixture();
    value.data[0].opTime = clock;
    const result = parseSto(value, NUMBER);
    expect(result.last_update).toBeNull();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]!.time).toBeUndefined();
    expect(result.events?.[0]!.provider_time_text).toBe(clock || undefined);
    expect(result.events?.[1]!.time).toBe('2026-01-03T12:00:00+08:00');
  });

  it('drops exact repeats and bounds the history and the reply', () => {
    const value = fixture();
    value.data.push({ ...value.data[5] });
    expect(parseSto(value, NUMBER).events).toHaveLength(6);
    value.data = Array.from({ length: 120 }, (_, i) => ({ ...fixture().data[3], opOrgName: `示例中心${i}` }));
    const bounded = parseSto(value, NUMBER);
    expect(bounded.events).toHaveLength(100);
    expect(bounded.events?.[0]!.location).toBe('示例中心0, 浙江省示例市');
    value.data = Array.from({ length: 501 }, () => fixture().data[3]);
    expect(() => parseSto(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('classifies every recorded STO wording', () => {
    for (const entry of statuses.entries) expect(stoScan(entry.wording)?.stage, entry.wording).toBe(entry.stage);
  });

  it('backs the declared capabilities with synthetic history', () => {
    const capabilities = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')).capabilities as string[];
    const result = parseSto(fixture(), NUMBER);
    const supported: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some(event => event.location)),
      delivered_at: Boolean(result.delivered_at), provider_code: Boolean(result.events?.every(event => event.provider_code)),
      weight: Boolean(result.weight_kg) };
    for (const capability of capabilities) expect(supported[capability], capability).toBe(true);
  });
});

describe('STO signed retrieval', () => {
  it('signs each request with the source, a millisecond clock and the included salt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const adapterInstance = instance(fetcher);
    expect(adapterInstance).toMatchObject({ id: 'sto', steps: ['direct'], recordsSteps: true });
    const before = Date.now();
    await adapterInstance.track({ number: '777 0000 0000 0001' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://customerservice-onlinemessageapi.sto.cn/interactive/getExternalTrace/${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'error' });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    const timestamp = headers.get('timestamp')!;
    expect(timestamp).toMatch(/^\d{13}$/);
    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(headers.get('source')).toBe(STO_SOURCE);
    expect(headers.get('safeToken')).toBe(createHash('md5').update(STO_SOURCE + timestamp + STO_SALT).digest('hex'));
    expect(headers.get('User-Agent')).toBe('SyntheticHost/1.0');
    expect(headers.has('Cookie')).toBe(false);
  });

  it('recognizes a known waybill and a positively unknown one', async () => {
    const known = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    await expect(instance(known).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-03T10:00:00.000Z' });
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => reply(read('not-found')));
    await expect(instance(unknown).recognize!(NUMBER)).resolves.toMatchObject({ known: false });
    const unused = vi.fn<typeof fetch>();
    for (const number of ['ABC000000000001', '77700000000001', '123']) {
      await expect(instance(unused).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(unused).not.toHaveBeenCalled();
    // An older twelve-digit waybill is asked about like a current one.
    const older = vi.fn<typeof fetch>().mockImplementation(async () => reply(read('not-found')));
    await expect(instance(older).recognize!('000000000001')).resolves.toMatchObject({ known: false });
    expect(older).toHaveBeenCalledTimes(1);
    expect(older.mock.calls[0]![0]).toMatch(/\/000000000001$/);
    const refused = vi.fn<typeof fetch>().mockImplementation(async () => reply(read('verify-fail')));
    await expect(instance(refused).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each(['123', `${NUMBER},777000000000002`, `${NUMBER}/../x`])('rejects invalid input %s before I/O', async number => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new StoTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page and a broken body as a challenge and a schema failure', async () => {
    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response('\n<!DOCTYPE html><html><body>blocked</body></html>', { headers: { 'Content-Type': 'text/html' } }));
    await expect(new StoTracker({ fetcher: html }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const broken = vi.fn<typeof fetch>().mockResolvedValue(reply('{"success":true,'));
    const error: unknown = await new StoTracker({ fetcher: broken }).fetch(NUMBER).catch(caught => caught);
    expect(failureKind(error)).toBe('schema');
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']])('keeps endpoint HTTP %s separate from parcel absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new StoTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });

  it('keeps the wait a rate limit asks for', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(new StoTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation, fractional deadlines and streaming limits', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new StoTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return reply();
    });
    await expect(new StoTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new StoTracker({ fetcher: oversized }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
