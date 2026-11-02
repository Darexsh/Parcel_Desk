import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { dayRossOrder, parseDayRoss } from './parser.js';

const number = 'A99900001';
const order = { shipmentNumber: number, probillNumber: null, orderId: 99900001 };
const search = { total: 1, orderItems: [order] };
const state = { sitecore: { context: { profileData: { basic_info: { isAuthenticated: false }, app_settings: { service_apiKey: 'synthetic.guest.token' } } } } };
const page = `<script type="application/json" id="__JSS_STATE__">${JSON.stringify(state)}</script>`;
const found = () => ({ ...order, status: 'Delivered', serviceLevelDescription: 'Standard', signedBy: 'PRIVATE', tracking: [
  { date: '2031-04-16T00:00:00', touchPoints: [
    { status: 'Order accepted', statusCode: 'AVAIL', time: '2031-04-16T10:00:00', city: 'Example City' },
    { status: 'Shipment Picked Up', statusCode: 'DEPSHIP', time: '2031-04-16T11:00:00', city: 'Example City' },
    { status: 'POSITION', statusCode: 'POSITION', time: '2031-04-16T11:30:00', city: 'Example City' },
    { status: 'Delivered', statusCode: 'COMPLETE', time: '2031-04-16T12:00:00', city: 'Example City' },
  ] },
] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const service = (details = found(), searched: unknown = search) => vi.fn<typeof fetch>(async input => {
  const url = String(input);
  if (url.includes('azurewebsites.net')) return new Response(page);
  if (url.includes('/TrackOrders?')) return json(searched);
  return json(details);
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

describe('Day & Ross', () => {
  it('uses the anonymous guest session and passes the internal order id to the history request', async () => {
    const fetcher = service();
    const answer = await createTracker({ fetcher, env: {}, providers: [] }).track({ number, carrier: 'day-ross' }, { budgetMs: 5000 });
    expect(answer).toMatchObject({ carrier: 'day-ross', source: 'day-ross', result: { current_stage: 'delivered',
      last_update: '2031-04-16T12:00:00-03:00', last_update_local: '2031-04-16T12:00:00', service_name: 'Standard' } });
    expect(answer.result.events).toHaveLength(3);
    expect(JSON.stringify(answer.result)).not.toContain('PRIVATE');
    expect(String(fetcher.mock.calls[2]![0])).toContain('probillNumber=99900001');
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: 'Bearer synthetic.guest.token' });
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('refuses reference-only, ambiguous and mismatched results', () => {
    expect(dayRossOrder(search, number)).toEqual(order);
    for (const result of [{ total: 2, orderItems: [order, order] }, { total: 1, orderItems: [{ ...order, shipmentNumber: 'A99900002' }] }]) {
      expect(() => dayRossOrder(result, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const wrong = { ...found(), orderId: 'another-order' };
    expect(() => parseDayRoss(wrong, number, order)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badClock = found(); badClock.tracking[0]!.touchPoints[0]!.time = '2031-02-30T12:00:00';
    expect(() => parseDayRoss(badClock, number, order)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps older-system searches inconclusive and recognizes only a shipment the carrier binds', async () => {
    await expect(carrier(service()).recognize!(number)).resolves.toMatchObject({ known: true, lastActivityAt: null });
    const empty = service(found(), { total: 0, orderItems: [] });
    await expect(carrier(empty).track({ number: 'A99999999' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(empty).track({ number: 'SML9999999' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('removes guest credentials from upstream failures and respects cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => String(input).includes('azurewebsites.net') ? new Response(page) : json({ error: 'outage' }, 500));
    const error: unknown = await carrier(fetcher).track({ number }).catch(value => value);
    expect(error).toMatchObject({ kind: 'indeterminate' });
    expect(JSON.stringify(error)).not.toContain('synthetic.guest.token');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(fetcher).track({ number }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
