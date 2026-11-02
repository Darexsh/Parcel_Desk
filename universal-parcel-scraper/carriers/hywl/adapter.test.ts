import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HYWL_API, HywlTracker } from './adapter.js';
import { hywlEnglishHalf, hywlPlace, hywlWording, normalizeHywlNumber, parseHywl } from './parser.js';
import { hywlStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'TRK00000000A1B2';
// The site's own example number.
const DELIVERED = 'TRKB879BE6E9D8E';
const UNKNOWN = 'TRK999999999999';
// Synthetic, in the layout of the other numbers its tracker answers.
const LETTERED = 'ABCD00D0000EFGH';
const LATER = Date.parse('2026-04-01T00:00:00Z');

type Row = Record<string, unknown>;
type Reply = Row & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Huiyi Logistics HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HywlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' trk0000-0000-a1b2 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    // The tracker matches the number case-sensitively, in capitals.
    expect(String(url)).toBe(`${HYWL_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hywl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the rows in China on Beijing’s clock, keeps the others’ wall clocks, newest first, and drops the office code', () => {
    const result = parseHywl(fixture('in-transit'), IN_TRANSIT, LATER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrival at Transit Hub [Sample Transit Hub]', last_update: null, last_update_local: '2026-03-11T08:21:00',
      expected_delivery: null, destination_country: 'ES' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-03-11T08:21:00', 'In Transit', 'in_transit', 'Sample Transit Hub'],
      ['2026-03-09T22:09:00', 'In Transit', 'in_transit', 'Example International Hub'],
      // Export clearance is done: the parcel carries on.
      ['2026-03-07T16:46:00+08:00', 'Customs', 'in_transit', 'Dongguan'],
      ['2026-03-06T13:14:00+08:00', 'In Transit', 'in_transit', 'Dongguan'],
      ['2026-03-05T18:27:00+08:00', 'In Transit', 'in_transit', 'Dongguan'],
      ['2026-03-04T11:58:00+08:00', 'In Transit', 'in_transit', 'Dongguan'],
      ['2026-03-02T20:33:00+08:00', 'In Transit', 'in_transit', 'Dongguan'],
      ['2026-02-28T09:05:00+08:00', 'In Transit', 'in_transit', 'Dongguan'],
      ['2026-02-26T15:40:00+08:00', 'In Transit', 'in_transit', 'Dongguan'],
      ['2026-02-24T10:12:00+08:00', 'Picked Up', 'accepted', 'Dongguan'],
    ]);
    expect(result.events!.at(-1)!.description).toBe('Shipment accepted [Dongguan], received by SZHYWL');
    expect(result.events!.every((event) => !(event.time && event.local_time))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/\d{4,}(?![-:T\d])|UTC|\+00:00/);
  });

  it('reads the bilingual rows in English without the destination’s postcode and drops a repeated row', () => {
    const result = parseHywl(fixture('delivered'), DELIVERED, LATER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered [Villefixe]', last_update_local: '2026-01-29T14:17:09', destination_country: 'FR' });
    expect(result.events).toHaveLength(14);
    expect(result.events!.map((event) => [event.stage, event.location])).toEqual([
      ['delivered', 'Villefixe'], ['out_for_delivery', 'Villefixe'], ['in_transit', 'Villefixe'], ['in_transit', 'Villefixe'],
      ['in_transit', 'FR'], ['in_transit', 'FR'], ['in_transit', '惠州'], ['in_transit', '惠州'], ['in_transit', '惠州'], ['in_transit', '惠州'],
      ['in_transit', '东莞'], ['in_transit', '东莞'], ['in_transit', '东莞'], ['accepted', '东莞市'],
    ]);
    expect(result.events!.at(-1)!.description).toBe('东莞市, SZHYWL已收取邮件');
    expect(result.events!.slice(3, 10).map((event) => event.description)).toEqual([
      'Arrival at Processing Center [Villefixe]', 'In Transit [FR]', 'Arrival at [FR]', 'Customs Clearance Completed [惠州]',
      'In Transit [惠州]', 'Departure from [惠州]', 'Received by Carrier [惠州]',
    ]);
    expect(result.events![10]!.description).toBe('东莞, 邮件离开处理中心【东莞】');
    expect(JSON.stringify(result)).not.toMatch(/00000|UTC/);
  });

  it('takes a place apart from its postcode and keeps wording without one', () => {
    expect(['Villefixe, 00000', '00000 Villefixe', 'Sampletown 00000017', '样本市00000011', 'Exampleton, AB1 2CD', 'Sample Hub', 'FR', '']
      .map(hywlPlace)).toEqual(['Villefixe', '', 'Sampletown', '样本市', 'Exampleton', 'Sample Hub', 'FR', '']);
    expect(hywlWording('Arrival【00000 Villefixe】, 抵达【00000 Villefixe】', '00000 Villefixe', '')).toBe('Arrival, 抵达');
    expect(hywlWording('Delivered [Villefixe], signed by Sample Person', 'Villefixe', 'Villefixe')).toBe('Delivered [Villefixe]');
    expect(hywlWording('已妥投【样本市】，签收人：样本', '样本市', '样本市')).toBe('已妥投【样本市】');
    expect(hywlWording('Arrived at the hub serving 00000', '', '')).toBe('Arrived at the hub serving');
  });

  it('keeps the English half of a bilingual row only when the Chinese half adds no place or Latin text', () => {
    expect(hywlEnglishHalf('Delivered【Sampletown, NC】, 已妥投【Sampletown, NC】')).toBe('Delivered [Sampletown, NC]');
    expect(hywlEnglishHalf('In Transit【样本市】, 快件在该国内转运中, 干线中转')).toBe('In Transit [样本市]');
    expect(hywlEnglishHalf('Arrival, 抵达')).toBe('Arrival');
    for (const wording of ['Delivered【Sampletown】, 已妥投【Exampleton】', 'Delivered【Sampletown】, SZHYWL已妥投【Sampletown】',
      'Delivered【Sampletown】, Delivered【Sampletown】', '样本市, 邮件到达处理中心【样本市】', 'Shipment accepted [Sampletown], received by SZHYWL',
      'Delivered [Sampletown]']) {
      expect(hywlEnglishHalf(wording)).toBe(wording);
    }
  });

  it('holds back rows dated after the read and does not take the summary status', () => {
    const result = parseHywl(fixture('delivered'), DELIVERED, Date.parse('2026-01-27T00:00:00Z'));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-01-26T21:17:09' });
    expect(result.events!.map((event) => event.stage)).not.toContain('delivered');
    // A row in China is ahead of the read by its Beijing instant, not by its label.
    const china = parseHywl(fixture('delivered'), DELIVERED, Date.parse('2026-01-14T12:00:00Z'));
    expect(china).toMatchObject({ last_update: '2026-01-14T17:17:09+08:00', events: expect.any(Array) });
    expect(china.last_update_local).toBeUndefined();
    // Every row ahead of the read: found, without scans yet.
    expect(() => parseHywl(fixture('delivered'), DELIVERED, Date.parse('2026-01-01T00:00:00Z'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when its own number and Huiyi Logistics’ label are in the reply', () => {
    expect(() => parseHywl(fixture('in-transit'), DELIVERED, LATER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHywl(changed('in-transit', (body) => { body.tracking_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT, LATER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHywl(changed('in-transit', (body) => { body.carrier = 'SAMPLE'; }), IN_TRANSIT, LATER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHywl(changed('in-transit', (body) => { body.success = false; }), IN_TRANSIT, LATER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHywl(changed('in-transit', (body) => { body.events = []; }), IN_TRANSIT, LATER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.success; },
      (body: Reply) => { delete body.tracking_number; },
      (body: Reply) => { body.tracking_number = { number: IN_TRANSIT }; },
      (body: Reply) => { delete (body as Row).events; },
      (body: Reply) => { body.events = Array.from({ length: 501 }, () => body.events[0]!); },
      (body: Reply) => { body.events[0] = 'row' as never; },
      (body: Reply) => { body.events[0]!.time = '2026-02-24 10:12'; },
      (body: Reply) => { body.events[0]!.time = '2026-02-24T24:00:00+00:00'; },
      (body: Reply) => { delete body.events[0]!.time; },
      (body: Reply) => { body.events[0]!.description = ['Shipment accepted']; },
      (body: Reply) => { body.events[0]!.status_code = 1; },
    ]) {
      expect(() => parseHywl(changed('in-transit', change), IN_TRANSIT, LATER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a missing route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // The web server's own 404 page, or another answer of the service, is not the unknown-number answer.
    await expect(lookup('<html><head><title>404 Not Found</title></head></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ detail: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(fixture('not-found'), { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.szhywl.it.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>汇一物流</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Huiyi Logistics does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('TRK00000000A1B')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Huiyi Logistics does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TRK00000000A1B', 'TRK00000000A1B23', 'TRK00000000A1G2', 'TRX00000000A1B2', '00000000A1B2', 'RR000000005CN']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHywlNumber('trkb879-be6e.9d8e')).toBe(DELIVERED);
  });

  it('looks up its lettered numbers, and no near miss of their layout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(changed('in-transit', (body) => { body.tracking_number = LETTERED; })));
    await expect(carrier(fetcher).track({ number: LETTERED.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${HYWL_API}${LETTERED}`);
    for (const number of ['ABCD00E0000EFGH', 'ABCD00D0000EFG', 'ABC00D0000EFGH', 'ABCD000D0000EFGH', 'ABCD00D00000EFGH']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends a read that failed to reach the site once more', async () => {
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

  it('routes a number filed under Huiyi Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'hywl' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'hywl', source: 'hywl', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${HYWL_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Huiyi Logistics status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(hywlStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'hywl', providerCode: 'Customs', description: 'Customs inspection [Sampletown]' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'hywl', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(hywlStage('SYNTHETIC', 'Delivered [Sampletown]')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(hywlStage('SYNTHETIC', 'Synthetic note')).toBeNull();
  });
});
