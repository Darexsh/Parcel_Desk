import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPX_TW_API, spxTwQuery, SpxTwTracker } from './adapter.js';
import { normalizeSpxTwNumber, parseSpxTw } from './parser.js';
import { spxTwStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const READY = 'TW260000000001A';
const UNKNOWN = 'TW260000000003C';

type Row = Record<string, unknown>;
type Reply = Row & { data: Row & { tracking_list: Row[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (change: (rows: Row[], reply: Reply) => void) => {
  const reply = fixture('ready-for-pickup');
  change(reply.data.tracking_list, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null,
  userAgent: 'SyntheticHost/1.0' });

describe('SPX Express Taiwan HTTP adapter', () => {
  it('asks the legacy feed for the whole number with its checksum, as a browser, through the supplied transport', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-20T00:00:00Z'));
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('ready-for-pickup')));
      const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
      await expect(new SpxTwTracker({ fetcher, recorder }).fetch(' tw 2600-0000-0001 a ', { budgetMs: 1000.5 }))
        .resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0]!;
      const seconds = 1_779_235_200;
      const checksum = createHash('sha256').update(`${READY}${seconds}MGViZmZmZTYzZDJhNDgxY2Y1N2ZlN2Q1ZWJkYzlmZDY=`).digest('hex');
      expect(String(url)).toBe(`${SPX_TW_API}?sls_tracking_number=${READY}%7C${seconds}${checksum}`);
      expect(spxTwQuery(READY, seconds)).toBe(`${READY}|${seconds}${checksum}`);
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': expect.stringMatching(/^Mozilla\/5\.0 \(Macintosh;/) } });
      expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'spx-tw', step: 'direct', outcome: 'ok' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a browser’s User-Agent whatever the host’s, which the feed’s gateway refuses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('ready-for-pickup')));
    await carrier(fetcher).track({ number: READY });
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>)['User-Agent']).not.toBe('SyntheticHost/1.0');
  });

  it('keeps a parcel waiting at the buyer’s store once, as instants, with the store and without the buyer', () => {
    const result = parseSpxTw(fixture('ready-for-pickup'), READY);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: '包裹已配達買家取件門市 - [範例門市]', last_update: '2026-05-18T12:40:00Z', pickup_point: '範例門市' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-05-18T12:40:00Z', 'SP_Ready_Collection', 'ready_for_pickup', '範例門市'],
      // The repeated arrival is kept once.
      ['2026-05-18T02:40:00Z', 'SOC_Received', 'in_transit', null],
      ['2026-05-17T18:40:00Z', 'SP_LHTransporting', 'in_transit', null],
      ['2026-05-17T10:40:00Z', 'DOP_Received', 'accepted', null],
      ['2026-05-17T06:40:00Z', 'Created', 'registered', null],
    ]);
    expect(result.events!.every((event) => !('local_time' in event) && !('store' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/王小明|0900000000|COD|Order Created/);
  });

  it('reads a collected parcel as delivered without the name after it, and a name it does not know by its wording', () => {
    const collected = parseSpxTw(changed((rows) => {
      rows.unshift({ timestamp: 1_779_200_000, status: 'Delivered', message: '買家已取件 [王小明]' });
    }), READY);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '買家已取件',
      delivered_at: '2026-05-19T14:13:20Z', pickup_point: '範例門市' });
    const unknown = parseSpxTw(changed((rows) => {
      rows.unshift({ timestamp: 1_779_200_000, status: 'SP_Synthetic', message: '合成狀態' });
    }), READY);
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ last_status_text: '合成狀態', current_stage: 'ready_for_pickup' });
  });

  it('reads expired history as no history, and an unknown number, a failure and a rejected checksum as inconclusive', () => {
    expect(() => parseSpxTw(fixture('no-history'), READY)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // The feed answers an unknown number as a server error: it names no missing parcel.
    expect(() => parseSpxTw(fixture('unknown'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'IndeterminateError' }));
    expect(() => parseSpxTw({ retcode: 0, message: '', data: {} }, READY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpxTw(changed((rows) => { rows.length = 0; }), READY)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseSpxTw(fixture('ready-for-pickup'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SPX Express Taiwan answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], body: Reply) => { delete (body as Row).retcode; },
      (_rows: Row[], body: Reply) => { body.data = 'shipment' as never; },
      (_rows: Row[], body: Reply) => { delete (body.data as Row).sls_tracking_number; },
      (_rows: Row[], body: Reply) => { body.data.tracking_list = 'scans' as never; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 1000 }, () => rows[0]!)); },
      (rows: Row[]) => { rows[0] = 'scan' as never; },
      (rows: Row[]) => { rows[0]!.timestamp = '1779200000'; },
      (rows: Row[]) => { rows[0]!.timestamp = 1_779_200_000_000; },
      (rows: Row[]) => { rows[0]!.status = 'SP Ready'; },
      (rows: Row[]) => { rows[0]!.message = ''; },
      (rows: Row[]) => { rows[0]!.message = ['包裹']; },
    ]) {
      expect(() => parseSpxTw(changed(change), READY)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps the gateway’s refusal, a moved route and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: READY });
    // The gateway refuses with 403 and an action in place of the reply.
    await expect(lookup(fixture('refused'), { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('refused'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><title>Verify</title>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('ready-for-pickup'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://spx.tw/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('{"retcode":0,')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: READY })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers SPX Taiwan does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TW26000000001A', 'TW2600000000001AB', 'TW260000000001', 'SPXTW26000000001A', 'TH260000000001A']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: READY }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpxTwNumber('tw 2600 0000 0001 a')).toBe(READY);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('ends a hanging read inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: READY }, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under SPX Express Taiwan to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('ready-for-pickup')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: READY, carrier: 'spx-tw' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-tw', source: 'spx-tw', result: { current_stage: 'ready_for_pickup' } });
    expect(detectCarrierMatch(READY)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['spx-tw']) });
  });
});

describe('SPX Express Taiwan status vocabulary', () => {
  it('records every status name and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(spxTwStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'spx-tw', providerCode: 'SP_Ready_Collection', description: '包裹已配達買家取件門市' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'spx-tw', providerCode: 'SP_Synthetic', description: '合成狀態' })).toEqual({ kind: 'unknown' });
  });
});
