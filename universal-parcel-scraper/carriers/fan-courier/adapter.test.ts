import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FanCourierTracker } from './adapter.js';
import { parseFanCourier } from './parser.js';
import { fanCourierStage, statusMap } from './status.js';

const NUMBER = '4000000000010';
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('FAN Courier events', () => {
  it('reads coded events newest first on local clocks, up to the delivery, without private detail', () => {
    const result = normalizeCarrierResult(parseFanCourier(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-01-07T14:05:51' });
    // The tracker hides the warehouse scan after the delivery.
    expect(result.events).toHaveLength(10);
    expect(result.events?.[0]).toEqual({ description: 'Delivered', provider_code: 'S2', local_time: '2026-01-07T14:05:51',
      location: 'Sample Town', stage: 'delivered' });
    expect(result.events?.[3]).toMatchObject({ provider_code: 'S3', stage: 'failed_attempt' });
    expect(result.events?.[4]).toMatchObject({ provider_code: 'S1', stage: 'out_for_delivery' });
    expect(result.events?.[5]).toMatchObject({ provider_code: 'C1', stage: 'out_for_delivery' });
    expect(result.events?.at(-1)).toMatchObject({ provider_code: 'C0', stage: 'accepted', location: 'Exampleville' });
    expect(result.events?.every(event => !('time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|P\*{4}E|4000000000099|weight|dimensions|confirmation|payment/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.capabilities).toEqual(['history', 'location', 'provider_code']);
    expect(metadata.tracking).toMatchObject({ adapter: 'fan-courier', steps: ['direct'], localClocks: true });
  });

  it('reads a refusal and a return as an exception, and keeps the return AWB out', () => {
    const result = parseFanCourier(fixture('returned'), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Return' });
    expect(result.events).toHaveLength(8);
    expect(result.events?.[1]).toMatchObject({ provider_code: 'H17', stage: 'in_transit' });
    expect(result.events?.[2]).toMatchObject({ provider_code: 'S6', stage: 'exception' });
    expect(JSON.stringify(result)).not.toContain('4000000000058');
  });

  it('leaves a code the map does not know without a stage', () => {
    const value = fixture();
    value.events.splice(9, 0, { id: 'S49', name: 'Activity suspended', location: 'Sample Town', date: '2026-01-07 10:00:00' });
    value.events.splice(10);
    const result = parseFanCourier(value, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Activity suspended' });
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });

  it('keeps an unreadable clock as text and drops repeated rows', () => {
    const value = fixture();
    value.events.splice(1, 0, value.events[0]);
    const delivery = value.events.find((row: { id: string }) => row.id === 'S2');
    delivery.date = '2026-02-30 14:05:51';
    const result = parseFanCourier(value, NUMBER);
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-02-30 14:05:51' });
    expect(result.events?.[0]).not.toHaveProperty('local_time');
    expect(result.last_update_local).toBeNull();
    expect(result.events).toHaveLength(10);
    delete delivery.date;
    expect(parseFanCourier(value, NUMBER).events?.[0]).not.toHaveProperty('provider_time_text');
    delivery.date = 1767794751;
    expect(() => parseFanCourier(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('knows an unknown AWB only from the page message naming the requested number', () => {
    expect(() => parseFanCourier(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const romanian = { ...fixture('not-found'), message: 'AWB-ul nu a fost gasit.' };
    expect(() => parseFanCourier(romanian, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = { ...fixture('not-found'), content: '4000000000027' };
    expect(() => parseFanCourier(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const message of ['An error occurred', undefined]) {
      expect(() => parseFanCourier({ ...fixture('not-found'), message }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('binds the reply to the whole AWB and validates its events', () => {
    for (const awbNumber of ['4000000000027', '400000000001', { value: NUMBER }]) {
      expect(() => parseFanCourier({ ...fixture(), awbNumber }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseFanCourier({ ...fixture(), awbNumber: Number(NUMBER) }, NUMBER).status).toBe('delivered');
    expect(() => parseFanCourier({ ...fixture(), events: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const row = fixture().events[0];
    for (const events of [null, {}, Array(501).fill(row), [null], [{ ...row, id: '' }], [{ ...row, id: 'Delivered' }],
      [{ ...row, id: ['S2'] }], [{ ...row, name: '' }]]) {
      expect(() => parseFanCourier({ ...fixture(), events }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const value of [null, [], 'AWB']) {
      expect(() => parseFanCourier(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('maps codes, not wording', () => {
    expect(fanCourierStage('toString')).toBeUndefined();
    expect(fanCourierStage('S56')).toBe('accepted');
    expect(fanCourierStage('S65')).toBe('in_transit');
    expect(fanCourierStage('S9')).toBe('in_transit');
    expect(statusMap.stage('C1', 'shipment taken over for delivery')).toBe('out_for_delivery');
    expect(statusMap.stage('S43', 'retur')).toBe('exception');
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    for (const code of ['S8', 'S38', 'S49']) expect(statusMap.stage(code, 'any wording')).toBeUndefined();
    expect(statusMap.stage('S46', 'shed delivery point')).toBe('ready_for_pickup');
    const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')).entries as { code: string; stage?: string }[];
    for (const entry of statuses) expect(fanCourierStage(entry.code), entry.code).toBe(entry.stage);
  });
});

describe('FAN Courier retrieval', () => {
  it("posts the page's anonymous form once and recognizes known and unknown AWBs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture()));
    const instance = adapter({ ...environment(fetcher), userAgent: 'ExampleHost/1.0' });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-07T14:05:51' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.fancourier.ro/limit-tracking.php');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({ action: 'get_awb', awb: NUMBER, lang: 'en-US' });
    const headers = new Headers(init?.headers);
    expect(headers.get('User-Agent')).toBe('ExampleHost/1.0');
    expect(headers.has('Cookie')).toBe(false);
    fetcher.mockResolvedValueOnce(Response.json(fixture('not-found')));
    await expect(instance.recognize!('4000 0000 0001 0')).resolves.toEqual({ known: false });
    expect(Object.fromEntries(fetcher.mock.calls[1]![1]?.body as URLSearchParams)).toMatchObject({ awb: NUMBER });
    fetcher.mockResolvedValueOnce(Response.json({ ...fixture(), events: [] }));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(instance.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
  });

  it.each([[404, 'indeterminate'], [422, 'indeterminate'], [401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'],
    [503, 'maintenance'], [500, 'indeterminate']])('keeps HTTP %s distinct from absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: 'The AWB was not found' }, { status }));
    await expect(new FanCourierTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('tells a challenge page, an empty reply and other HTML apart', async () => {
    for (const [body, kind] of [
      ['<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', 'challenge'],
      ['<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></html>', 'challenge'],
      ['', 'indeterminate'],
      ['<html><body>Maintenance</body></html>', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      await expect(new FanCourierTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['123', '40000000000101', '400000000001A', `${NUMBER}&awb=4000000000027`]) {
      await expect(new FanCourierTracker({ fetcher: unused }).fetch(number)).rejects.toThrow(InvalidInputError);
    }
    await expect(new FanCourierTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return new Response('{}');
    });
    await expect(new FanCourierTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new FanCourierTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
