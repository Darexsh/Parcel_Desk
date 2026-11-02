import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NOVA_GLOBAL_API, NovaGlobalTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeNovaGlobalNumber, parseNovaGlobal } from './parser.js';
import { novaGlobalStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'NP00000000000012NPG';
const IN_TRANSIT = 'WB0000000000000034NPG';
const UNKNOWN = 'NP00000000000000NPG';

type Row = Record<string, unknown>;
type Reply = Row & { historyStatus: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// The tracker labels its JSON as HTML.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Nova Global HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NovaGlobalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' wb 0000000000000034 npg ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(NOVA_GLOBAL_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ num: IN_TRANSIT, lang: 'en' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'nova-global', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the Ukrainian scans, keeps the other clocks local and hands the parcel to Nova Poshta', () => {
    const result = parseNovaGlobal(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-04-16T18:12:40+03:00', expected_delivery: null,
      delivered_at: '2026-04-16T18:12:40+03:00', destination_country: 'UA',
      delivery_carrier: 'nova-poshta', delivery_tracking_number: '20700000000001' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null, event.provider_code, event.stage ?? null]))
      .toEqual([
        ['2026-04-16T18:12:40+03:00', 'Ukraine', '3-1', 'delivered'],
        ['2026-04-16T09:31:05+03:00', 'Ukraine', '303', 'ready_for_pickup'],
        ['2026-04-16T05:02:51+03:00', 'Ukraine', '301', 'in_transit'],
        ['2026-04-15T21:44:10+03:00', 'Ukraine', '30', 'in_transit'],
        ['2026-04-15T16:20:33+03:00', 'Ukraine', '23', 'in_transit'],
        ['2026-04-15T16:20:13+03:00', 'Ukraine', '22', 'in_transit'],
        ['2026-04-15T14:05:47+03:00', 'Ukraine', '401', 'in_transit'],
        ['2026-04-15T10:12:09+03:00', 'Ukraine', '400', 'customs'],
        ['2026-04-15T10:11:59+03:00', 'Ukraine', '20', 'customs'],
        ['2026-04-14T03:00:00+03:00', 'Ukraine', '55', 'in_transit'],
        // The tracker reads these on Kyiv time too; the sites abroad keep their own clocks.
        ['2026-04-10T22:15:31', 'Poland', '54', 'in_transit'],
        ['2026-04-10T11:40:02', 'Poland', '76', 'in_transit'],
        ['2026-04-09T03:10:44', 'United States of America', '25', 'in_transit'],
        ['2026-04-08T01:25:18', 'United States of America', '247', 'in_transit'],
        ['2026-04-06T22:05:37', 'United States of America', '23', 'in_transit'],
        ['2026-04-06T22:00:12', null, '1-0', 'registered'],
        ['2026-04-03T19:48:26', 'United States of America', '14', 'accepted'],
      ]);
    expect(result.events!.filter((event) => event.time).every((event) => event.local_time === undefined)).toBe(true);
    expect(result.events!.at(-2)).toMatchObject({ description: 'Order is processed for delivery to the country of destination' });
    expect(result.events![12]).toMatchObject({ description: 'Shipment left the transit country under customs control' });
  });

  it('reads winter scans at Kyiv’s winter offset, keeps a repeated scan once and hands an export to UPS', () => {
    const result = parseNovaGlobal(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment left the transit sorting center', last_update: null, last_update_local: '2026-02-12T06:41:00',
      destination_country: 'CA', delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10000000006' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(16);
    expect(result.events!.filter((event) => event.time).map((event) => event.time)).toEqual([
      '2026-02-08T14:30:08+02:00', '2026-02-08T14:12:55+02:00', '2026-02-08T10:41:30+02:00', '2026-02-08T10:40:30+02:00',
      '2026-02-08T10:21:16+02:00', '2026-02-07T17:05:00+02:00', '2026-02-07T13:16:42+02:00',
    ]);
    expect(result.events!.slice(0, 4).map((event) => [event.local_time, event.location])).toEqual([
      ['2026-02-12T06:41:00', 'United States of America'],
      ['2026-02-11T21:18:00', 'United States of America'],
      ['2026-02-11T13:02:27', 'United States of America'],
      ['2026-02-10T07:00:00', 'Germany'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-02-06T20:58:03', provider_code: '1-0', stage: 'registered' });
  });

  it('keeps a wall clock whose instant does not read back to it in Ukraine', () => {
    const result = parseNovaGlobal(changed('delivered', (body) => {
      body.historyStatus[0]!.timestamp = (body.historyStatus[0]!.timestamp as number) + 3600;
      delete body.historyStatus[1]!.timestamp;
      body.historyStatus[2]!.timestamp = '1776304971';
    }), DELIVERED);
    expect(result.events!.slice(0, 4).map((event) => [event.time ?? null, event.local_time ?? null])).toEqual([
      [null, '2026-04-16T18:12:40'],
      [null, '2026-04-16T09:31:05'],
      [null, '2026-04-16T05:02:51'],
      ['2026-04-15T21:44:10+03:00', null],
    ]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-04-16T18:12:40', current_stage: 'delivered' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps a line whose prefix is not the scan’s country whole', () => {
    const result = parseNovaGlobal(changed('delivered', (body) => {
      body.historyStatus[0]!.status = 'Poland.Delivered';
      body.historyStatus[1]!.location = null;
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ description: 'Poland.Delivered', location: 'UA', stage: 'delivered' });
    expect(result.events![1]).toMatchObject({ description: 'Ukraine.Delivered to the locker', local_time: '2026-04-16T09:31:05' });
    expect(result.events![1]).not.toHaveProperty('location');
  });

  it('names a delivery partner only with the one number of its own shape', () => {
    const handoff = (change: (body: Reply) => void) => {
      const result = parseNovaGlobal(changed('delivered', change), DELIVERED);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    // Nova Poshta's waybill beside UPS's own number: the partner decides.
    expect(handoff((body) => { body.partner = 'UPS'; body.bills = '20700000000001, 1Z999AA10000000006, '; }))
      .toEqual(['ups', '1Z999AA10000000006']);
    expect(handoff((body) => { body.bills = '9400100000000000000001, '; })).toEqual([null, null]);
    expect(handoff((body) => { body.bills = '20700000000001, 20800000000003, '; })).toEqual([null, null]);
    expect(handoff((body) => { body.bills = `${DELIVERED}, ${DELIVERED}, 20700000000001, `; })).toEqual(['nova-poshta', '20700000000001']);
    expect(handoff((body) => { body.partner = 'Synthetic Courier'; })).toEqual([null, null]);
    expect(handoff((body) => { body.partner = ''; })).toEqual([null, null]);
    expect(handoff((body) => { delete body.bills; })).toEqual([null, null]);
    expect(handoff((body) => { body.bills = ['20700000000001']; })).toEqual([null, null]);
  });

  it('reads the tracker’s not-found reply as not found and a waybill without scans as no history', () => {
    expect(() => parseNovaGlobal(203, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNovaGlobal(changed('delivered', (body) => { body.historyStatus = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseNovaGlobal(changed('delivered', (body) => { delete (body as Row).historyStatus; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a waybill only when it names the number asked', () => {
    expect(() => parseNovaGlobal(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Nova Global answered for another waybill' }));
    expect(parseNovaGlobal(changed('delivered', (body) => { body.billNumber = DELIVERED.toLowerCase(); }), DELIVERED).events).toHaveLength(17);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.billNumber; },
      (body: Reply) => { body.billNumber = 12; },
      (body: Reply) => { body.historyStatus = 'scans' as never; },
      (body: Reply) => { body.historyStatus = Array.from({ length: 501 }, () => body.historyStatus[0]!); },
      (body: Reply) => { body.historyStatus[0] = 'scan' as never; },
      (body: Reply) => { body.historyStatus[0]!.status = ''; },
      (body: Reply) => { body.historyStatus[0]!.status = { en: 'Delivered' }; },
      (body: Reply) => { body.historyStatus[0]!.date = '16.04.2026 18:12'; },
      (body: Reply) => { body.historyStatus[0]!.date = '2026/04/16 24:00:00'; },
      (body: Reply) => { body.historyStatus[0]!.date = '2026/02/30 10:00:00'; },
      (body: Reply) => { delete body.historyStatus[0]!.date; },
      (body: Reply) => { body.historyStatus[0]!.code = ['3-1']; },
      (body: Reply) => { body.to = { code: 'UA' }; },
    ]) {
      expect(() => parseNovaGlobal(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], 'Nova Global', 200]) {
      expect(() => parseNovaGlobal(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The tracker answers a number it does not know with an empty body.
    await expect(lookup('\r\n')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('203')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://nova.global/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Nova Global</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"status":')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Nova Global does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply('\r\n'));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-16T15:12:40.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('20700000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Nova Global does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['NP00000001NPG', 'NP00000000000000001NPG', 'NP00000000000012NPI', '0000000000000012NPG', '20700000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeNovaGlobalNumber('np 0000-0000-0000-12 npg')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Nova Global, or detected as one of its waybills, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === NOVA_GLOBAL_API
      ? reply(fixture('delivered')) : new Response('', { status: 503 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'nova-global' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'nova-global', source: 'nova-global', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'nova-global', source: 'nova-global' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === NOVA_GLOBAL_API)).toBe(true);
  });
});

describe('Nova Global numbers', () => {
  it('accepts every public sample that rule nova-global-1 claims', () => {
    for (const { number } of numbers.records) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'nova-global', confidence: 'high' });
      expect(normalizeNovaGlobalNumber(number)).toBe(number);
    }
  });
});

describe('Nova Global status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    const coded = (statuses.entries as { code?: string; wording: string; stage: string }[]).filter((entry) => entry.code);
    expect(coded.length).toBeGreaterThan(20);
    for (const entry of coded) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(novaGlobalStage(entry.code!, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'nova-global', providerCode: '303', description: 'Delivered to the locker' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'nova-global', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(novaGlobalStage('999', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(novaGlobalStage('999', 'Synthetic note')).toBeNull();
  });
});
