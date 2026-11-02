import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { adapter, TOPYOU_API, TopyouTracker } from './adapter.js';
import { normalizeTopyouNumber, parseTopyou } from './parser.js';
import { statusMap, topyouStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'TYZRZ0000000001YQ';
const IN_TRANSIT = 'TYZRZ0000000002YQ';
const UNKNOWN = 'TYZRZ0000000009YQ';

type Row = Record<string, unknown>;
type Track = Row & { trackInfo: Row[] | null };
type Reply = Row & { data: Row & { tracks: Track[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (track: Track, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.tracks[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
// Each scan's instant, or its wall clock where it has none, with its code and stage.
const scans = (result: CarrierResult) => result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage]);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TopYou HTTP adapter', () => {
  it('posts the whole waybill in capitals to the tracker’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TopyouTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tyzrz 0000-0000-02 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TOPYOU_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ ids: [IN_TRANSIT] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'topyou', step: 'direct', outcome: 'ok' }));
  });

  it('lists the scans newest first, with TopYou’s offsets and the delivery carrier’s wall clocks', () => {
    const result = parseTopyou(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Package delivered by U.S. Postal Service to addressee', last_update: null,
      last_update_local: '2026-03-11T13:02:00', weight_kg: 0.65, destination_country: 'US', delivery_tracking_number: '00000000000000000001' });
    // TopYou's code names its own line, not the carrier that delivered.
    expect(result).not.toHaveProperty('delivery_carrier');
    // The repeated USPS acceptance is kept once.
    expect(scans(result)).toEqual([
      ['2026-03-11T13:02:00', '30', 'delivered'],
      ['2026-03-11T07:35:00', '15', 'out_for_delivery'],
      ['2026-03-11T04:20:00', '15', 'in_transit'],
      ['2026-03-09T18:05:00', '15', 'in_transit'],
      ['2026-03-06T10:48:09+08:00', '20', 'in_transit'],
      ['2026-03-05T19:02:31+08:00', '15', 'in_transit'],
      ['2026-03-05T01:30:00+08:00', '15', 'in_transit'],
      ['2026-03-04T06:12:44+08:00', '15', 'in_transit'],
      ['2026-03-02T21:40:05+08:00', '10', 'in_transit'],
      ['2026-03-02T09:15:20+08:00', '5', 'accepted'],
    ]);
    expect(result.events!.every((event) => !(event.time && event.local_time))).toBe(true);
    // TopYou's own scans name the destination country, even at the origin airport; the delivery carrier's keep their place.
    expect(result.events!.map((event) => event.location ?? null)).toEqual([...Array(3).fill('EXAMPLEVILLE, FL, US'),
      'SAMPLE CITY CA DISTRIBUTION CEN, US', ...Array(6).fill(null)]);
    // Wording loses the trailing space and the preposition whose country the tracker left empty.
    expect(result.events!.map((event) => event.description).slice(4, 6)).toEqual(['Departed from customs', 'Arrived at destination airport']);
  });

  it('reads the delivery carrier’s scans stated at a European offset on UTC wall clocks, and the hand-over to it as transit', () => {
    // GOFO dates its arrival at a French sorting centre 06:23:17+01:00; TopYou relays it as 05:23:17 "+01:00".
    const result = parseTopyou(fixture('relayed-europe'), 'TYZRZ0000000003YQ');
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-10-30T18:54:09Z',
      destination_country: 'FR', delivery_tracking_number: 'GFFR0000000000000001' });
    expect(scans(result).slice(0, 7)).toEqual([
      ['2026-10-30T18:54:09Z', '20', 'out_for_delivery'],
      ['2026-10-30T11:58:12Z', '20', 'in_transit'],
      ['2026-10-30T05:23:17Z', '20', 'in_transit'],
      ['2026-10-29T18:18:07Z', '20', 'in_transit'],
      // GOFO's first sorting scan, days before its delivery round.
      ['2026-10-28T18:41:08Z', '20', 'in_transit'],
      ['2026-10-28T16:28:50', '20', 'in_transit'],
      ['2026-10-26T21:26:40+08:00', '20', 'customs'],
    ]);
  });

  it('maps the wording of a line a post delivers, the warehouse’s outbound scan with the post’s number included', () => {
    const result = parseTopyou(fixture('post-line'), 'TYZRZ0000000004YQ');
    expect(result).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map',
      destination_country: 'AT', delivery_tracking_number: 'LM000000005CN' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['20', 'in_transit', 'carrier_map'],
      ...Array.from({ length: 7 }, () => ['15', 'in_transit', 'carrier_map']),
      ['10', 'in_transit', 'carrier_map'],
      ['5', 'accepted', 'carrier_map'],
      ['5', 'accepted', 'carrier_map'],
    ]);
    expect(result.events!.at(-3)!.description).toBe('Outbound in sorting center , Lastmile Number:LM000000005CN');
    expect(topyouStage('10', 'Outbound in sorting center, Lastmile Number:LM000000006CN')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });

  it('keeps a relayed scan’s place that is only a country, and leaves it out of TopYou’s own', () => {
    const relayed = changed('relayed-europe', (track) => {
      for (const row of track.trackInfo!) row.location = 'FR';
    });
    const places = new Map(parseTopyou(relayed, 'TYZRZ0000000003YQ').events!.map((event) => [event.time ?? event.local_time, event.location ?? null]));
    expect(places.get('2026-10-30T05:23:17Z')).toBe('FR');
    expect(places.get('2026-10-26T21:26:40+08:00')).toBeNull();
  });

  it('reads iMile’s scans it relays stated +08:00 on UTC wall clocks, and TopYou’s own on China’s', () => {
    // iMile dates its delivery round 07:19:36+01:00; TopYou relays it as 06:19:36 "+08:00".
    const relayed = changed('in-transit', (track) => {
      const last = track.trackInfo!.at(-1)!;
      track.trackInfo!.push(
        { ...last, id: '900005', changeDate: '2026/04/17 18:00:00', location: null, record: 'Shipment arrived in the destination country', status: '20' },
        { ...last, id: '900006', changeDate: '2026/04/18 06:18:31', location: null, record: 'Delivery, Your order has assigned delivery drvier.', status: '20' },
        { ...last, id: '900007', changeDate: '2026/04/18 06:19:36', location: null, record: 'Delivery, Our delivery associate is out for delivery.', status: '20' },
      );
    });
    expect(scans(parseTopyou(relayed, IN_TRANSIT)).slice(0, 3)).toEqual([
      ['2026-04-18T06:19:36Z', '20', 'out_for_delivery'],
      ['2026-04-18T06:18:31Z', '20', 'in_transit'],
      ['2026-04-17T18:00:00+08:00', '20', 'in_transit'],
    ]);
  });

  it('reads a newest-first reply the same, and dates a delivery TopYou scans itself', () => {
    const newestFirst = changed('delivered', (track) => { track.trackInfo!.reverse(); });
    expect(parseTopyou(newestFirst, DELIVERED)).toEqual(parseTopyou(fixture('delivered'), DELIVERED));
    const own = changed('in-transit', (track) => {
      track.status = 30;
      track.trackInfo!.push({ ...track.trackInfo!.at(-1)!, changeDate: '2026/04/20 15:00:00', record: 'Signed for ', status: '30', location: null });
    });
    expect(parseTopyou(own, IN_TRANSIT)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-04-20T15:00:00+08:00',
      last_update: '2026-04-20T15:00:00+08:00' });
  });

  it('stages customs by its code and lets the summary settle a return', () => {
    const result = parseTopyou(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_update: '2026-04-17T08:14:02+08:00',
      weight_kg: 1.2, destination_country: 'GB' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    // A place that is a country only is left out of TopYou's scans.
    expect(result.events!.every((event) => !event.location)).toBe(true);
    expect(parseTopyou(changed('in-transit', (track) => { track.status = 40; }), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    // A destination the reply names in words that are no country is kept as its name.
    expect(parseTopyou(changed('in-transit', (track) => { track.dCountry = 'Sample Isles'; }), IN_TRANSIT))
      .toMatchObject({ destination_country_name: 'Sample Isles' });
  });

  it('reads the tracker’s own "not found", an announced order and an order without tracking as such', () => {
    expect(() => parseTopyou(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTopyou(changed('not-found', (track) => { track.trackInfo = []; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTopyou(fixture('announced'), IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseTopyou(changed('in-transit', (track) => { track.success = 'false'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('does not take a reply for another number, a failed lookup or a changed reply for a parcel', () => {
    const indeterminate = expect.objectContaining({ kind: 'indeterminate' });
    const schema = expect.objectContaining({ kind: 'schema' });
    expect(() => parseTopyou(fixture('delivered'), IN_TRANSIT)).toThrow(indeterminate);
    expect(() => parseTopyou(changed('delivered', (_track, body) => { body.success = false; }), DELIVERED)).toThrow(indeterminate);
    expect(() => parseTopyou(changed('delivered', (_track, body) => { body.data.success = 'false'; }), DELIVERED)).toThrow(indeterminate);
    expect(() => parseTopyou(changed('delivered', (_track, body) => { body.data.tracks = []; }), DELIVERED)).toThrow(schema);
    expect(() => parseTopyou({ data: null }, DELIVERED)).toThrow(schema);
    for (const change of [
      (track: Track) => { track.trackInfo = 'scans' as never; },
      (track: Track) => { track.trackInfo![0]!.changeDate = '2026-03-02 09:15:20'; },
      (track: Track) => { track.trackInfo![0]!.changeDate = '2026/02/30 09:15:20'; },
      (track: Track) => { track.trackInfo![0]!.changeDate = '2026/03/02 24:00:00'; },
      (track: Track) => { track.trackInfo![0]!.timeZone = 'Asia/Shanghai'; },
      (track: Track) => { track.trackInfo![0]!.record = ' '; },
      (track: Track) => { track.trackInfo![0]!.location = 7; },
      (track: Track) => { track.trackInfo = Array(501).fill(track.trackInfo![0]); },
    ]) {
      expect(() => parseTopyou(changed('delivered', change), DELIVERED)).toThrow(schema);
    }
  });

  it('reads a browser check as a challenge and other pages as a changed reply', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init)))
      .track({ number: DELIVERED });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>TopYou</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://track.szty56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known waybill and the unknown-number answer, and asks nothing for a number TopYou does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('in-transit')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-17T00:14:02.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('TYZR00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers TopYou does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TYZRZ000000001YQ', 'TYZR00000000001YQ', 'TYZRZ0000000001YX', '00000000000000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTopyouNumber('tyzrz 0000-0000-01 yq')).toBe(DELIVERED);
  });

  it('routes a waybill filed under TopYou, or detected as one, to the adapter, which dates the delivery carrier’s clocks by place', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED, carrier: 'topyou' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'topyou', source: 'topyou', result: { current_stage: 'delivered' } });
    // Florida keeps Eastern daylight time from 8 March 2026.
    expect(answer.result.events[0]).toMatchObject({ time: '2026-03-11T13:02:00-04:00' });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'topyou', source: 'topyou' });
    expect(fetcher.mock.calls.every(([url]) => String(url) === TOPYOU_API)).toBe(true);
  });

  it('claims its waybills only', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'topyou', confidence: 'high' });
    for (const number of ['TYZRZ000000001YQ', 'TYZR00000000001YQ', 'TYZRZ0000000001YX']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('topyou');
    }
  });
});

