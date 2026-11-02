import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPX_MY_API } from './adapter.js';
import { normalizeSpxMyNumber, parseSpxMy } from './parser.js';
import { spxMyStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SPXMY26000000001A';
const DELIVERED_SLS = 'MY260000000001A';
const IN_TRANSIT = 'SPXMY26000000002B';
const UNKNOWN = 'SPXMY26000000003C';

type Row = Record<string, unknown>;
type Tracking = Row & { records: Row[] };
type Reply = Row & { data: Row & { sls_tracking_info: Tracking } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Malaysia HTTP adapter', () => {
  it('asks the Malaysian tracker’s lookup for the whole number in English, its wording without names', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: ' spxmy 2600-0000-002b ' })).resolves.toMatchObject({ current_stage: 'failed_attempt' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://spx.com.my/shipment/order/open/order/get_order_info?spx_tn=${IN_TRANSIT}&language_code=en`);
    expect(String(url).startsWith(SPX_MY_API)).toBe(true);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });

  it('keeps a delivered parcel from abroad, and leaves the delay notice without a stage', () => {
    const result = parseSpxMy(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parcel has been delivered',
      last_update: '2026-05-21T00:40:00Z', delivered_at: '2026-05-21T00:40:00Z' });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['F980', 'delivered', null],
      ['F600', 'out_for_delivery', null],
      ['F599', 'in_transit', 'Hub Contoh'],
      ['F540', 'in_transit', null],
      ['F420', 'in_transit', 'Sorting Centre Sampel'],
      ['F399', 'in_transit', 'Contoh International Airport'],
      ['F360', 'in_transit', 'Contoh International Airport'],
      ['F341', 'in_transit', 'Origin Port Sample'],
      ['F339', 'in_transit', 'Origin Port Sample'],
      ['F418', null, 'Origin Port Sample'],
      ['F300', 'in_transit', 'Origin Port Sample'],
      // The seller's drop-off abroad keeps no place.
      ['F096', 'accepted', null],
      ['F000', 'registered', null],
    ]);
    expect(result.events![9]!.description).toBe('Exception');
    expect(JSON.stringify(result)).not.toMatch(/Seller|Jalan/);
    expect(parseSpxMy(fixture('delivered'), DELIVERED_SLS)).toEqual(result);
  });

  it('reads a failed delivery attempt with its reason, and a drop-off point without its place', () => {
    const result = parseSpxMy(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      last_status_text: 'Delivery attempt was unsuccessful: :Incorrect Recipient Address' });
    expect(result.events!.at(-2)).toEqual({ time: '2026-05-17T08:40:00Z', description: 'Parcel has been received at dropoff point:Kedai Contoh',
      provider_code: 'F098', stage: 'accepted', stage_source: 'carrier_map' });
  });

  it('keeps an unknown SPX number, a Shopee number it cannot find, a gateway page and a broken reply apart', async () => {
    const lookup = (number: string, body: unknown, init?: ResponseInit) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(UNKNOWN, fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('MY260000000003C', fixture('not-found'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(UNKNOWN, '<html><title>Verify</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(UNKNOWN, '{"retcode":0,')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(UNKNOWN, { retcode: 0, data: 'shipment' })).rejects.toMatchObject({ kind: 'schema' });
    // Asked by one SPX number, a reply naming a number outside Malaysia's layout is another shipment.
    const elsewhere = fixture('delivered');
    elsewhere.data.sls_tracking_info.sls_tn = 'ID260000000001A';
    await expect(lookup(DELIVERED, elsewhere)).rejects.toMatchObject({ kind: 'indeterminate', message: 'SPX Express Malaysia answered for another shipment' });
    await expect(lookup('MY260000000009Z', fixture('delivered'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind });
  });

  it('rejects numbers SPX Malaysia does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SPXMY2600000001A', 'SPXID26000000001A', 'MY260000000001', 'MY260000000001AB']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpxMyNumber('my 2600 0000 0001 a')).toBe(DELIVERED_SLS);
  });

  it('routes an SPX Malaysia number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-my', source: 'spx-my', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED_SLS)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['spx-my']) });
  });
});

describe('SPX Express Malaysia status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives, and the delay notice as a gap', () => {
    for (const entry of (statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean; note?: string }[])
      .filter((entry) => !entry.note?.startsWith('Legacy feed status.'))) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(spxMyStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'spx-my', providerCode: entry.code, description: entry.wording }))
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(spxMyStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'spx-my', providerCode: 'F606', description: 'Your parcel is on the way to collection point' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
