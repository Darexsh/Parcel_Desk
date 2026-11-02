import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPX_VN_API } from './adapter.js';
import { normalizeSpxVnNumber, parseSpxVn } from './parser.js';
import { spxVnStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SPXVN26000000001A';
const DELIVERED_SLS = 'VN2600000000017';
const IN_TRANSIT = 'SPXVN26000000002B';
const UNKNOWN = 'SPXVN26000000003C';

type Row = Record<string, unknown>;
type Tracking = Row & { records: Row[] };
type Reply = Row & { data: Row & { sls_tracking_info: Tracking } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Vietnam HTTP adapter', () => {
  it('asks the Vietnamese tracker’s lookup for the whole number in Vietnamese', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://spx.vn/shipment/order/open/order/get_order_info?spx_tn=${IN_TRANSIT}&language_code=vi`);
    expect(String(url).startsWith(SPX_VN_API)).toBe(true);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });

  it('keeps a delivery on the second round, without the hidden failed attempt or the seller’s area', () => {
    const result = parseSpxVn(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Giao hàng thành công',
      last_update: '2026-05-20T04:40:00Z', delivered_at: '2026-05-20T04:40:00Z' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['F980', 'delivered', null],
      ['F600', 'out_for_delivery', null],
      ['F599', 'in_transit', '00-XYZ Mau Hub'],
      ['F600', 'out_for_delivery', null],
      ['F599', 'in_transit', '00-XYZ Mau Hub'],
      ['F510', 'in_transit', 'Mau SOC'],
      ['F440', 'in_transit', '00-ABC Mau Hub'],
      ['F100', 'accepted', null],
      ['F000', 'registered', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Duong|không thành công/);
    expect(parseSpxVn(fixture('delivered'), DELIVERED_SLS)).toEqual(result);
  });

  it('reads a parcel at its first hub after a failed pickup and a drop-off', () => {
    const result = parseSpxVn(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Đơn hàng đã đến kho' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['F440', 'in_transit', null], ['F098', 'accepted', null], ['F001', 'registered', null], ['F000', 'registered', null],
    ]);
  });

  it('keeps an unknown SPX number, a Shopee number it cannot find, a gateway page and a broken reply apart', async () => {
    const lookup = (number: string, body: unknown, init?: ResponseInit) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(UNKNOWN, fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('VN2600000000035', fixture('not-found'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(UNKNOWN, '<html><title>Verify</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(UNKNOWN, '{"retcode":0,')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('VN2600000000099', fixture('delivered'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind });
  });

  it('rejects numbers SPX Vietnam does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SPXVN2600000001A', 'SPXTH26000000001A', 'VN260000000001', 'VN260000000001AB']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpxVnNumber('vn 2600 0000 0001 7')).toBe(DELIVERED_SLS);
  });

  it('routes an SPX Vietnam number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-vn', source: 'spx-vn', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED_SLS)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['spx-vn']) });
  });
});

describe('SPX Express Vietnam status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(spxVnStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'spx-vn', providerCode: 'F650', description: 'Giao hàng không thành công' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
  });
});