describe('TopYou status vocabulary', () => {
  it('stages every wording in its map, with its code, the way the app asks', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      // The scan comes from TopYou's map, which the sync files as mapped, not from the shared rules.
      expect(topyouStage(entry.code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'topyou', providerCode: entry.code, description: entry.wording }))
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('stages iMile’s sentences it relays after iMile’s step label by iMile’s map, and leaves other labels to the shared rules', () => {
    const relayed = (wording: string) => topyouStage('20', wording);
    expect(relayed('Delivery, Your order has arrived at 【Sample DS】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(relayed('In Transit, Your order has been shipped from 【Sample DC】.')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // A driver's reason is a failed attempt on the delivery run and a delay before it, as on iMile's own tracker.
    expect(relayed('Delivery, Traffic, strike, bad weather')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(relayed('In Transit, Traffic, strike, bad weather')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // A stock count moves nothing: no stage, and the app hears why.
    expect(relayed('Delivery, Inventory count scan')).toBeNull();
    expect(statusMap.gapNote?.('20', 'delivery, inventory count scan')).toMatch(/moves nothing/);
    // A sentence iMile's map does not know, or another carrier's label, goes on to the shared rules.
    expect(relayed('In Transit, Synthetic note')?.source).not.toBe('carrier_map');
    expect(topyouStage('15', 'In Transit, Arriving On Time')?.source).not.toBe('carrier_map');
    expect(relayed('Shipment, Your order has arrived at 【Sample DS】')?.source).not.toBe('carrier_map');
  });

  it('lets a delivered or returned code settle a scan, then the shared rules, then the code', () => {
    expect(topyouStage('30', 'Synthetic note')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(topyouStage('40', 'Out for delivery')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(topyouStage('15', 'Out for delivery, Out for delivery with the U.S. Postal Service'))
      .toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(topyouStage('25', 'Synthetic note')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(topyouStage('99', 'Synthetic note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'topyou', providerCode: '99', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
