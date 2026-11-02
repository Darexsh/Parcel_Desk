import { describe, expect, it, vi } from 'vitest';
import { CHECKSUMS } from '../../core/detection/checksums.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, RUSSIAN_POST_ENDPOINT, RussianPostTracker } from './adapter.js';
import { parseRussianPost, russianPostNumber } from './parser.js';

const NUMBER = '8546073916204' + [...'0123456789'].find(digit => CHECKSUMS.gs1('8546073916204' + digit))!;
const row = (operationType = 2, operationAttr = 6, humanStatus = 'Delivered to the addressee', date = '2026-03-12T16:58:40.000+07:00') => ({
  operationType, operationAttr, humanStatus, humanOperationStatus: null, date, cityName: 'Sample City', countryName: 'Russia', description: 'PRIVATE extra detail', index: 'PRIVATE postcode',
});
const fixture = () => [{ userTrackingItemId: 'PRIVATE account field', trackingItem: { barcode: NUMBER, globalStatus: 'ARCHIVED',
  isReturned: false, lastOperationDateTime: '2026-03-12T16:58:40.000+00:00', sender: 'PRIVATE sender', recipient: 'PRIVATE recipient',
  trackingHistoryItemList: [row(), row(8, 18, 'Forwarded to the postman', '2026-03-12T09:41:17.000+07:00')],
  futurePathList: [row(2, 25, 'Delivered', '2027-01-01T00:00:00.000+07:00')], hiddenHistoryList: [],
} }];
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1.0' });

describe('Russian Post anonymous tracking', () => {
  it('uses the whole code in one anonymous request, without a page bootstrap or account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    const result = await carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(RUSSIAN_POST_ENDPOINT);
    expect(url.searchParams.get('track-numbers')).toBe(NUMBER);
    expect(url.searchParams.get('language')).toBe('en');
    const options = fetcher.mock.calls[0]![1]!;
    expect(options).toMatchObject({ signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    for (const header of ['Authorization', 'Cookie', 'csrf-token']) expect(new Headers(options.headers).has(header)).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-03-12T16:58:40.000+07:00', delivered_at: '2026-03-12T16:58:40.000+07:00' });
    expect(result.events).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires the whole identity and leaves fabricated IN_PROGRESS shells inconclusive', async () => {
    const body = fixture(); body[0]!.trackingItem.trackingHistoryItemList = [];
    body[0]!.trackingItem.globalStatus = 'IN_PROGRESS';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    for (const barcode of [NUMBER + 'EXTRA', 'ZZ000000014RU']) {
      expect(() => parseRussianPost([{ trackingItem: { ...fixture()[0]!.trackingItem, barcode } }], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const data of [null, [], [fixture()[0], fixture()[0]], [{ trackingItem: null }]]) expect(() => parseRussianPost(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads an item leaving Russia through customs, export and the carrier abroad by its codes', () => {
    const body = fixture(); Object.assign(body[0]!.trackingItem, { globalStatus: 'IN_PROGRESS', trackingHistoryItemList: [
      row(33, 1, 'Released from Russia', '2026-03-10T12:00:08.000+03:00'), row(10, 0, 'Prepared for shipment from Russia', '2026-03-10T12:00:00.000+03:00'),
      row(8, 5, 'Arrived at the customs of Russia', '2026-03-09T08:00:00.000+03:00')] });
    const result = parseRussianPost(body, NUMBER);
    expect(result.events!.map(event => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['33.1', 'in_transit', 'carrier_map'], ['10.0', 'in_transit', 'carrier_map'], ['8.5', 'customs', 'carrier_map']]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'russian-post', providerCode: '11.0', description: 'Прием на таможню' })).toEqual({ kind: 'mapped', stage: 'customs' });
  });

  it('does not end a return while later sorting or transport continues', () => {
    const body = fixture(); Object.assign(body[0]!.trackingItem, { globalStatus: 'RETURNED', isReturned: true,
      trackingHistoryItemList: [row(8, 4, 'Departed from local distribution center'), row(3, 1, 'Returned to the sender', '2026-03-10T12:00:00.000+03:00')] });
    const moving = parseRussianPost(body, NUMBER);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(moving.events![1]!.stage).toBe('exception');
    expect(moving.delivered_at).toBeUndefined();
    body[0]!.trackingItem.trackingHistoryItemList.unshift(row(2, 25, 'Delivered', '2026-03-13T10:00:00.000+03:00'));
    expect(parseRussianPost(body, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(parseRussianPost(body, NUMBER).delivered_at).toBeUndefined();
  });

  it('validates event types and offset clocks without reading planned events or summary clocks', () => {
    for (const patch of [{ operationType: '2' }, { operationAttr: {} }, { humanStatus: {} }, { date: '2026-02-30T12:00:00+07:00' }, { date: '2026-03-12T16:58:40' }, { date: '2026-03-12T16:58:40+99:00' }]) {
      const data = fixture(); Object.assign(data[0]!.trackingItem.trackingHistoryItemList[0]!, patch);
      expect(() => parseRussianPost(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const data = fixture(); data[0]!.trackingItem.trackingHistoryItemList = [row(8, 4, 'Departed from local distribution center')];
    expect(parseRussianPost(data, NUMBER)).toMatchObject({ current_stage: 'in_transit', last_update: '2026-03-12T16:58:40.000+07:00' });
    for (const raw of ['123', NUMBER.slice(0, -1) + (Number(NUMBER.at(-1)) + 1) % 10, 'ZZ000000015RU']) expect(() => russianPostNumber(raw)).toThrow();
    expect(russianPostNumber('zz000000014ru')).toBe('ZZ000000014RU');
  });

  it.each([[417, 'challenge'], [403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation before any request starts', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new RussianPostTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
