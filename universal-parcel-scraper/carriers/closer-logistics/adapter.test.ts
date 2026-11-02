import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CLOSER_API, CloserLogisticsTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { isCloserNotFound, normalizeCloserNumber, parseCloser } from './parser.js';
import { closerStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '900000000011';
const IN_TRANSIT = '900000000022';
const PICKUP = '900000000033';
const UNKNOWN = '900000000044';

type Row = Record<string, unknown>;
type Package = Row & { trackings: Row[] };
type Shipment = Row & { packages: Package[]; lastIncidence: Row | null };

/** Sets a field to a value its type does not allow, as a changed reply would. */
const set = (target: object, key: string, value: unknown) => { (target as Row)[key] = value; };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const shipment = (name: string) => JSON.parse(fixture(name)) as Shipment;
const changed = (name: string, change: (shipment: Shipment) => void): Shipment => {
  const reply = shipment(name);
  change(reply);
  return reply;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
const timeline = (payload: Shipment, number: string) => parseCloser(payload, number).events!
  .map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.description]);
const NOT_FOUND = fixture('not-found');

describe('Closer Logistics HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CloserLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 0000 0022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CLOSER_API}${IN_TRANSIT}`);
    expect(String(url)).toBe('https://admin.closerlogistics.com/tracking/shipments/900000000022');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'closer-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first as wall clocks, with the reason beside the attempt it explains', () => {
    const result = parseCloser(shipment('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-03-05T12:10:45', expected_delivery: null,
      sender_name: 'Sample Shop' });
    expect(timeline(shipment('delivered'), DELIVERED)).toEqual([
      ['2026-03-05T12:10:45', 'delivered', 'delivered', 'Entregado'],
      ['2026-03-05T08:30:02', 'out_for_delivery', 'out_for_delivery', 'En reparto'],
      ['2026-03-04T18:55:30', 'hub', 'in_transit', 'Recibido en almacén'],
      ['2026-03-04T18:40:12', 'failed_delivery_attempt', 'failed_attempt', 'Entrega fallida: FUERA HORARIO COMERCIAL'],
      ['2026-03-04T08:15:00', 'out_for_delivery', 'out_for_delivery', 'En reparto'],
      ['2026-03-03T17:20:41', 'hub', 'in_transit', 'Recibido en almacén'],
      // The latest incidence explains only the attempt it is dated with.
      ['2026-03-03T17:02:19', 'failed_delivery_attempt', 'failed_attempt', 'Entrega fallida'],
      ['2026-03-03T09:01:33', 'out_for_delivery', 'out_for_delivery', 'En reparto'],
      ['2026-03-03T03:44:00', 'hub', 'in_transit', 'Recibido en almacén'],
      // The page's first step, dated with the shipment's creation.
      ['2026-03-02T21:05:10', 'documented', 'registered', 'Orden de pedido recibida'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(result.events!.filter((event) => event.stage).every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps no recipient, phone number, address, coordinates, receiver, driver or internal identifier', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT], ['pickup', PICKUP]] as const) {
      const text = JSON.stringify(parseCloser(shipment(name), number));
      expect(text, name).not.toMatch(/Sample (?:Recipient|Customer|Receiver|Town)|Calle|\+34|600 00|40\.\d|-3\.\d|1000001|2000001|30001|6000001|7000001|geoposition/);
    }
  });

  it('merges the packages of a shipment and keeps a status at the same clock once', () => {
    const result = parseCloser(shipment('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'En reparto',
      last_update_local: '2026-03-12T08:45:10' });
    expect(timeline(shipment('in-transit'), IN_TRANSIT)).toEqual([
      ['2026-03-12T08:45:10', 'out_for_delivery', 'out_for_delivery', 'En reparto'],
      ['2026-03-12T04:13:27', 'hub', 'in_transit', 'Recibido en almacén'],
      ['2026-03-12T04:12:00', 'hub', 'in_transit', 'Recibido en almacén'],
      ['2026-03-10T22:10:00', 'documented', 'registered', 'Orden de pedido recibida'],
    ]);
  });

  it('reads a pickup as a return collected from the customer on its way back to the shop', () => {
    const result = parseCloser(shipment('pickup'), PICKUP);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Pendiente de devolución', last_update_local: '2026-03-20T06:10:00' });
    // The shop is the recipient of a pickup, not its sender.
    expect(result).not.toHaveProperty('sender_name');
    expect(timeline(shipment('pickup'), PICKUP)).toEqual([
      ['2026-03-20T06:10:00', 'for_return', 'in_transit', 'Pendiente de devolución'],
      ['2026-03-19T21:30:00', 'hub', 'in_transit', 'Recibido en almacén'],
      ['2026-03-19T11:05:00', 'picked_up', 'accepted', 'Recogido'],
      ['2026-03-18T13:40:00', 'failed_pickup_attempt', 'exception', 'Recogida fallida: CLIENTE AUSENTE'],
      ['2026-03-17T10:00:00', 'ready_for_pickup', 'registered', 'Pendiente de recogida'],
    ]);
    const back = parseCloser(changed('pickup', (reply) => {
      reply.status = 'returned';
      reply.packages[0]!.trackings.unshift({ id: 7000025, createdAt: '21/03/2026 10:00:00', status: 'returned' });
    }), PICKUP);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Devuelto' });
  });

  it('reads a delivery going back to the shop as an exception', () => {
    const result = parseCloser(changed('delivered', (reply) => {
      reply.status = 'for_return';
      reply.packages[0]!.trackings = [{ id: 7000010, createdAt: '06/03/2026 09:00:00', status: 'for_return' }, ...reply.packages[0]!.trackings.slice(1)];
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Pendiente de devolución' });
  });

  it('takes the shipment’s own status over its newest one, else the newest staged status', () => {
    const behind = parseCloser(changed('in-transit', (reply) => { reply.status = 'delivered'; }), IN_TRANSIT);
    expect(behind).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'En reparto' });
    for (const status of ['synthetic_state', null]) {
      const unread = parseCloser(changed('in-transit', (reply) => { reply.status = status; }), IN_TRANSIT);
      expect(unread, String(status)).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    }
    // A status the page does not name keeps its code, without a stage.
    const unknown = parseCloser(changed('in-transit', (reply) => {
      reply.status = 'synthetic_state';
      reply.packages[0]!.trackings.unshift({ id: 7000015, createdAt: '12/03/2026 10:00:00', status: 'synthetic_state' });
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'synthetic_state' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-12T10:00:00', description: 'synthetic_state', provider_code: 'synthetic_state' });
  });

  it('reads a shipment without statuses as an order received, and keeps the page’s first step when a status dates it', () => {
    const fresh = parseCloser(changed('in-transit', (reply) => {
      reply.status = 'documented';
      for (const item of reply.packages) item.trackings = [];
    }), IN_TRANSIT);
    expect(fresh).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Orden de pedido recibida',
      last_update_local: '2026-03-10T22:10:00', events: [{ provider_code: 'documented' }] });
    expect(parseCloser(changed('in-transit', (reply) => set(reply, 'packages', [])), IN_TRANSIT).events).toHaveLength(1);
    const dated = parseCloser(changed('in-transit', (reply) => {
      reply.packages[1]!.trackings.push({ id: 7000010, createdAt: '11/03/2026 06:00:00', status: 'documented' });
    }), IN_TRANSIT);
    expect(dated.events!.filter((event) => event.provider_code === 'documented').map((event) => event.local_time)).toEqual(['2026-03-11T06:00:00']);
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseCloser(shipment('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Closer Logistics answered for another shipment' }));
    expect(parseCloser(changed('delivered', (reply) => { reply.trackingNumber = Number(DELIVERED); }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    const many = Array.from({ length: 501 }, (_, index) => ({ id: index, createdAt: '03/03/2026 10:00:00', status: 'hub' }));
    for (const payload of [
      {}, null, 'Synthetic', [], JSON.parse(NOT_FOUND),
      changed('delivered', (reply) => { delete reply.trackingNumber; }),
      changed('delivered', (reply) => { reply.trackingNumber = { value: DELIVERED }; }),
      changed('delivered', (reply) => { reply.trackingNumber = 90000000001.1; }),
      changed('delivered', (reply) => { reply.trackingNumber = ' '; }),
      changed('delivered', (reply) => { reply.type = 1; }),
      changed('delivered', (reply) => { reply.status = 'Entregado'; }),
      changed('delivered', (reply) => { reply.status = 4; }),
      changed('delivered', (reply) => { delete reply.createdAt; }),
      changed('delivered', (reply) => { reply.createdAt = '2026-03-02T21:05:10Z'; }),
      changed('delivered', (reply) => set(reply, 'packages', {})),
      changed('delivered', (reply) => set(reply, 'packages', Array.from({ length: 51 }, () => reply.packages[0]))),
      changed('delivered', (reply) => set(reply.packages, '0', 'package')),
      changed('delivered', (reply) => set(reply.packages[0]!, 'trackings', 'statuses')),
      changed('delivered', (reply) => { reply.packages[0]!.trackings = many; }),
      changed('delivered', (reply) => set(reply.packages[0]!.trackings, '0', 'delivered')),
      changed('delivered', (reply) => { delete reply.packages[0]!.trackings[0]!.status; }),
      changed('delivered', (reply) => { reply.packages[0]!.trackings[0]!.status = 'DELIVERED'; }),
      changed('delivered', (reply) => { delete reply.packages[0]!.trackings[0]!.createdAt; }),
      changed('delivered', (reply) => { reply.packages[0]!.trackings[0]!.createdAt = '05/03/2026 12:10'; }),
      changed('delivered', (reply) => { reply.packages[0]!.trackings[0]!.createdAt = '2026-03-05 12:10:45'; }),
      changed('delivered', (reply) => { reply.packages[0]!.trackings[0]!.createdAt = '30/02/2026 12:10:45'; }),
      changed('delivered', (reply) => { reply.packages[0]!.trackings[0]!.createdAt = '05/03/2026 24:10:45'; }),
      changed('delivered', (reply) => { reply.packages[0]!.trackings[0]!.createdAt = 1772709045; }),
      changed('delivered', (reply) => set(reply, 'lastIncidence', 'FUERA HORARIO COMERCIAL')),
      changed('delivered', (reply) => set(reply.lastIncidence!, 'reason', 'FUERA HORARIO COMERCIAL')),
      changed('delivered', (reply) => { reply.lastIncidence!.createdAt = '04/03/2026'; }),
      changed('delivered', (reply) => set(reply, 'distributor', 'Sample Shop')),
    ]) {
      expect(() => parseCloser(payload, DELIVERED), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the lookup’s JSON 404 as not found, and keeps a moved lookup, a bot check and a broken reply apart', async () => {
    await expect(lookup(NOT_FOUND, { status: 404 }, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(isCloserNotFound({ code: 404, message: 'Not Found', detail: 'Synthetic' })).toBe(false);
    // A redirect goes to the sign-in page; a 404 of another shape or a 410 is a moved service.
    await expect(lookup('', { status: 302, headers: { Location: 'https://admin.closerlogistics.com/tracking/login' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('{"code":404,"message":"No route found"}', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(NOT_FOUND, { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>', { status: 404 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="cf-turnstile" data-sitekey="synthetic"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '<html><title>DeliveryTracking</title></html>', '{}', 'null', NOT_FOUND]) {
      await expect(lookup(body), body).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that did not reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply over its size limit', async () => {
    await expect(lookup('{}', { headers: { 'Content-Length': String(3_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Closer does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(NOT_FOUND, { status: 404 }));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T12:10:45' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('90000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Closer does not issue and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['90000000001', '9000000000111', 'ZZ123456785ES', 'SAMPLE000011', '', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCloserNumber('9000-0000-0011')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('routes a number filed under Closer Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).startsWith(CLOSER_API) ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'closer-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'closer-logistics', source: 'closer-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${CLOSER_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Closer Logistics numbers', () => {
  it('accepts every public number, which no rule claims, and reads the tracking page link', () => {
    const own = numbers.records.filter((record) => record.context.assessment === 'confirmed');
    expect(own.length).toBeGreaterThan(0);
    for (const record of own) {
      expect(normalizeCloserNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number).carrier, record.number).not.toBe('closer-logistics');
      expect(recognitionCandidates(record.number).map(({ carrier }) => carrier), record.number).not.toContain('closer-logistics');
    }
    expect(parseTrackingInput(`https://tracking.closerlogistics.com/tracking/${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'closer-logistics' });
  });
});

describe('Closer Logistics status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    const coded = statuses.entries.filter((entry): entry is typeof entry & { code: string } => 'code' in entry && Boolean(entry.code));
    expect(coded).toHaveLength(10);
    for (const entry of coded) {
      expect(closerStage(entry.code, false), entry.code).toBe(entry.stage);
      if (entry.code === 'for_return') {
        // A pickup's next leg; the code alone does not say which.
        expect(closerStage(entry.code, true)).toBe('in_transit');
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'closer-logistics', providerCode: entry.code, description: entry.wording })).toEqual({ kind: 'unknown' });
        continue;
      }
      expect(closerStage(entry.code, true), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'closer-logistics', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'closer-logistics', providerCode: 'synthetic_state', description: 'synthetic_state' })).toEqual({ kind: 'unknown' });
  });
});
