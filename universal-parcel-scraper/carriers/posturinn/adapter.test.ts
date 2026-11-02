import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTURINN_API, PosturinnTracker } from './adapter.js';
import { normalizePosturinnNumber, parsePosturinn } from './parser.js';
import { isPosturinnHomeScan, posturinnScanStage, posturinnStage, posturinnStatusStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014IS';
const OUTBOUND = 'ZZ000000028IS';
const UNKNOWN = 'ZZ000000031IS';
const INBOUND = 'ZZ000000045PL';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Row = Record<string, unknown> & { location: Record<string, unknown> | null };
type Reply = { shipment: Record<string, unknown> | null; trackingEvents: Row[] | null; allPossibleTrackAndTraces: unknown };
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const rows = (payload: Reply) => payload.trackingEvents!;
const reply = (body: string | null, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Pósturinn tracking adapter', () => {
  it('asks the tracker for the whole code once, in English, as its English page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PosturinnTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 is ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${POSTURINN_API}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'X-Preferred-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posturinn', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic Póstbox delivery newest first, dating every scan in Iceland and keeping a repeated scan once', () => {
    const result = parsePosturinn(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery booked', last_update: '2026-03-05T18:16:13+00:00', expected_delivery: null,
      delivered_at: '2026-03-05T18:16:13+00:00', service_name: 'Postbox', destination_country: 'IS' });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-05T18:16:13+00:00', 'Póstbox Sýnisgötu', 'Delivery booked', 'delivered'],
      ['2026-03-05T18:11:15+00:00', 'Póstbox Sýnisgötu', 'Delivery booked', 'delivered'],
      ['2026-03-05T09:02:11+00:00', 'Póstbox Sýnisgötu', 'Notifcation (Text msg./email)', undefined],
      ['2026-03-04T20:19:34+00:00', 'Póstmiðstöð', 'Scanned - Into container', 'in_transit'],
      ['2026-03-03T14:41:38+00:00', 'Póstmiðstöð', 'Notifcation (Text msg./email)', undefined],
      // A wording the tracker leaves in Icelandic.
      ['2026-03-03T14:35:19+00:00', 'Póstmiðstöð', 'Bið eftir Póstboxi', 'in_transit'],
      ['2026-03-02T16:41:30+00:00', 'Póstmiðstöð', 'Scanned - Into container', 'in_transit'],
      ['2026-03-02T16:20:06+00:00', 'Póstmiðstöð', 'Shipment sorting', 'in_transit'],
      ['2026-03-02T16:20:05+00:00', 'Pósthús Dæmigötu 1', 'Received by Pósturinn', 'accepted'],
      ['2026-03-02T10:15:42+00:00', 'Pósthús Dæmigötu 1', 'Reveived from sender and will be forwarded', 'accepted'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined)).toBe(true);
    expect(result.events![2]).toEqual({ time: '2026-03-05T09:02:11+00:00', location: 'Póstbox Sýnisgötu', description: 'Notifcation (Text msg./email)' });
  });

  it('reads mail from abroad with the sending post’s scans by their own wall clocks, Pósturinn’s dated, and the estimate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound')));
    const result = await carrier(fetcher).track({ number: INBOUND });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Invoice delivered',
      last_update: '2026-05-13T12:18:35+00:00', expected_delivery: '2026-05-16', service_name: 'International Parcel', destination_country: 'IS' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.stage])).toEqual([
      ['2026-05-13T12:18:35+00:00', 'POSTUR.IS', 'customs'],
      ['2026-05-12T14:24:50+00:00', 'Innflutningsdeild', undefined],
      ['2026-05-12T14:10:13+00:00', 'Innflutningsdeild', 'customs'],
      ['2026-05-12T11:04:10+00:00', 'Póstmiðstöð', 'in_transit'],
      ['2026-05-12T10:49:57+00:00', 'ISZZZA', 'in_transit'],
      ['2026-05-06T18:52:00', 'Sample City Poland', 'in_transit'],
      ['2026-05-06T16:52:00', 'Sample City Poland', 'in_transit'],
      ['2026-05-04T16:37:00', 'Poland', 'accepted'],
    ]);
    expect(result.events!.slice(5).every(event => event.time === undefined)).toBe(true);
    // An unknown wording on mail from abroad may be the sending post's, so it keeps its wall clock.
    const unknown = parsePosturinn(edited('inbound', payload => { rows(payload).push({ ...rows(payload)[7]!, description: 'Sample event',
      timestamp: '2026-05-14T08:00:00+00:00' }); }), INBOUND);
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-14T08:00:00', location: 'POSTUR.IS', description: 'Sample event' });
    expect(unknown).toMatchObject({ current_stage: 'customs', last_update: null, last_update_local: '2026-05-14T08:00:00' });
    // The post office's own wordings, on its notices and at collection, are Pósturinn's.
    const office = parsePosturinn(edited('inbound', payload => {
      for (const [description, timestamp] of [['Notice sent from post office', '2026-05-15T09:00:00+00:00'],
        ['At final pick-up point', '2026-05-15T09:01:00+00:00']]) {
        rows(payload).push({ ...rows(payload)[7]!, description, timestamp, location: { ...rows(payload)[7]!.location, name: 'Pósthús Dæmigötu 1' } });
      }
    }), INBOUND);
    expect(office.events!.slice(0, 2).map(event => [event.time, event.stage]))
      .toEqual([['2026-05-15T09:01:00+00:00', 'ready_for_pickup'], ['2026-05-15T09:00:00+00:00', undefined]]);
    expect(office).toMatchObject({ current_stage: 'ready_for_pickup', last_update: '2026-05-15T09:01:00+00:00' });
  });

  it('keeps every scan of an item leaving Iceland as a wall clock, and no destination', () => {
    const result = parsePosturinn(edited('delivered', payload => {
      Object.assign(payload.shipment!, { id: OUTBOUND, status: 'PreTransit', statusMessage: 'Expected from sender', isDomestic: false,
        direction: 'Outbound', estimatedDeliveryDateMessage: 'Sending fannst ekki.', labels: [{ locale: 'EN', title: 'International Parcel' }] });
      payload.trackingEvents = [{ ...rows(payload)[0]!, description: 'Expected from sender', location: { ...rows(payload)[0]!.location, name: '' } }];
    }), OUTBOUND);
    expect(result).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Expected from sender', last_update: null, last_update_local: '2026-03-02T10:15:42', expected_delivery: null,
      service_name: 'International Parcel', events: [{ local_time: '2026-03-02T10:15:42', description: 'Expected from sender',
        stage: 'registered', stage_source: 'carrier_map' }] });
  });

  it('lets the shipment’s status settle a parcel waiting for collection or delivered, unless the scans reached a delivery', () => {
    const waiting = parsePosturinn(edited('delivered', payload => {
      payload.shipment!.status = 'AvailableForPickupAtPostBox';
      payload.trackingEvents = rows(payload).slice(0, 9);
    }), DELIVERED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Notifcation (Text msg./email)' });
    expect(waiting).not.toHaveProperty('delivered_at');
    const worded = parsePosturinn(edited('delivered', payload => { rows(payload).splice(9, 2, { ...rows(payload)[9]!, description: 'Sample handover' }); }), DELIVERED);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(worded).not.toHaveProperty('delivered_at');
    const stale = parsePosturinn(edited('delivered', payload => { payload.shipment!.status = 'AvailableForPickup'; }), DELIVERED);
    expect(stale).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-05T18:16:13+00:00' });
    const trailing = parsePosturinn(edited('inbound', payload => { payload.shipment!.status = 'InTransit'; }), INBOUND);
    expect(trailing).toMatchObject({ current_stage: 'customs' });
  });

  it('reads only the rows the page ticks off, either way round, and the estimate only for a parcel on its way', () => {
    const planned = parsePosturinn(edited('inbound', payload => {
      rows(payload).push({ ...rows(payload)[7]!, chronologicalType: 'Future', description: 'Delivered', timestamp: '0001-01-01T00:00:00+00:00' },
        { ...rows(payload)[7]!, chronologicalType: 'Current', description: 'Ready for delivery' });
    }), INBOUND);
    expect(planned.events).toHaveLength(8);
    const reversed = parsePosturinn(edited('inbound', payload => { payload.trackingEvents = rows(payload).reverse(); }), INBOUND);
    expect(reversed.events).toEqual(parsePosturinn(fixture('inbound'), INBOUND).events);
    for (const change of [{ estimatedNumberOfDaysUntilDelivery: '0.000' }, { estimatedNumberOfDaysUntilDelivery: null },
      { estimatedDeliveryDateMessage: 'Sending verður líklega tilbúin til afhendingar í dag.' },
      { estimatedDeliveryDateMessage: 'Sample 16.05.2026 or 17.05.2026' }, { estimatedDeliveryDateMessage: 'Sample 31.02.2026' }]) {
      expect(parsePosturinn(edited('inbound', payload => { Object.assign(payload.shipment!, change); }), INBOUND).expected_delivery,
        JSON.stringify(change)).toBeNull();
    }
    expect(() => parsePosturinn(edited('inbound', payload => { for (const row of rows(payload)) row.chronologicalType = 'Future'; }), INBOUND))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePosturinn(edited('inbound', payload => { payload.trackingEvents = null; }), INBOUND))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the tracker’s empty answer as missing and its refusal as invalid input', async () => {
    const lookup = (body: string | null, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(null, 204)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('invalid'), 400)).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('{"errorType":"Sample","message":"Sample"}', 400)).rejects.toMatchObject({ kind: 'schema', status: 400 });
    await expect(lookup('<html></html>', 400, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered').replaceAll(DELIVERED, UNKNOWN)}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parsePosturinn(fixture('delivered'), 'ZZ000000045IS'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Pósturinn answered for a different item' }));
    expect(parsePosturinn(edited('delivered', payload => { payload.shipment!.id = DELIVERED.toLowerCase(); }), DELIVERED).events).toHaveLength(10);
    expect(() => parsePosturinn(edited('delivered', payload => { payload.shipment = null; payload.allPossibleTrackAndTraces = [fixture('inbound')]; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(() => parsePosturinn(edited('delivered', payload => { payload.shipment = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const payload of [[], null, 'sample', { shipment: [] },
      edited('delivered', reply => { delete reply.shipment!.id; }),
      edited('delivered', reply => { reply.shipment!.id = 7; }),
      edited('delivered', reply => { reply.shipment!.id = { id: DELIVERED }; }),
      edited('delivered', reply => { reply.shipment!.status = ['Delivered']; }),
      edited('delivered', reply => { reply.shipment!.direction = 1; }),
      edited('delivered', reply => { (reply as Record<string, unknown>).trackingEvents = {}; }),
      edited('delivered', reply => { (rows(reply) as unknown[])[1] = 'scan'; }),
      edited('delivered', reply => { delete rows(reply)[1]!.chronologicalType; }),
      edited('delivered', reply => { rows(reply)[1]!.description = ' '; }),
      edited('delivered', reply => { rows(reply)[1]!.description = ['Delivery booked']; }),
      edited('delivered', reply => { rows(reply)[1]!.timestamp = '02.03.2026 16:20'; }),
      edited('delivered', reply => { rows(reply)[1]!.timestamp = '2026-03-02T16:20:05'; }),
      edited('delivered', reply => { rows(reply)[1]!.timestamp = '2026-02-30T16:20:05+00:00'; }),
      edited('delivered', reply => { rows(reply)[1]!.timestamp = '2026-03-02T24:00:00+00:00'; }),
      edited('delivered', reply => { rows(reply)[1]!.timestamp = 1772468405; }),
      edited('delivered', reply => { (rows(reply)[1] as Record<string, unknown>).location = 'Póstmiðstöð'; }),
      edited('delivered', reply => { rows(reply)[1]!.location!.name = 7; }),
      edited('delivered', reply => { reply.trackingEvents = Array.from({ length: 501 }, () => rows(reply)[0]!); })]) {
      expect(() => parsePosturinn(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A scan without a place, and labels that are not the page's, are read without them.
    const bare = parsePosturinn(edited('delivered', reply => { rows(reply)[10]!.location = null; reply.shipment!.labels = 'Postbox'; }), DELIVERED);
    expect(bare.events![0]).not.toHaveProperty('location');
    expect(bare).not.toHaveProperty('service_name');
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015IS', 'ZZ00000001IS', 'ZZ000000014ISX', 'Z0000000014IS', '1234567890123', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePosturinnNumber(' zz-000-000-045 pl ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(null, 204));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T18:16:13.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Pósturinn to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'posturinn' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'posturinn', source: 'posturinn', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${POSTURINN_API}${DELIVERED}`)).toBe(true);
  });

  it('is asked about Icelandic S10 codes, which detection leaves with the postal fallback', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('posturinn');
    expect(recognitionAskedCarriers('ZZ000000015IS')).not.toContain('posturinn');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('posturinn');
    for (const link of [`https://posturinn.is/einstaklingar/mottaka/fylgstu-med-sendingunni-thinni/?q=${DELIVERED}`,
      `https://www.posturinn.is/en/individuals/receiving/track-your-shipment/?q=${DELIVERED}`,
      `https://posturinn.is/einstaklingar/mottaka/finna-sendingu/?TrackingNumber=${DELIVERED}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'posturinn', source: 'link' });
    }
  });
});

type Entry = { code?: string; wording: string; stage?: string; unmapped?: boolean; confirmedBy: string };

describe('Pósturinn status vocabulary', () => {
  it('maps every scan wording it recorded to the stage recorded for it, and the statuses that settle a stage', () => {
    for (const entry of statuses.entries as Entry[]) {
      const stage = entry.unmapped ? undefined : entry.stage;
      if (entry.code) {
        // The shipment's status, not a scan.
        expect(posturinnStatusStage(entry.code), entry.code).toBe(stage);
        continue;
      }
      // The progress rail's labels come from the page's script, not from the reply.
      if (entry.confirmedBy === 'official-doc') continue;
      expect(posturinnScanStage(entry.wording) ?? undefined, entry.wording).toBe(stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'posturinn', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : expect.objectContaining({ kind: 'intentional_gap' }));
    }
    expect(posturinnStage(' delivery   BOOKED ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(posturinnStage('Notifcation (Text msg./email)')).toBeNull();
    expect(posturinnStage('Out for delivery')).toEqual({ stage: 'out_for_delivery', source: expect.stringMatching(/^wording:/) });
    expect(posturinnStage('Sample event')).toBeNull();
    for (const wording of ['constructor', 'toString', 'Delivery', 'Sample event']) expect(posturinnScanStage(wording), wording).toBeUndefined();
    expect(isPosturinnHomeScan('Arrived at post office')).toBe(true);
    expect(isPosturinnHomeScan('Departed from sorting center abroad')).toBe(false);
    expect(isPosturinnHomeScan('Sample event')).toBe(false);
    expect(posturinnStatusStage('InTransit')).toBeUndefined();
    expect(statusMap.stage('Delivered', 'delivery booked')).toBeUndefined();
  });
});
