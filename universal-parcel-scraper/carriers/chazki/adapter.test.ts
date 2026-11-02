import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CHAZKI_API, ChazkiTracker } from './adapter.js';
import { chazkiClock, normalizeChazkiNumber, parseChazkiOrder, readChazkiSearch } from './parser.js';
import { chazkiStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '000000000001';
const IN_TRANSIT = 'SMP000000002';
const UNKNOWN = '000000000000';

// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const order = (name: string, change: (order: Reply) => void = () => {}) => {
  const reply = fixture(name);
  change(reply.data.OrderPublic);
  return reply;
};
const search = (...entries: [number, string][]) => ({ data: { OrderPublicTrackCode: entries.map(([id, trackCode]) => ({ id, trackCode })) } });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A service that answers the search, then the order, with these replies. */
const service = (first: () => Response, second: () => Response = () => reply(fixture('delivered'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
    (JSON.parse(String(init!.body)).operationName === 'getOrderPublicTrackCode' ? first() : second()));
const rows = (result: ReturnType<typeof parseChazkiOrder>) =>
  result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null]);

describe('Chazki tracking adapter', () => {
  it('asks the page’s search, then its order, through the supplied transport', async () => {
    const fetcher = service(() => reply(fixture('search')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ChazkiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000 0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe(CHAZKI_API);
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0',
        Origin: 'https://nintendo.chazki.com', Referer: 'https://nintendo.chazki.com/' } });
    }
    const [first, second] = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(first).toMatchObject({ operationName: 'getOrderPublicTrackCode', variables: { trackCode: DELIVERED } });
    expect(second).toMatchObject({ operationName: 'getOrderPublic', variables: { id: 100001 } });
    // The order query asks for no one's name, phone, ID, address, driver or evidence.
    expect(second.query).not.toMatch(/Contact|Address|Point|User|Images|Acuse|Enterprise|Route|product|package|Payment/i);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chazki', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows the page names, newest first, as wall clocks', () => {
    const result = parseChazkiOrder(fixture('delivered'), DELIVERED, 100001);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-05-14T14:58:00', expected_delivery: null,
      service_name: 'NEXT DAY' });
    // The rows the page does not show are left out, and so is the second trip to the sender.
    expect(rows(result)).toEqual([
      ['2026-05-14T14:58:00', '166', 'delivered'],
      ['2026-05-14T09:54:00', '162', 'out_for_delivery'],
      ['2026-05-14T09:54:00', '156', 'registered'],
      ['2026-05-14T09:47:00', '155', 'registered'],
      ['2026-05-14T09:44:00', '154', 'registered'],
    ]);
    expect(result.events!.map((event) => event.description)).toEqual([
      'Entregado', 'En tránsito a entregar el pedido', 'En tránsito a recoger el pedido', 'En programación', 'Orden ingresada']);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
  });

  it('reads a failed delivery, a new date and the trip out again under a lettered code', () => {
    const result = parseChazkiOrder(fixture('in-transit'), IN_TRANSIT.toLowerCase(), 100002);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'En tránsito a entregar el pedido', last_update_local: '2026-05-13T12:15:00', service_name: 'SAME DAY' });
    expect(rows(result)).toEqual([
      ['2026-05-13T12:15:00', '162', 'out_for_delivery'],
      ['2026-05-12T19:02:00', '199', null],
      ['2026-05-12T18:30:00', '169', 'failed_attempt'],
      ['2026-05-12T11:02:00', '162', 'out_for_delivery'],
      // Without a 156, the page shows the trip to the sender's 157.
      ['2026-05-12T10:20:00', '157', 'registered'],
      ['2026-05-12T08:10:00', '155', 'registered'],
      ['2026-05-12T00:05:00', '154', 'registered'],
    ]);
  });

  it('takes the current status’s word, as the page’s rail does', () => {
    const cancelled = parseChazkiOrder(order('delivered', (data) => { data.Status = { subtype: '159', subclass: 'CANCELED' }; }), DELIVERED, 100001);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Orden cancelada' });
    expect(cancelled.events![0]).toMatchObject({ provider_code: '166', stage: 'delivered' });
    const cleared = parseChazkiOrder(order('delivered', (data) => { data.Status.subclass = 'CLEARING'; }), DELIVERED, 100001);
    expect(cleared).toMatchObject({ current_stage: 'delivered', last_status_text: 'Entregado' });
    // A new date moves nothing, and a status the page does not know leaves the newest row's stage.
    const later = parseChazkiOrder(order('in-transit', (data) => { data.Status.subclass = 'REPROGRAMMING'; }), IN_TRANSIT, 100002);
    expect(later).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'En reprogramación' });
    const unknown = parseChazkiOrder(order('in-transit', (data) => { data.Status.subclass = 'SYNTHETIC_STATUS'; }), IN_TRANSIT, 100002);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'En tránsito a entregar el pedido' });
  });

  it('reads an order without rows the page names from its current status alone', () => {
    const result = parseChazkiOrder(order('delivered', (data) => {
      data.Status.subclass = 'PLANNED';
      data.OrderServiceHistorialPublic = [{ statusID: 216, createdAt: '14/05/2026 9:47 am' }];
    }), DELIVERED, 100001);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'En programación',
      provider_code: 'PLANNED', summary_only: true, events: [] });
    expect(result).not.toHaveProperty('last_update_local');
    expect(parseChazkiOrder(order('delivered', (data) => { data.OrderServiceHistorialPublic = null; }), DELIVERED, 100001))
      .toMatchObject({ current_stage: 'delivered', summary_only: true });
  });

  it('reads the reply’s twelve-hour clocks day first, and nothing else', () => {
    expect(chazkiClock('09/03/2026 9:07 am')).toBe('2026-03-09T09:07:00');
    expect(chazkiClock('31/12/2026 12:00 am')).toBe('2026-12-31T00:00:00');
    expect(chazkiClock('01/01/2026 12:59 PM')).toBe('2026-01-01T12:59:00');
    expect(chazkiClock('01/01/2026 11:59 pm')).toBe('2026-01-01T23:59:00');
    for (const clock of ['2026-03-09 09:07', '30/02/2026 9:07 am', '09/13/2026 9:07 am', '09/03/2026 13:07 pm', '09/03/2026 0:07 am',
      '09/03/2026 9:60 am', '09/03/2026 9:07', 1_773_046_020, null]) {
      expect(() => chazkiClock(clock), String(clock)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('counts only an order that names the whole trackcode', async () => {
    expect(readChazkiSearch(fixture('search'), DELIVERED)).toBe(100001);
    expect(readChazkiSearch(search([100002, 'smp000000002']), IN_TRANSIT)).toBe(100002);
    // An entry listed twice is one order.
    expect(readChazkiSearch(search([100001, DELIVERED], [100001, DELIVERED]), DELIVERED)).toBe(100001);
    expect(readChazkiSearch(search([100001, DELIVERED], [100009, '0000000000019']), DELIVERED)).toBe(100001);
    expect(() => readChazkiSearch(search([100009, '0000000000019']), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Chazki matched the trackcode to other orders' }));
    expect(() => parseChazkiOrder(fixture('delivered'), DELIVERED, 100002))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Chazki answered for another order' }));
    expect(() => parseChazkiOrder(fixture('in-transit'), 'SMP000000003', 100002))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Chazki answered for another order' }));
    const fetcher = service(() => reply(fixture('search')), () => reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('leaves a code several senders used to the visitor’s choice', async () => {
    expect(() => readChazkiSearch(search([100001, DELIVERED], [100003, DELIVERED]), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    const fetcher = service(() => reply(search([100001, DELIVERED], [100003, DELIVERED])));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'several_parcels' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the empty search as not found and the service’s own failure as inconclusive', async () => {
    expect(() => readChazkiSearch(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const failure = { errors: [{ message: 'Synthetic resolver failure', extensions: { code: 'INTERNAL_SERVER_ERROR' } }], data: { OrderPublic: null } };
    expect(() => parseChazkiOrder(failure, DELIVERED, 100001)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChazkiOrder({ data: { OrderPublic: null } }, DELIVERED, 100001))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Chazki did not open the order its search found' }));
    const fetcher = service(() => reply(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed reply', () => {
    for (const body of [null, [], 'data', { data: null }, { data: {} }, { data: { OrderPublicTrackCode: 'orders' } },
      { data: { OrderPublicTrackCode: [null] } }, { data: { OrderPublicTrackCode: [{ id: '100001', trackCode: DELIVERED }] } },
      { data: { OrderPublicTrackCode: [{ id: 0, trackCode: DELIVERED }] } }, { data: { OrderPublicTrackCode: [{ id: 100001, trackCode: 1 }] } },
      { data: { OrderPublicTrackCode: Array.from({ length: 51 }, (_, index) => ({ id: index + 1, trackCode: DELIVERED })) } },
      { errors: 'failure', data: null }]) {
      expect(() => readChazkiSearch(body, DELIVERED), JSON.stringify(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (data: Reply) => { data.Status = null; },
      (data: Reply) => { data.Status.subclass = ''; },
      (data: Reply) => { data.Status.subclass = 7; },
      (data: Reply) => { data.OrderServiceHistorialPublic = 'rows'; },
      (data: Reply) => { data.OrderServiceHistorialPublic = Array.from({ length: 501 }, () => data.OrderServiceHistorialPublic[0]); },
      (data: Reply) => { data.OrderServiceHistorialPublic[0] = 'row'; },
      (data: Reply) => { data.OrderServiceHistorialPublic[0].statusID = '166'; },
      (data: Reply) => { data.OrderServiceHistorialPublic[0].createdAt = '2026-05-14T09:54:00Z'; },
      // A row the page does not name still has to be a row.
      (data: Reply) => { data.OrderServiceHistorialPublic[0].createdAt = null; },
      (data: Reply) => { data.Service = 'NEXT DAY'; },
      (data: Reply) => { data.Service.name = 1; },
      (data: Reply) => { delete data.trackCode; },
    ]) {
      expect(() => parseChazkiOrder(order('delivered', change), DELIVERED, 100001)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // GraphQL refuses a query it no longer accepts with HTTP 400 and its reason.
    const refused = { errors: [{ message: 'Cannot query field "trackCode"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] };
    expect(() => readChazkiSearch(refused, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a moved route, a browser check, a broken reply, a refused query and a rate limit apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(service(() => reply(body, init))).track({ number: DELIVERED });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.chazki.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Tonny</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ errors: [{ message: 'Syntax Error', extensions: { code: 'GRAPHQL_PARSE_FAILED' } }] }, { status: 400 }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '120' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the order as %s', async (status, kind) => {
      const fetcher = service(() => reply(fixture('search')), () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    });

  it('sends a lookup that fails to reach Chazki once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('search'))).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects codes Chazki does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000', 'SAMPLECODE', `S${'0'.repeat(40)}`, 'SMP/000000002']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeChazkiNumber(' smp-000 000 002 ')).toBe(IN_TRANSIT);
    // No cheap lookup is asked to recognize a code: none of the shapes is Chazki's alone.
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a code filed under Chazki to the adapter; detection does not offer Chazki', async () => {
    const fetcher = service(() => reply(fixture('search')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'chazki' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'chazki', source: 'chazki', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === CHAZKI_API)).toBe(true);
    for (const number of [DELIVERED, IN_TRANSIT]) expect(detectCarrierMatch(number).carrier, number).not.toBe('chazki');
  });
});

describe('Chazki status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code === undefined) continue;
      if (entry.unmapped) {
        expect(chazkiStage(entry.code), entry.code).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'chazki', providerCode: entry.code, description: entry.wording ?? 'Synthetic row' }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, (entry.wording ?? '').toLowerCase()), entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'chazki', providerCode: '169', description: 'Fallado' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'chazki', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
