import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SEVENTEENFEIA_API, SeventeenFeiaTracker } from './adapter.js';
import { normalizeSeventeenFeiaNumber, parseSeventeenFeia, SEVENTEENFEIA_PARTNERS } from './parser.js';
import { seventeenFeiaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const WAREHOUSE = 'FEISH9900000001YQ';
const RELAYED = 'FEISZ9900000002YQ';
const FEDEX = 'FEISZ9900000003YQ';
const UNKNOWN = 'FEISH9999999999ZZ';
const LATER = Date.parse('2026-04-01T00:00:00Z');
const READ = Date.parse('2026-05-01T00:00:00Z');

type Row = Record<string, unknown>;
type Envelope = { flag: boolean; msg: unknown; code: unknown; obj: Row & { currentOrderTrackInfos: Row[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Envelope;
const changed = (name: string, change: (order: Envelope['obj'], envelope: Envelope) => void) => {
  const envelope = fixture(name);
  change(envelope.obj, envelope);
  return envelope;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('17FEIA numbers', () => {
  it('claims FEI, two letters, ten digits and YQ, and only suggests 17FEIA for other final letters, which recognition asks it about', () => {
    expect(detectCarrierMatch(WAREHOUSE)).toMatchObject({ carrier: '17feia', confidence: 'high' });
    expect(detectCarrierMatch(UNKNOWN)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['17feia'] });
    expect(recognitionAskedCarriers(UNKNOWN)).toContain('17feia');
    expect(normalizeSeventeenFeiaNumber(UNKNOWN)).toBe(UNKNOWN);
    for (const number of ['FEISH999999999ZZ', 'FEISH99999999999ZZ', 'FEISH9999999999Z', 'FESH9999999999ZZ']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('17feia');
    }
  });
});

describe('17FEIA HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('dpd-at-warehouse')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SeventeenFeiaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' feish-9900-0000-01yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SEVENTEENFEIA_API}${WAREHOUSE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: '17feia', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the warehouse’s rows and steps in China on Beijing time', () => {
    const result = parseSeventeenFeia(fixture('dpd-at-warehouse'), WAREHOUSE, LATER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Order Confirmed.', last_update: '2026-02-05T10:41:07+08:00', expected_delivery: null,
      delivery_carrier: 'dpd-de', delivery_tracking_number: '09990000000017', destination_country: 'DE' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code ?? null, event.stage, event.location ?? null])).toEqual([
      ['2026-02-05T10:41:07+08:00', '订单已确认', 'accepted', 'Haiport'],
      ['2026-02-04T21:58:30+08:00', '订单待客户确认', 'accepted', 'Haiport'],
      ['2026-02-04T16:12:44+08:00', '仓库收货', 'accepted', 'Haiport, CN'],
      // On its way to the warehouse, which does not have it yet: the order data's clock twelve hours on.
      ['2026-02-03T08:27:19+08:00', '包裹在去设施路上', 'registered', null],
      ['2026-02-02T20:27:18+08:00', null, 'registered', 'Haiport, CN'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/0000000000000000000000000000000|1\.2|上海/);
  });

  it('dates the warehouse’s receipt on Beijing time without its country or offset', () => {
    const result = parseSeventeenFeia(changed('dpd-at-warehouse', (order) => {
      const receipt = order.currentOrderTrackInfos.find((row) => row.status === '仓库收货')!;
      Object.assign(receipt, { country: '', timeZone: '' });
    }), WAREHOUSE, LATER);
    expect(result.events!.find((event) => event.provider_code === '仓库收货')).toMatchObject({ time: '2026-02-04T16:12:44+08:00' });
  });

  it('dates DHL’s relayed scans on Germany’s clock, keeps the flight’s and customs’ milestones local and drops the estimate', () => {
    const result = parseSeventeenFeia(fixture('dhl-relayed'), RELAYED, LATER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_update: '2026-03-19T21:37:00+01:00', delivery_carrier: 'dhl', delivery_tracking_number: 'CE000000014DE', destination_country: 'FR' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code ?? null, event.stage, event.location ?? null])).toEqual([
      ['2026-03-19T21:37:00+01:00', '运输途中', 'in_transit', 'Sampleburg, DE'],
      ['2026-03-19T06:14:00+01:00', '运输途中', 'in_transit', 'Exampledorf, DE'],
      // The flight's and customs' milestones carry a destination's offset without a country: their clocks stay as written.
      ['2026-03-17T13:03:00', '清关完成', 'in_transit', null],
      ['2026-03-17T08:49:00', '清关中', 'customs', null],
      ['2026-03-16T22:31:00', '清关行提货到仓', 'customs', null],
      ['2026-03-16T14:05:00', '航班抵达清关港', 'in_transit', null],
      ['2026-03-15T04:45:00', '航班在中转地起飞', 'in_transit', null],
      ['2026-03-14T11:20:00', '航班到达中转地', 'in_transit', null],
      ['2026-03-14T03:35:00', '航班已起飞', 'in_transit', null],
      // The steps at the warehouse in China are on Beijing time, whatever offset they carry.
      ['2026-03-12T10:01:33+08:00', '出口报关中', 'customs', null],
      ['2026-03-11T19:00:00+08:00', '订单已出库', 'in_transit', null],
      ['2026-03-09T15:22:08+08:00', '订单已确认', 'accepted', 'Bayside'],
      ['2026-03-08T11:47:52+08:00', '仓库收货', 'accepted', 'Bayside, CN'],
      ['2026-03-07T07:30:41+08:00', '包裹在去设施路上', 'registered', null],
      ['2026-03-06T19:30:40+08:00', null, 'registered', 'Bayside, CN'],
    ]);
    expect(result.events!.some((event) => /estimated/i.test(event.description ?? ''))).toBe(false);
  });

  it('reads the hand-in at the partner’s depot as transit, on its wall clock', () => {
    const result = parseSeventeenFeia(changed('dhl-relayed', (order) => {
      const milestones = order.currentOrderTrackInfos.filter((row) => row.status !== '运输途中');
      order.currentOrderTrackInfos = [{ ...milestones[0]!, createTime: '2026-03-19 13:03:00', status: '已交仓，等待上网',
        statusI18n: '已交仓，等待上网', description: 'Arrived at delivery hub，Awaiting carrie scan.', timeZone: '' }, ...milestones];
    }), RELAYED, LATER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-03-19T13:03:00' });
    expect(result.events![0]).toMatchObject({ local_time: '2026-03-19T13:03:00', provider_code: '已交仓，等待上网', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: '17feia', providerCode: '已交仓，等待上网', description: 'Arrived at delivery hub，Awaiting carrie scan.' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it('keeps a wall clock whose offset its country does not have then', () => {
    const result = parseSeventeenFeia(changed('dhl-relayed', (order) => {
      order.currentOrderTrackInfos[0]!.timeZone = '+02:00';
      order.currentOrderTrackInfos[1]!.country = 'ZZ';
    }), RELAYED, LATER);
    expect(result.events!.slice(0, 2)).toMatchObject([
      { local_time: '2026-03-19T21:37:00', location: 'Sampleburg, DE' },
      { local_time: '2026-03-19T06:14:00' },
    ]);
    expect(result.events![0]!.time).toBeUndefined();
    expect(result.last_update_local).toBe('2026-03-19T21:37:00');
  });

  it('dates FedEx’s relayed scans on their state’s clock, and the delivery with them', () => {
    const result = parseSeventeenFeia(fixture('fedex-relayed'), FEDEX, READ);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Left at front door. Signature Service not requested.',
      last_update: '2026-04-17T10:12:36-04:00', delivered_at: '2026-04-17T10:12:36-04:00',
      delivery_carrier: 'fedex', delivery_tracking_number: '999900000005', destination_country: 'US' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.stage])).toEqual([
      ['2026-04-17T10:12:36-04:00', 'delivered'],
      ['2026-04-17T04:36:00-04:00', 'out_for_delivery'],
      ['2026-04-17T04:24:00-04:00', 'in_transit'],
      // Tennessee keeps two clocks.
      ['2026-04-16T22:43:37', 'in_transit'],
      ['2026-04-16T13:39:00', 'in_transit'],
      ['2026-04-15T09:28:48-05:00', 'in_transit'],
      ['2026-04-14T18:35:00-05:00', 'in_transit'],
      // FedEx's pickup is a day, under another offset than Illinois'.
      ['2026-04-14T00:00:00', 'in_transit'],
      // 17FEIA's milestones carry US Central's standard offset in summer and name no place.
      ['2026-04-13T15:44:00', 'in_transit'],
      ['2026-04-12T21:39:00', 'customs'],
      ['2026-04-12T06:00:00', 'in_transit'],
      ['2026-04-10T09:51:00', 'in_transit'],
      ['2026-04-08T09:26:27+08:00', 'customs'],
      ['2026-04-07T18:00:00+08:00', 'in_transit'],
      ['2026-04-03T17:29:42+08:00', 'accepted'],
      ['2026-04-03T10:56:54+08:00', 'registered'],
    ]);
    // A relayed place that ends with its country keeps it once.
    expect(result.events![0]!.location).toBe('Sampleton, MA, US');
    // A US row's state settles its clock; its postcode and the ids are never read.
    expect(JSON.stringify(result)).not.toMatch(/99999|0{20}/);
  });

  it.each(['TN', 'IN', 'FL', 'KY', 'ND', 'SD', 'NE', 'KS', 'TX', 'OR', 'ID'])('keeps the wall clock of a scan in %s, whose places keep two clocks', (state) => {
    const result = parseSeventeenFeia(changed('fedex-relayed', (order) => { order.currentOrderTrackInfos[0]!.state = state; }), FEDEX, READ);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-04-17T10:12:36' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events![0]!.time).toBeUndefined();
  });

  it('keeps a US scan whose offset its state lacks then, one at midnight, one without a state and a milestone on China’s offset', () => {
    const result = parseSeventeenFeia(changed('fedex-relayed', (order) => {
      const rows = order.currentOrderTrackInfos;
      // Massachusetts keeps -04:00 in April.
      rows[0]!.timeZone = '-05:00';
      rows[1]!.state = '';
      rows[2]!.state = 'Massachusetts';
      rows[5]!.timeZone = 'CDT';
      // Midnight even under Massachusetts' own offset.
      rows[7]!.state = 'MA';
      // A milestone names no place, whatever its offset.
      rows[8]!.timeZone = '+08:00';
    }), FEDEX, READ);
    expect(result.events!.slice(0, 9).map((event) => event.time ?? null))
      .toEqual([null, null, null, null, null, null, '2026-04-14T18:35:00-05:00', null, null]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-04-17T10:12:36' });
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads a scan without an offset on its place’s clock, and the repeated hour by the row’s own', () => {
    const clock = (createTime: string, timeZone: string, country = 'US', state = 'MA') => parseSeventeenFeia(changed('fedex-relayed',
      (order) => Object.assign(order.currentOrderTrackInfos[0]!, { createTime, timeZone, country, state })), FEDEX, Date.parse('2027-01-01T00:00:00Z'))
      .events![0]!.time ?? null;
    expect(clock('2026-04-17 10:12:36', '')).toBe('2026-04-17T10:12:36-04:00');
    expect(clock('2026-04-17 10:12:36', '', 'DE', '')).toBe('2026-04-17T10:12:36+02:00');
    // A state's code beside another country is not read.
    expect(clock('2026-04-17 10:12:36', '+02:00', 'DE', 'MA')).toBe('2026-04-17T10:12:36+02:00');
    expect(clock('2026-04-17 10:12:36', '-04:00', '', 'MA')).toBeNull();
    // The clocks go back: the row's offset says which of the two hours it means.
    expect(clock('2026-11-01 01:30:00', '-04:00')).toBe('2026-11-01T01:30:00-04:00');
    expect(clock('2026-11-01 01:30:00', '-05:00')).toBe('2026-11-01T01:30:00-05:00');
    expect(clock('2026-11-01 01:30:00', '')).toBe('2026-11-01T01:30:00-04:00');
    // The clocks go forward: that hour never struck there.
    expect(clock('2026-03-08 02:30:00', '-04:00')).toBeNull();
    expect(clock('2026-03-08 02:30:00', '-05:00')).toBeNull();
    expect(clock('2026-03-08 02:30:00', '')).toBeNull();
  });

  it('holds back rows written ahead of their time', () => {
    // Read before the transit hub's arrival, on Beijing time.
    const result = parseSeventeenFeia(fixture('dhl-relayed'), RELAYED, Date.parse('2026-03-14T11:00:00+08:00'));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Flight has departed.', last_update_local: '2026-03-14T03:35:00' });
    expect(result.events).toHaveLength(7);
  });

  it('keeps the stage a parcel had through a delayed flight', () => {
    // Read before the take-off: the delay follows the export declaration.
    const result = parseSeventeenFeia(changed('dhl-relayed', (order) => {
      order.currentOrderTrackInfos.splice(9, 0, { status: '航班延误', description: 'Flight delayed.', createTime: '2026-03-13 09:00:00', timeZone: '+01:00', country: '' });
    }), RELAYED, Date.parse('2026-03-13T20:00:00+08:00'));
    expect(result.events![0]).toMatchObject({ description: 'Flight delayed.', provider_code: '航班延误', stage: 'customs', stage_source: 'none' });
    expect(result).toMatchObject({ current_stage: 'customs', current_stage_source: 'carrier_map', last_status_text: 'Flight delayed.' });
  });

  it('hands over to a partner only through the table, with a number of the partner’s own', () => {
    expect(SEVENTEENFEIA_PARTNERS).toEqual({ 'DPD-DE': 'dpd-de', 'DE-DHL': 'dhl', 'FEDEX-GROUND': 'fedex' });
    const handoff = (company: unknown, number: unknown) => {
      const result = parseSeventeenFeia(changed('dpd-at-warehouse', (order) => Object.assign(order, { deliveryCompany: company, deliveryNumber: number })), WAREHOUSE, LATER);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    // DPD's label adds a check character its tracking does not take.
    expect(handoff('DPD-DE', '0999 0000 0000 17R')).toEqual(['dpd-de', '09990000000017']);
    expect(handoff('DPD-DE', '09990000000017X')).toEqual([null, null]);
    expect(handoff('DE-DHL', 'CE000000014DE')).toEqual(['dhl', 'CE000000014DE']);
    expect(handoff('FEDEX-GROUND', '999900000005')).toEqual(['fedex', '999900000005']);
    expect(handoff('DE-DHL', '09990000000017')).toEqual([null, null]);
    expect(handoff('GLS-DE', '09990000000017')).toEqual([null, null]);
    expect(handoff('toString', '09990000000017')).toEqual([null, null]);
    expect(handoff('DPD-DE', '')).toEqual([null, null]);
    expect(handoff(null, null)).toEqual([null, null]);
  });

  it('names a destination it does not map by its name', () => {
    const result = parseSeventeenFeia(changed('dpd-at-warehouse', (order) => { order.destination = '奥地利'; }), WAREHOUSE, LATER);
    expect(result.destination_country).toBeUndefined();
    expect(result.destination_country_name).toBe('奥地利');
  });

  it('counts an order only when its own number is the one asked', () => {
    // The search also finds an order by its partner's or another forwarder's number.
    expect(() => parseSeventeenFeia(fixture('dpd-at-warehouse'), RELAYED, LATER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSeventeenFeia(changed('dpd-at-warehouse', (order) => { order.insideNumber = null; }), WAREHOUSE, LATER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (order: Envelope['obj']) => { order.currentOrderTrackInfos[0]!.createTime = '2026-02-05 10:41'; },
      (order: Envelope['obj']) => { order.currentOrderTrackInfos[0]!.createTime = '2026-02-30 10:41:07'; },
      (order: Envelope['obj']) => { order.currentOrderTrackInfos[0]!.createTime = '2026-02-05 24:00:00'; },
      (order: Envelope['obj']) => { order.currentOrderTrackInfos[0]!.description = { en: 'Order Confirmed.' }; },
      (order: Envelope['obj']) => { order.currentOrderTrackInfos[0] = 'Order Confirmed.' as never; },
      (order: Envelope['obj']) => { order.currentOrderTrackInfos = {} as never; },
      (order: Envelope['obj']) => { order.currentOrderTrackInfos = Array.from({ length: 501 }, () => order.currentOrderTrackInfos[0]!); },
      (order: Envelope['obj']) => { order.insideNumber = [WAREHOUSE] as never; },
      (_order: Envelope['obj'], envelope: Envelope) => { envelope.obj = WAREHOUSE as never; },
      (_order: Envelope['obj'], envelope: Envelope) => { envelope.flag = 'true' as never; },
    ]) {
      expect(() => parseSeventeenFeia(changed('dpd-at-warehouse', change), WAREHOUSE, LATER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown order, a refused lookup, an order without scans and a browser check apart', async () => {
    const lookup = (body: unknown, number = UNKNOWN, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ ...fixture('not-found'), msg: '系统繁忙' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ ...fixture('not-found'), code: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(changed('dpd-at-warehouse', (order) => { order.currentOrderTrackInfos = []; }), WAREHOUSE)).rejects.toMatchObject({ kind: 'indeterminate' });
    // Only the estimate so far.
    await expect(lookup(changed('dhl-relayed', (order) => { order.currentOrderTrackInfos.splice(0, 9); order.currentOrderTrackInfos.splice(1); }), RELAYED))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=0"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>17FEIA</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', UNKNOWN, { status: 302, headers: { Location: 'https://www.17feia.com/cc.html?u=/public' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', UNKNOWN, { status: 302, headers: { Location: 'https://www.17feia.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The route answers every number: without it, the service moved.
    await expect(lookup('', UNKNOWN, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: WAREHOUSE })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(WAREHOUSE)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known order and the unknown-order answer, and asks nothing for a number 17FEIA does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('dhl-relayed'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(RELAYED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('09990000000017')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers 17FEIA does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['FEISH990000001YQ', 'FEISH99000000011YQ', 'FEISH9900000001Y1', 'FEISH9900000001YQ-1', 'FEXSH9900000001YQ', 'CE000000014DE']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: WAREHOUSE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSeventeenFeiaNumber('feisz 9900.0000.02 yq')).toBe(RELAYED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('dhl-relayed')));
    await expect(carrier(fetcher).track({ number: RELAYED }, { budgetMs: 5000 })).resolves.toMatchObject({ delivery_carrier: 'dhl' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: WAREHOUSE }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an order filed under 17FEIA to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('dpd-at-warehouse')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: WAREHOUSE, carrier: '17feia' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: '17feia', source: '17feia', result: { current_stage: 'accepted', delivery_carrier: 'dpd-de' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${SEVENTEENFEIA_API}${WAREHOUSE}`)).toBe(true);
  });
});

describe('17FEIA status vocabulary', () => {
  it('records every label the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const code = entry.code ?? '';
      const wording = entry.wording ?? '';
      if (entry.stage === undefined) {
        expect(statusMapAnswer({ carrier: '17feia', providerCode: code, description: wording })).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(code || null, wording.toLowerCase())).toBe(entry.stage);
      expect(seventeenFeiaStage(code, wording)?.stage).toBe(entry.stage);
    }
    // A relayed row whose wording no rule reads is the partner carrying the parcel on.
    expect(statusMapAnswer({ carrier: '17feia', providerCode: '运输途中', description: 'Synthetic partner note' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    // The broker's warehouse is not a delivery.
    expect(statusMapAnswer({ carrier: '17feia', providerCode: '清关行提货到仓', description: 'Broker picked up Shipment and delivered to warehouse.' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: '17feia', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
