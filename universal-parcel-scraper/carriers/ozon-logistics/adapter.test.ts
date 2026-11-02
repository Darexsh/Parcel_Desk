import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { CARRIERS } from '../../core/catalog/index.js';
import { adapter } from './adapter.js';
import { normalizeOzonNumber, ozonApi, parseOzon } from './parser.js';

const number = '48271635-2048-1', digits = '4827163520481';
const found = () => ({ deliveryType: 'PVZ', deliveryDateBegin: '2031-04-05T00:00:00Z', deliveryDateEnd: '2031-04-08T00:00:00Z',
  recipient: 'PRIVATE', items: [
    { event: 'Created', moment: '2031-04-01T14:00:00+08:00' },
    { event: 'WayToCity', moment: '2031-04-02T14:00:00+08:00' },
    { event: 'OnTheWayToImportCustomsClearancePhantomStatus', moment: null },
    { event: 'ParcelIsOnTheWay', moment: '2031-04-06T12:00:00Z' },
    { event: 'AvailableForPickup', moment: '2031-04-06T12:00:00Z' },
    { event: 'Received', moment: '2031-04-07T13:00:00Z' },
    { event: 'FantomDelivery', moment: null },
  ] });
const capture = (body: unknown = found(), status = 200) => ({ url: ozonApi(number), status,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  trackingNumberSubmitted: digits, truncated: false, base64Encoded: false, error: null as string | null });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const carrier = (fetcher: typeof fetch, browser = true) => adapter({ env: {}, recorder: NOOP_RECORDER, fetcher,
  trawl: browser ? new TrawlClient('http://browser.test', fetcher) : null, browserExecutablePath: null });

describe('Ozon guest tracking', () => {
  it('preserves the full timeline, explicit offsets, tied scan order and date estimates', () => {
    const result = parseOzon(found());
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2031-04-07T13:00:00Z',
      expected_delivery_from: '2031-04-05', expected_delivery: '2031-04-08' });
    expect(result.events).toHaveLength(5);
    expect(result.events![0]).toMatchObject({ provider_code: 'Received', description: 'Заказ получен в пункте выдачи.' });
    expect(result.events![1]).toMatchObject({ provider_code: 'AvailableForPickup', tie_order: 1 });
    expect(result.events![2]).toMatchObject({ provider_code: 'ParcelIsOnTheWay', tie_order: 0 });
    expect(result.events!.at(-1)!.time).toBe('2031-04-01T14:00:00+08:00');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(normalizeOzonNumber(digits)).toBe(number);
    expect(normalizeOzonNumber('014827163520481')).toBe('0148271635-2048-1');
    expect(CARRIERS['ozon-logistics'].trackingUrl!(digits)).toBe(`https://tracking.ozon.ru/?track=${number}`);
    expect(CARRIERS['ozon-logistics'].trackingUrl!('PL-123456-shop')).toContain('PL-123456-shop');
  });

  it('distinguishes courier delivery, unknown events, local clocks and malformed replies', () => {
    const payload = found(); payload.deliveryType = 'Courier';
    payload.items = [{ event: 'Received', moment: '2031-04-07T13:00:00Z' }];
    expect(parseOzon(payload).events![0]!.description).toBe('Заказ успешно доставлен получателю.');
    payload.items = [{ event: 'NewEvent', moment: '2031-04-07T13:00:00' }];
    expect(parseOzon(payload)).toMatchObject({ status: 'unknown', events: [{ provider_code: 'NewEvent', local_time: '2031-04-07T13:00:00' }] });
    for (const bad of [{}, { ...found(), items: [null] }, { ...found(), items: [{ event: 'Created', moment: 'not a date' }] }]) {
      expect(() => parseOzon(bad)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseOzon({ ...found(), items: [{ event: 'FantomDelivery', moment: null }] })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const bad of [number + '0', 'PL-123456-shop', '48271635/2048/1']) expect(() => normalizeOzonNumber(bad)).toThrow();
  });

  it('keeps HTTP recognition separate and reuses the verified browser history', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('browser.test')
      ? reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture()] })
      : reply({ challengeURL: 'omitted' }, 403));
    const instance = carrier(fetcher);
    await expect(instance.recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(instance.recognizeWithBrowser!(digits, { budgetMs: 10000 })).resolves.toMatchObject({ known: true, result: { events: expect.any(Array) } });
    const request = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(request).toMatchObject({ url: `https://tracking.ozon.ru/?track=${number}`, captureResponses: [ozonApi(number)], skipHttp: true });
    expect(request.maxTimeout).toBeLessThanOrEqual(8000);
    expect(fetcher.mock.calls[1]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('tracks with the configured browser and preserves the latest refusal', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture()] }));
    await expect(carrier(fetcher).track({ number: digits })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const refused = capture({}, status);
      const source = carrier(async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture(), refused] }));
      await expect(source.track({ number })).rejects.toMatchObject({ kind });
    }
  });

  it('requires the exact missing-posting message and bound readable capture', async () => {
    const check = (row: ReturnType<typeof capture>) => carrier(async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [row] })).track({ number });
    await expect(check(capture({ message: `Постинг ${number} не найден` }, 404))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(check(capture({ message: 'Постинг другой не найден' }, 404))).rejects.toMatchObject({ kind: 'schema' });
    await expect(check({ ...capture(), trackingNumberSubmitted: digits + '0' })).rejects.toMatchObject({ kind: 'schema' });
    await expect(check({ ...capture(), url: ozonApi(number) + '0' })).rejects.toMatchObject({ kind: 'challenge' });
    for (const row of [{ ...capture(), error: 'compressed response omitted' }, { ...capture(), truncated: true }, { ...capture(), base64Encoded: true }]) {
      await expect(check(row)).rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(check({ ...capture(), body: '<html>Antibot Challenge Page</html>' })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('classifies direct redirects and missing parcels without invoking a browser', async () => {
    await expect(carrier(async () => new Response('', { status: 307 }), false).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => reply({ message: `Постинг ${number} не найден` }, 404), false).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
