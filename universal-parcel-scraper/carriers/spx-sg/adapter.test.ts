import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPX_SG_API } from './adapter.js';
import { normalizeSpxSgNumber, parseSpxSg } from './parser.js';
import { spxSgStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SPXSG26000000001A';
const DELIVERED_SLS = 'SG260000000001A';
const UNKNOWN = 'SPXSG26000000003C';

type Row = Record<string, unknown>;
type Tracking = Row & { records: Row[] };
type Reply = Row & { data: Row & { sls_tracking_info: Tracking } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Singapore HTTP adapter', () => {
  it('asks the Singapore tracker’s lookup for the whole number in English', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ' spxsg 2600-0000-001a ' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://spx.sg/shipment/order/open/order/get_order_info?spx_tn=${DELIVERED}&language_code=en`);
    expect(String(url).startsWith(SPX_SG_API)).toBe(true);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
  });

  it('keeps a delivered parcel from abroad on its instants, without hidden rows or repeated scans', () => {
    const result = parseSpxSg(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parcel has been delivered',
      last_update: '2026-05-21T11:45:00Z', delivered_at: '2026-05-21T11:45:00Z' });
    expect(result.events!.map((event) => [event.provider_code, event.time, event.stage ?? null, event.location ?? null])).toEqual([
      ['F980', '2026-05-21T11:45:00Z', 'delivered', null],
      ['F600', '2026-05-21T09:35:00Z', 'out_for_delivery', null],
      ['F600', '2026-05-21T03:30:00Z', 'out_for_delivery', null],
      ['F510', '2026-05-20T07:30:00Z', 'in_transit', 'Sorting Centre Sample'],
      ['F419', '2026-05-20T04:45:00Z', 'in_transit', null],
      ['F399', '2026-05-20T02:45:00Z', 'in_transit', 'Sample International Airport'],
      ['F360', '2026-05-19T06:20:00Z', 'in_transit', 'Sample International Airport'],
      ['F341', '2026-05-19T03:05:00Z', 'in_transit', 'Origin Port Sample'],
      ['F339', '2026-05-19T03:05:00Z', 'in_transit', 'Origin Port Sample'],
      ['F339', '2026-05-18T23:05:00Z', 'in_transit', 'Origin Port Sample'],
      ['F300', '2026-05-18T03:20:00Z', 'in_transit', 'Origin Port Sample'],
      ['F299', '2026-05-18T03:15:00Z', 'in_transit', 'Overseas Hub Sample'],
      ['F200', '2026-05-16T08:25:00Z', 'in_transit', 'Overseas Hub Sample'],
      ['F000', '2026-05-14T07:10:00Z', 'registered', null],
    ]);
    expect(result.events![3]!.point).toEqual({ latitude: 1.3, longitude: 103.8 });
    expect(JSON.stringify(result)).not.toMatch(/Sample Crescent|Sample Road/);
    expect(parseSpxSg(fixture('delivered'), DELIVERED_SLS)).toEqual(result);
  });

  it('keeps an unknown SPX number, a Shopee number it cannot find, a gateway page and a broken reply apart', async () => {
    const lookup = (number: string, body: unknown, init?: ResponseInit) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(UNKNOWN, fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('SG260000000003C', fixture('not-found'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(UNKNOWN, '<html><title>Verify</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(UNKNOWN, '{"retcode":0,')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(UNKNOWN, { retcode: 0, data: 'shipment' })).rejects.toMatchObject({ kind: 'schema' });
    // Asked by one SPX number, a reply naming a number outside Singapore's layout is another shipment.
    const elsewhere = fixture('delivered');
    elsewhere.data.sls_tracking_info.sls_tn = 'MY260000000001A';
    await expect(lookup(DELIVERED, elsewhere)).rejects.toMatchObject({ kind: 'indeterminate', message: 'SPX Express Singapore answered for another shipment' });
    await expect(lookup('SG260000000009Z', fixture('delivered'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind });
  });

  it('rejects numbers SPX Singapore does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SPXSG2600000001A', 'SPXMY26000000001A', 'SG260000000001', 'SG260000000001AB']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpxSgNumber('sg 2600 0000 0001 a')).toBe(DELIVERED_SLS);
  });

  it('routes an SPX Singapore number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-sg', source: 'spx-sg', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED_SLS)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['spx-sg']) });
  });
});

describe('SPX Express Singapore status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of (statuses.entries as { code: string; wording: string; stage: string; note?: string }[])
      .filter((entry) => !entry.note?.startsWith('Legacy feed status.'))) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(spxSgStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'spx-sg', providerCode: 'F980', description: 'Parcel has been delivered' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
