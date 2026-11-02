import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FLASH_EXPRESS_PH_API, FlashExpressPhTracker } from './adapter.js';
import { normalizeFlashExpressPhNumber, parseFlashExpressPh } from './parser.js';
import { flashExpressPhStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'P0101000000DA';
const RETURNED = 'P0202000000RB';
const IN_TRANSIT = 'P0303000000TC';
const UNKNOWN = 'P9999000000ZZ';

type Row = Record<string, unknown>;
type Entry = Row & { parcel_routes: Row[] };
type Reply = Row & { data: Entry[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply, entry: Entry) => void) => {
  const reply = fixture(name);
  change(reply, reply.data[0]!);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The five-second browser check in front of the website, as it answers a plain request.
const SHIELD = '<!DOCTYPE html><html><head><title>5 Second Shield</title><script>var cpk = "ge_ua_p"; var step = "prev";</script></head>'
  + '<body><h1>Browser security check</h1></body></html>';

describe('Flash Express Philippines HTTP adapter', () => {
  it('posts the whole number in capitals to the app’s public lookup once, in English, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FlashExpressPhTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' p0303-000000tc ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(FLASH_EXPRESS_PH_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Accept-Language': 'en', 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init!.body))).toEqual({ pno_list: [IN_TRANSIT], pub_query: true, show_sign_pic: false });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'flash-express-ph', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the delivery on Manila’s clock, town before province, without the people and phone numbers the reply names', () => {
    const result = parseFlashExpressPh(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been delivered. Thank you for using Flash Express service.',
      last_update: '2026-03-04T14:28:38+08:00', delivered_at: '2026-03-04T14:28:38+08:00', expected_delivery: null });
    // The repeated courier scan counts once and the van scan worded with a dash is left out.
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-03-04T14:28:38+08:00', 'DELIVERY_CONFIRM', 'delivered'],
      ['2026-03-04T11:21:15+08:00', 'PHONE', null],
      ['2026-03-04T09:10:00+08:00', 'DELIVERY_TICKET_CREATION_SCAN', 'out_for_delivery'],
      ['2026-03-03T21:47:39+08:00', 'ARRIVAL_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-03T21:40:00+08:00', 'ARRIVAL_GOODS_VAN_CHECK_SCAN', 'in_transit'],
      ['2026-03-03T13:16:36+08:00', 'SHIPMENT_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-02T23:10:00+08:00', 'ARRIVAL_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-02T18:05:50+08:00', 'SHIPMENT_WAREHOUSE_SCAN', 'in_transit'],
      ['2026-03-02T15:32:52+08:00', 'RECEIVED', 'accepted'],
    ]);
    expect(result.events![0]).toMatchObject({ location: 'Sample City, Sample Province' });
    expect(result.events![4]).not.toHaveProperty('location');
    expect(result.events!.at(-1)).toMatchObject({ description: 'Your parcel has been picked up by the [ORG_SP] courier.',
      location: 'Origin City, Origin Province' });
    expect(result.events!.some((event) => 'provider_leg' in event)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Person|Courier|Sender|Recipient)|In Person|0900|signer|【/);
    // The older courier wording named the courier after the note.
    const named = parseFlashExpressPh(changed('delivered', (_body, entry) => {
      entry.parcel_routes[2]!.message = 'Your parcel is being delivered by Flash Express. Courier informationSample Courier (000000) 090****0000'
        + 'Download the APP to view package details,【Sample Province】,【Sample City】';
    }), DELIVERED);
    expect(named.events![2]).toMatchObject({ description: 'Your parcel is being delivered by Flash Express.', location: 'Sample City, Sample Province' });
    expect(JSON.stringify(named)).not.toMatch(/Sample Courier|Courier information|\*{4}/);
  });

  it('follows a parcel sent back to its sender, whose return delivery is the return', () => {
    const result = parseFlashExpressPh(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Return parcel received by sender', last_update: '2026-04-12T15:08:55+08:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code ?? null, event.stage ?? null, event.provider_leg ?? null, event.description])).toEqual([
      ['DELIVERY_CONFIRM', 'returned', 'return', 'Return parcel received by sender'],
      ['DELIVERY_TICKET_CREATION_SCAN', 'out_for_delivery', 'return', 'Return handover'],
      ['ARRIVAL_WAREHOUSE_SCAN', 'in_transit', 'return', 'Parcel arrived at outlet'],
      ['SHIPMENT_WAREHOUSE_SCAN', 'in_transit', 'return', 'Parcel outbound to next station'],
      ['RECEIVE_WAREHOUSE_SCAN', 'accepted', 'return', 'Parcel received by origin outlet'],
      ['PENDING_RETURN', 'returned', 'return', 'our shipment has been returned. Return waybill number: P0202000009RD.'],
      ['DELIVERY_MARKER', 'failed_attempt', null, 'Delivery at SMP_SP failed due to Recipient Missed Delivery.'],
      ['DELIVERY_TICKET_CREATION_SCAN', 'out_for_delivery', null, 'Your package is currently being delivered by a Flash Express courier.'],
      ['ARRIVAL_WAREHOUSE_SCAN', 'in_transit', null, 'Your package has arrived SMP_SP'],
      ['SHIPMENT_WAREHOUSE_SCAN', 'in_transit', null, 'Your shipment is in transit from ORG_PDC to SMP_SP.'],
      ['SHIPMENT_WAREHOUSE_SCAN', 'in_transit', null, 'Picked up by courier at ORG_PDC.'],
      [null, null, null, 'Sender Not at Pickup Location'],
    ]);
    expect(JSON.stringify(result)).not.toContain('Sample Shop');
    // A delivery after the system sends a parcel back is the return too, whatever its wording.
    const auto = parseFlashExpressPh(changed('returned', (_body, entry) => {
      entry.parcel_routes[0]!.message = 'Synthetic handover';
      entry.parcel_routes[5]!.route_action = 'SYSTEM_AUTO_RETURN';
      entry.state = 2;
    }), RETURNED);
    expect(auto).toMatchObject({ current_stage: 'returned', last_status_text: 'Synthetic handover' });
    expect(auto.events![0]).toMatchObject({ stage: 'returned', provider_leg: 'return' });
  });

  it('reads the newer wording, the van scans and an unfinished journey', () => {
    const result = parseFlashExpressPh(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your package has arrived SMP_SP', last_update: '2026-05-07T09:12:29+08:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['ARRIVAL_WAREHOUSE_SCAN', 'in_transit', 'Your package has arrived SMP_SP'],
      ['ARRIVAL_GOODS_VAN_CHECK_SCAN', 'in_transit', 'Cargo and vehicle linkage for arrival'],
      ['SHIPMENT_WAREHOUSE_SCAN', 'in_transit', 'Your shipment is in transit from 01 PN1-HUB_Sample to SMP_SP.'],
      ['ARRIVAL_WAREHOUSE_SCAN', 'in_transit', 'Your package has arrived 01 PN1-HUB_Sample'],
      ['DEPARTURE_GOODS_VAN_CK_SCAN', 'in_transit', 'Cargo and vehicle linkage for departure'],
      ['SHIPMENT_WAREHOUSE_SCAN', 'in_transit', 'Your shipment is in transit from ORG_PDC to 01 PN1-HUB_Sample.'],
      ['RECEIVE_WAREHOUSE_SCAN', 'accepted', 'Your shipment has been received and stored at ORG_PDC.'],
      ['RECEIVED', 'accepted', 'Picked up by courier at ORG_PDC.'],
    ]);
    // Some parcels' scans come without codes; their wording gives the stage.
    const uncoded = parseFlashExpressPh(changed('in-transit', (_body, entry) => {
      entry.parcel_routes = [['Parcel arrived at outlet', 1778116349], ['Parcel outbound to next station', 1778075216],
        ['Parcel received by origin outlet', 1777982400], ['Successful pick up', 1777977442]]
        .map(([message, at]) => ({ route_action: null, message, routed_at: at }));
    }), IN_TRANSIT);
    expect(uncoded.events!.map((event) => [event.stage, event.stage_source])).toEqual([
      ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'], ['accepted', 'carrier_map'], ['accepted', 'carrier_map'],
    ]);
    // A problem parcel is the summary's to decide.
    const problem = parseFlashExpressPh(changed('in-transit', (_body, entry) => { entry.state = 6; }), IN_TRANSIT);
    expect(problem).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
  });

  it('reads an unknown number as not found, and a parcel without scans as no history', () => {
    expect(() => parseFlashExpressPh(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFlashExpressPh(changed('not-found', (_body, entry) => { entry.parcel_routes = []; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFlashExpressPh(changed('delivered', (_body, entry) => { entry.parcel_routes = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseFlashExpressPh(changed('in-transit', (_body, entry) => { entry.parcel_routes = [entry.parcel_routes[2]!]; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // Scans without a summary are still a parcel.
    expect(parseFlashExpressPh(changed('in-transit', (_body, entry) => { entry.state = null; }), IN_TRANSIT).current_stage).toBe('in_transit');
  });

  it('counts a parcel only when the reply echoes its whole number', () => {
    expect(() => parseFlashExpressPh(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpressPh(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpressPh(changed('in-transit', (_body, entry) => { entry.pno = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpressPh(changed('in-transit', (body) => { body.data = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = parseFlashExpressPh(changed('in-transit', (body) => { body.data.unshift(fixture('not-found').data[0]!); }), IN_TRANSIT);
    expect(mixed.current_stage).toBe('in_transit');
  });

  it('keeps a failed lookup apart from a throttled one', () => {
    const failed = (message: string) => ({ code: 0, message, data: null });
    expect(() => parseFlashExpressPh(failed('Internal server error'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlashExpressPh(failed('Too many requests, please try again later'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'rate_limited' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.code; },
      (body: Reply) => { body.data = null as never; },
      (body: Reply) => { body.data = { list: [] } as never; },
      (body: Reply) => { body.data.push('parcel' as never); },
      (_body: Reply, entry: Entry) => { delete entry.pno; },
      (_body: Reply, entry: Entry) => { entry.state = '2'; },
      (_body: Reply, entry: Entry) => { entry.parcel_routes = 'routes' as never; },
      (_body: Reply, entry: Entry) => { entry.parcel_routes = Array.from({ length: 501 }, () => entry.parcel_routes[0]!); },
      (_body: Reply, entry: Entry) => { entry.parcel_routes[0] = 'scan' as never; },
      (_body: Reply, entry: Entry) => { entry.parcel_routes[0]!.routed_at = '2026-05-07 09:12:29'; },
      (_body: Reply, entry: Entry) => { entry.parcel_routes[0]!.routed_at = 1778116349000; },
      (_body: Reply, entry: Entry) => { delete entry.parcel_routes[0]!.routed_at; },
      (_body: Reply, entry: Entry) => { entry.parcel_routes[0]!.message = ['arrived']; },
      (_body: Reply, entry: Entry) => { entry.parcel_routes[0]!.message = ',【Sample Province】,【Sample City】'; },
      (_body: Reply, entry: Entry) => { entry.parcel_routes[0]!.route_action = 7; },
    ]) {
      expect(() => parseFlashExpressPh(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a missing route, the browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.flashexpress.ph/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The website's browser check answers HTTP 200 with a page.
    await expect(lookup(SHIELD, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>var arg1="0";document.cookie="acw_sc__v2="+arg1</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Flash Express</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Flash Express Philippines does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-03-04T06:28:38.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('TH0101000000DA')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Flash Express Philippines does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['P0101000DA', 'TH0101000000DA', '0101000000DA', 'P0101000000D1', 'PA101000000DA', 'P01010000000DAB', `P${'0'.repeat(70)}A`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFlashExpressPhNumber('p 0101-000000-da')).toBe(DELIVERED);
    // The shorter form, six letters and digits before the final letter.
    expect(normalizeFlashExpressPhNumber('P010100000DA')).toBe('P010100000DA');
  });

  it('sends a read that failed to reach the service once more', async () => {
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

  it('routes a number filed under Flash Express Philippines to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'flash-express-ph' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'flash-express-ph', source: 'flash-express-ph', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === FLASH_EXPRESS_PH_API)).toBe(true);
  });
});

describe('Flash Express Philippines status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      // The summary's numeric states, which the result reads from the parcel's state.
      if (entry.code && /^\d+$/.test(entry.code)) continue;
      const answer = statusMapAnswer({ carrier: 'flash-express-ph', providerCode: entry.code ?? null, description: entry.wording });
      if (entry.unmapped) {
        expect(flashExpressPhStage(entry.code ?? '', entry.wording), entry.wording).toBeNull();
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(flashExpressPhStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'flash-express-ph', providerCode: 'DELIVERY_CONFIRM', description: 'Your parcel has been delivered.' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'flash-express-ph', providerCode: 'DELIVERY_CONFIRM', description: 'Package delivered to seller' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'flash-express-ph', providerCode: 'SYNTHETIC_SCAN', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // The Thai network's codes and gaps hold here too.
    expect(flashExpressPhStage('SYSTEM_AUTO_RETURN', 'Picked up by courier at SMP_SP.')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(flashExpressPhStage('PHONE', 'Delivered')).toBeNull();
    expect(flashExpressPhStage('SYNTHETIC_SCAN', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
  });
});
