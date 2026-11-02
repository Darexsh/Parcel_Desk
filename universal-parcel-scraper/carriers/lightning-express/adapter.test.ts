import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LIGHTNING_EXPRESS_API, LightningExpressTracker, lightningExpressUrl } from './adapter.js';
import { lightningExpressWaybill, normalizeLightningExpressNumber, parseLightningExpress } from './parser.js';
import { lightningExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'YYZ00000000000001';
const MOVING = 'YYZ123000000001234';
const UNKNOWN = 'ZZZ00000000000000';

type Row = Record<string, unknown>;
type Reply = Row & { data: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Row, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED) => carrier(fetcher).track({ number });
const answering = (body: unknown, init?: ResponseInit) => vi.fn<typeof fetch>().mockResolvedValue(reply(body, init));
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Lightning Express HTTP adapter', () => {
  it('asks the tracking page’s service once for the whole number, spaced as the page sends it, through the supplied transport', async () => {
    const fetcher = answering(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LightningExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' yyz123-0000 0000 1234 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LIGHTNING_EXPRESS_API}?waybill_sn=YYZ123%2000000000%201234`);
    expect(String(url)).toBe(lightningExpressUrl(MOVING));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lightning-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('spaces a number before its last twelve and its last four characters, as the page’s script does', () => {
    expect(lightningExpressWaybill(DELIVERED)).toBe('YYZ00 00000000 0001');
    expect(lightningExpressWaybill('yyz123 0000 0000 1234')).toBe('YYZ123 00000000 1234');
    expect(normalizeLightningExpressNumber('YYZ00 00000000 0001')).toBe(DELIVERED);
  });

  it('turns each stamped milestone into a wall-clock scan, newest first, and keeps no client, note or photo', () => {
    const result = parseLightningExpress(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      provider_code: '2', last_update: null, last_update_local: '2026-03-05T11:47:30',
      events: [
        { local_time: '2026-03-05T11:47:30', description: 'Delivered', provider_code: '2', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T10:02:11', description: 'Out for delivery', provider_code: '4', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        // Back at the warehouse after a first run; the reply keeps only the second run's departure.
        { local_time: '2026-03-03T19:40:05', description: 'Returned to warehouse', provider_code: '3', stage: 'failed_attempt', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T09:15:20', description: 'Label created', provider_code: '0', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Sample|SAMPLEORDER|sample-bucket|已完成/);
  });

  it('reads a parcel out for delivery after its collection', () => {
    const result = parseLightningExpress(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery',
      provider_code: '4', last_update_local: '2026-04-11T08:05:00' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code])).toEqual([
      ['2026-04-11T08:05:00', '4'], ['2026-04-10T16:30:00', '5'], ['2026-04-10T14:00:00', '0'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('lets the status code settle the current stage, whatever older milestones the reply still stamps', () => {
    // Back at the warehouse after an earlier delivery stamp, which the page hides.
    const back = parseLightningExpress(changed('delivered', (data) => {
      Object.assign(data, { status: '3', status_name: '已返仓', return_time: '2026-03-06 18:00:00' });
    }), DELIVERED);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Returned to warehouse', provider_code: '3' });
    expect(back.events!.map((event) => event.provider_code)).toEqual(['3', '2', '4', '0']);
    const cancelled = parseLightningExpress(changed('in-transit', (data) => { data.status = -1; }), MOVING);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'This order has been cancelled', provider_code: '-1' });
    // The page's script ignores status 1, and so does the map: the newest milestone decides.
    const ignored = parseLightningExpress(changed('in-transit', (data) => { Object.assign(data, { status: '1', status_name: '待配送' }); }), MOVING);
    expect(ignored).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: '待配送', provider_code: '1' });
    // A code nothing knows keeps the reply's own name for it.
    const unknown = parseLightningExpress(changed('in-transit', (data) => { Object.assign(data, { status: '9', status_name: '合成状态' }); }), MOVING);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: '合成状态', provider_code: '9' });
    // A status without a stamped milestone is a summary.
    const bare = parseLightningExpress(changed('in-transit', (data) => {
      Object.assign(data, { create_time: '', collect_time: null, receiving_time: '' });
    }), MOVING);
    expect(bare).toEqual({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out for delivery', provider_code: '4', last_update: null, summary_only: true, events: [] });
  });

  it('reads the service’s empty answer as not found and binds an order to the whole number asked', async () => {
    expect(() => parseLightningExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(answering(fixture('not-found')), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseLightningExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Lightning Express answered for another order' }));
    // A number that only starts like the one asked is another order.
    expect(() => parseLightningExpress(changed('delivered', (data) => { data.waybill_sn = 'YYZ00 00000000 00011'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The spacing and case of the echoed number do not matter.
    expect(parseLightningExpress(changed('delivered', (data) => { data.waybill_sn = 'yyz0000000000000 1'; }), DELIVERED).events).toHaveLength(4);
    // The page shows the message of any other code; none has been seen, so it proves nothing.
    expect(() => parseLightningExpress({ code: '0', msg: '合成错误', data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLightningExpress({ code: 0, msg: '', data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Row, body: Reply) => { delete (body as Row).code; },
      (_data: Row, body: Reply) => { body.code = null; },
      (_data: Row, body: Reply) => { body.data = 'order' as never; },
      (_data: Row, body: Reply) => { body.data = [] as never; },
      (data: Row) => { delete data.waybill_sn; },
      (data: Row) => { data.waybill_sn = 0; },
      (data: Row) => { delete data.status; },
      (data: Row) => { data.status = 'done'; },
      (data: Row) => { data.status = ['2']; },
      (data: Row) => { data.status_name = 2; },
      (data: Row) => { data.complete_time = '05/03/2026 11:47'; },
      (data: Row) => { data.complete_time = '2026-03-05T11:47:30'; },
      (data: Row) => { data.complete_time = '2026-02-30 11:47:30'; },
      (data: Row) => { data.complete_time = '2026-03-05 24:00:00'; },
      (data: Row) => { data.complete_time = 1772711250; },
    ]) {
      expect(() => parseLightningExpress(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a browser check, a refusal, a moved route and a broken reply apart from a missing order', async () => {
    await expect(lookup(answering(CHECK, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(answering(CHECK, { status: 403, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(answering('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(answering('', { status: 302, headers: { Location: 'https://www.lightningexpressca.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(answering('<html><title>Lightning Express</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(answering(`\uFEFF${JSON.stringify(fixture('not-found'))}`))).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('takes three letters and fourteen or fifteen digits, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YYZ0000000000000', 'YYZ0000000000000000', 'YY000000000000000', 'YYZ0A000000000000', '00000000000000000', 'SAMPLETRACKING']) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await expect(lookup(vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(100_000))))).rejects.toThrow('unexpectedly large');
  });

  it('routes a number the caller names Lightning Express’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: 'YYZ00 00000000 0001', carrier: 'lightning-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'lightning-express', source: 'lightning-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === lightningExpressUrl(DELIVERED))).toBe(true);
  });
});

describe('Lightning Express numbers', () => {
  it('claims no number layout, and reads the number from the tracking page’s link', () => {
    for (const number of [DELIVERED, MOVING]) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('lightning-express');
      expect(recognitionAskedCarriers(number)).not.toContain('lightning-express');
    }
    const link = 'https://www.lightningexpressca.com/track.html?id=YYZ00%2000000000%200001';
    // The link keeps the number as the page spaced it; a lookup normalizes it.
    expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: 'YYZ00 00000000 0001', carrier: 'lightning-express', source: 'link' });
  });
});

type Entry = { code: string; wording: string; stage: string };

describe('Lightning Express status vocabulary', () => {
  it('maps every code recorded to its stage, and every label the adapter writes is recorded', () => {
    for (const entry of statuses.entries as Entry[]) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'lightning-express', providerCode: entry.code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => `${entry.code} ${entry.wording}`));
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', MOVING]] as const) {
      for (const event of parseLightningExpress(fixture(name), number).events!) {
        expect(recorded.has(`${event.provider_code} ${event.description}`), event.description).toBe(true);
      }
    }
    expect(lightningExpressStage('1')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'lightning-express', providerCode: '1', description: '待配送' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'lightning-express', providerCode: '9', description: '合成状态' })).toEqual({ kind: 'unknown' });
  });
});
