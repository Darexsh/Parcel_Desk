import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPX_TH_API } from './adapter.js';
import { normalizeSpxThNumber, parseSpxTh } from './parser.js';
import { spxThStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// A standalone order: its reply names its SPX number and its Shopee number.
const DELIVERED = 'SPXTH26000000002C';
const DELIVERED_SLS = 'TH260000000002B';
// A parcel from abroad, which Thailand's lookup finds only by its SPX number.
const IN_TRANSIT = 'SPXTH26000000001A';
const IN_TRANSIT_SLS = 'TH260000000001A';
const UNKNOWN = 'SPXTH26000000003D';

type Row = Record<string, unknown>;
type Tracking = Row & { records: Row[] };
type Reply = Row & { data: Row & { sls_tracking_info: Tracking } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Thailand HTTP adapter', () => {
  it('asks the Thai tracker’s lookup for the whole number in Thai', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: 'spxth 2600-0000-001a' })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://spx.co.th/shipment/order/open/order/get_order_info?spx_tn=${IN_TRANSIT}&language_code=th`);
    expect(String(url).startsWith(SPX_TH_API)).toBe(true);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });

  it('files a parcel at Thai customs under customs, and keeps the places of SPX’s facilities abroad', () => {
    const result = parseSpxTh(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'พัสดุถึงที่ทำการศุลกากร ประเทศไทยแล้ว อยู่ระหว่างการตรวจสอบของหน่วยงาน', last_update: '2026-05-19T18:40:00Z' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['F360', 'customs', 'SAMPLE BORDER'],
      ['F341', 'in_transit', 'SampleCity'],
      ['F339', 'in_transit', 'SampleCity'],
      ['F300', 'in_transit', 'SampleCity'],
      ['F200', 'in_transit', 'SampleCity'],
      ['F000', 'registered', null],
    ]);
  });

  it('binds a standalone order by either of its numbers, without its driver, reference or estimate', () => {
    const result = parseSpxTh(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'พัสดุถูกจัดส่งสำเร็จแล้ว',
      delivered_at: '2026-05-18T22:40:00Z' });
    expect(result.events!.map((event) => [event.provider_code, event.location ?? null])).toEqual([
      ['F980', null], ['F600', null], ['F599', 'HCTO-A - ตัวอย่าง'], ['F510', 'SOCX'], ['F098', null], ['F000', null],
    ]);
    expect(result.events![0]).toEqual({ time: '2026-05-18T22:40:00Z', description: 'พัสดุถูกจัดส่งสำเร็จแล้ว', provider_code: 'F980',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/คนขับ|0800000000|REF-0000|ถนน|"eta|edd/);
    expect(parseSpxTh(fixture('delivered'), DELIVERED_SLS)).toEqual(result);
    // Another SPX number is another order.
    expect(() => parseSpxTh(fixture('delivered'), 'SPXTH26000000009Z'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SPX Express Thailand answered for another shipment' }));
  });

  it('keeps an unknown SPX number, a Shopee number it cannot find, a gateway page and a broken reply apart', async () => {
    const lookup = (number: string, body: unknown, init?: ResponseInit) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(UNKNOWN, fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // A Shopee number it does not find may belong to a parcel from abroad, found only by its SPX number.
    await expect(lookup('TH260000000003D', fixture('not-found'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(UNKNOWN, '<html><title>Verify</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(UNKNOWN, '{"retcode":0,')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('TH260000000009Z', fixture('in-transit'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind });
  });

  it('rejects numbers SPX Thailand does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SPXTH2600000001A', 'SPXVN26000000001A', 'TH26000000001', 'TH260000000001AB']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpxThNumber('TH260000000001')).toBe('TH260000000001');
    expect(normalizeSpxThNumber('th 2600 0000 0001 a')).toBe(IN_TRANSIT_SLS);
  });

  it('routes an SPX Thailand number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-th', source: 'spx-th', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(IN_TRANSIT_SLS)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['spx-th']) });
  });
});

describe('SPX Express Thailand status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(spxThStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'spx-th', providerCode: 'F360', description: 'พัสดุถึงที่ทำการศุลกากร' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
  });
});
