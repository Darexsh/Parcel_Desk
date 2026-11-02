import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, slovenskaPostaUrl, SlovenskaPostaTracker } from './adapter.js';
import { parseSlovenskaPosta } from './parser.js';
import { slovenskaPostaCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = 'RR900000019SK';
const ABROAD = 'CE900000022SK';
const RETURNED = 'EE900000036SK';
const RETAINED = 'RR900000040SK';
const NOT_POSTED = 'RR900000053SK';
const UNKNOWN = 'ZZ000000014SK';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string) => text(`${name}.json`);
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Parcel { barcode?: string; query?: string; error?: string; events?: Record<string, unknown>[]; state?: Record<string, unknown>; [key: string]: unknown }
interface Payload { parcels: Parcel[] }
const edited = (name: string, change: (parcel: Parcel, payload: Payload) => void = () => {}): Payload => {
  const payload = JSON.parse(json(name)) as Payload;
  change(payload.parcels[0]!, payload);
  return payload;
};
const rows = (result: ReturnType<typeof parseSlovenskaPosta>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);
const at = (wall: string) => Date.parse(`${wall}Z`);

describe('Slovenská pošta tracking adapter', () => {
  it('asks the tracking page’s service for the whole number once and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(json('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SlovenskaPostaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rr 900 000 019 sk ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.posta.sk/private/web/track?q=${COLLECTED}&mmpc=1`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'slovenska-posta', step: 'direct', outcome: 'ok' }));
  });

  it('dates a domestic item on Bratislava’s clock and names the post office it was collected from', () => {
    const result = parseSlovenskaPosta(JSON.parse(json('collected')), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Picked up', last_update: '2026-03-05T15:42:10+01:00', delivered_at: '2026-03-05T15:42:10+01:00',
      expected_delivery: null, pickup_point: 'Pošta Príkladná Ves 2', weight_kg: 0.02 });
    expect(result.last_update_local).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-03-05T15:42:10+01:00', 'OKP', 'delivered', 'Pošta Príkladná Ves 2'],
      ['2026-03-04T11:05:31+01:00', 'ZNP1AN', 'ready_for_pickup', 'Pošta Príkladná Ves 2'],
      ['2026-03-04T08:12:44+01:00', 'VDOOK', 'out_for_delivery', 'Pošta Príkladná Ves 2'],
      ['2026-03-03T21:30:02+01:00', 'VDOIO', 'in_transit', null],
      ['2026-03-03T16:05:19+01:00', 'PODOD', 'accepted', 'Pošta Vzorovo 1'],
    ]);
    expect(result.events!.every(event => !('local_time' in event))).toBe(true);
    const kept = JSON.stringify(result);
    for (const dropped of ['Vzorová', '99999', '0900000000', '48.9999', '999902', 'príkladnáves2', 'Vyzdvihnutá']) {
      expect(kept, dropped).not.toContain(dropped);
    }
    // Brought to the door, an item has no pickup point.
    const door = parseSlovenskaPosta(edited('collected', parcel => {
      parcel.events!.splice(0, 2, { ...parcel.events![0]!, type: 'OK', desc: { en: 'Delivered to addressee', sk: 'Doručená' } });
    }), COLLECTED);
    expect(door).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-05T15:42:10+01:00' });
    expect(door.pickup_point).toBeUndefined();
    // While it waits at the office, the office is its pickup point.
    const waiting = parseSlovenskaPosta(edited('collected', parcel => { parcel.events!.shift(); }), COLLECTED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Pošta Príkladná Ves 2' });
  });

  it('puts a scan abroad on its country’s clock, names the country and fills the branch into older wordings', () => {
    const result = parseSlovenskaPosta(JSON.parse(json('abroad')), ABROAD);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered to addressee',
      last_update: '2026-07-06T10:20:00+02:00', delivered_at: '2026-07-06T10:20:00+02:00', destination_country: 'DE', weight_kg: 1.25 });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-07-06T10:20:00+02:00', 'IPS_EMI_THERE', 'delivered', 'Germany'],
      ['2026-07-06T07:45:00+02:00', 'IPS_EDG_THERE', 'out_for_delivery', 'Germany'],
      ['2026-07-03T22:10:00+02:00', 'IPS_EMF', 'in_transit', 'Germany'],
      ['2026-07-03T18:02:00+02:00', 'IPS_EMD_THERE', 'in_transit', 'Germany'],
      ['2026-07-02T03:15:00+02:00', 'IPS_EMC_THERE', 'in_transit', null],
      ['2026-07-01T19:40:12+02:00', 'VDOIO', 'in_transit', null],
      ['2026-07-01T14:06:55+02:00', 'PODOD', 'accepted', 'Pošta Vzorovo 1'],
    ]);
    expect(result.events!.at(-1)!.description).toBe('Posted Pošta Vzorovo 1');
    // Another clock: the scan keeps Tokyo's offset.
    const japan = parseSlovenskaPosta(edited('abroad', parcel => { parcel.events![0]!.on = { country: 'JP' }; }), ABROAD);
    expect(japan.events![0]).toMatchObject({ time: '2026-07-06T10:20:00+09:00', location: 'Japan' });
  });

  it('keeps the wall clock of a country with several clocks, or of none, and reads a return to the sender', () => {
    const result = parseSlovenskaPosta(JSON.parse(json('returned')), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-05-15T13:30:00', weight_kg: 0.4 });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.destination_country).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-05-15T13:30:00', 'IPS_EMI_BACK', 'returned', 'United States'],
      ['2026-05-04T09:10:00+02:00', 'IPS_EMC_BACK', 'in_transit', null],
      ['2026-05-03T12:00:00+02:00', 'VYSVR', 'in_transit', null],
      ['2026-05-02T08:01:00+02:00', 'P-NOL', 'exception', 'Pošta Príkladná Ves 2'],
      ['2026-04-17T10:30:00+02:00', 'ZNP1AN', 'ready_for_pickup', 'Pošta Príkladná Ves 2'],
      ['2026-04-17T07:55:00+02:00', 'VDOOK', 'out_for_delivery', 'Pošta Príkladná Ves 2'],
      ['2026-04-16T05:00:00+02:00', 'VDOIO', 'in_transit', 'Vzorovo 090'],
      ['2026-04-15T14:00:00+02:00', 'IPS_EDC', 'in_transit', null],
      ['2026-04-14T07:30:00+02:00', 'IPS_EME_73', 'customs', null],
      ['2026-04-13T16:40:00+02:00', 'IPS_EDB_CST', 'customs', null],
      ['2026-04-13T09:20:00+02:00', 'IPS_EMD_THERE', 'in_transit', null],
      ['2026-04-08T23:50:00', 'IPS_EMC_THERE', 'in_transit', 'United States'],
      ['2026-04-07T17:22:00', 'IPS_EMA', 'accepted', 'United States'],
    ]);
    // A domestic delivery after the item was sent back is the sender's.
    const home = parseSlovenskaPosta(edited('returned', parcel => {
      parcel.events!.splice(0, 3, { at: at('2026-05-04T10:00:00'), desc: { en: 'Delivered to addressee' }, type: 'OK',
        on: { kind: 'office', dname: 'Pošta Vzorovo 1', city: 'Vzorovo' } });
    }), RETURNED);
    expect(home).toMatchObject({ current_stage: 'returned', last_update: '2026-05-04T10:00:00+02:00' });
    expect(home.pickup_point).toBeUndefined();
    expect(home.delivered_at).toBeUndefined();
    // An unknown country keeps the wall clock and no place.
    const unknown = parseSlovenskaPosta(edited('returned', parcel => { parcel.events![0]!.on = { country: 'XX' }; }), RETURNED);
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-15T13:30:00', description: 'Delivered to addressee',
      provider_code: 'IPS_EMI_BACK', stage: 'returned', stage_source: 'carrier_map' });
  });

  it('names the box an item waits in from its state, and a notice keeps the stage before it', () => {
    const result = parseSlovenskaPosta(JSON.parse(json('retained')), RETAINED);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'BalíkoBOX Vzorovo Námestie, Vzorovo', last_update: '2026-04-02T09:14:00+02:00' });
    expect(result.expected_delivery).toBeNull();
    expect(result.events![1]).toEqual({ time: '2026-04-01T18:00:00+02:00', description: 'Change of delivery day', provider_code: 'ZDD',
      stage: 'in_transit', stage_source: 'none' });
    expect(JSON.stringify(result)).not.toMatch(/Vzorová|99999|48\.9999|0900000000|20550/);
    // Without events, the state alone is a summary.
    const summary = parseSlovenskaPosta(edited('retained', parcel => { parcel.events = []; }), RETAINED);
    expect(summary).toEqual({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      provider_code: 'retained', last_status_text: 'Deposited in ParcelBOX', last_update: null, expected_delivery: null,
      pickup_point: 'BalíkoBOX Vzorovo Námestie, Vzorovo', weight_kg: 2.5, summary_only: true, events: [] });
    const customs = parseSlovenskaPosta(edited('retained', parcel => {
      delete parcel.events;
      parcel.state = { state: 'customs' };
      parcel.messages = ['track_not_provided'];
    }), RETAINED);
    expect(customs).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'eCustoms procedure', summary_only: true });
    expect(customs.pickup_point).toBeUndefined();
    const withheld = edited('retained', parcel => { delete parcel.events; delete parcel.state; parcel.messages = ['track_not_provided']; });
    expect(() => parseSlovenskaPosta(withheld, RETAINED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'tracking_withheld' }));
    const bare = edited('retained', parcel => { parcel.events = []; parcel.state = { state: 'later' }; });
    expect(() => parseSlovenskaPosta(bare, RETAINED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
  });

  it('reads a number the sender has not posted as a registered item, which recognition does not count', async () => {
    expect(parseSlovenskaPosta(JSON.parse(json('not-posted')), NOT_POSTED)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', provider_code: 'not_found_assigned', last_status_text: 'The item has not been posted by the sender yet',
      last_update: null, expected_delivery: null, summary_only: true, events: [] });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(json('not-posted')));
    await expect(carrier(fetcher).recognize!(NOT_POSTED)).resolves.toEqual({ known: false, lastActivityAt: null });
  });

  it('keeps new and uncertain codes visible without a stage, drops repeated events and caps long histories', () => {
    const result = parseSlovenskaPosta(edited('collected', parcel => {
      parcel.events!.unshift(
        { at: at('2026-03-07T09:00:00'), desc: { en: 'Complaint procedure', sk: 'V reklamačnom konaní' }, type: 'REKL' },
        { at: at('2026-03-06T09:00:00'), desc: { sk: 'Niečo nové' }, type: 'NOVY' },
        { at: at('2026-03-06T08:00:00'), desc: {}, type: 'IPS_EZZ' },
      );
      parcel.events!.push({ ...parcel.events!.at(-1)! });
    }), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Complaint procedure' });
    expect(result.events!.slice(0, 3)).toEqual([
      { time: '2026-03-07T09:00:00+01:00', description: 'Complaint procedure', provider_code: 'REKL' },
      { time: '2026-03-06T09:00:00+01:00', description: 'Niečo nové', provider_code: 'NOVY' },
      { time: '2026-03-06T08:00:00+01:00', description: 'IPS_EZZ', provider_code: 'IPS_EZZ' },
    ]);
    expect(result.events!.filter(event => event.provider_code === 'PODOD')).toHaveLength(1);
    // A code no map knows takes the shared wording rules.
    const worded = parseSlovenskaPosta(edited('collected', parcel => {
      parcel.events![0] = { ...parcel.events![0]!, type: 'NOVY', desc: { en: 'Item delivered to the addressee' } };
    }), COLLECTED);
    expect(worded.events![0]).toMatchObject({ stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    const long = parseSlovenskaPosta(edited('collected', parcel => {
      parcel.events!.push(...Array.from({ length: 120 }, (_, index) => ({ at: at('2026-03-01T08:00:00') - index * 60_000,
        desc: { en: 'In transit' }, type: 'VDOIO' })));
    }), COLLECTED);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('reads its not-found answer as a missing item, and its other error answers apart from it', async () => {
    expect(() => parseSlovenskaPosta(JSON.parse(json('not-found')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(json('collected'))).mockResolvedValueOnce(reply(json('not-found')));
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T14:42:10.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const answer = (error: string, barcode = true) => ({ parcels: [{ ...(barcode ? { barcode: UNKNOWN } : {}), error, query: UNKNOWN }] });
    expect(() => parseSlovenskaPosta(answer('invalid_barcode', false), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseSlovenskaPosta(answer('not_found_used'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
    expect(() => parseSlovenskaPosta(answer('server_error'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the answer to the whole requested number and rejects malformed items', () => {
    expect(() => parseSlovenskaPosta(JSON.parse(json('collected')), 'RR900000022SK')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSlovenskaPosta(edited('collected', (parcel, payload) => { payload.parcels.push({ ...parcel }); }), COLLECTED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    for (const change of [
      (parcel: Parcel) => { delete parcel.barcode; },
      (parcel: Parcel) => { parcel.events![0]!.at = '2026-03-05 15:42'; },
      (parcel: Parcel) => { parcel.events![0]!.at = -1; },
      (parcel: Parcel) => { parcel.events![0]!.type = 'not a code'; },
      (parcel: Parcel) => { (parcel as { events: unknown }).events = {}; },
      (parcel: Parcel) => { (parcel.events as unknown[])[0] = 'event'; },
    ]) expect(() => parseSlovenskaPosta(edited('collected', change), COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'item', {}, { parcels: {} }, { parcels: ['parcel'] }, { parcels: [] }]) {
      expect(() => parseSlovenskaPosta(payload, COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: COLLECTED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(COLLECTED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [[text('blocked.html'), 'challenge'], ['<html><body>Údržba</body></html>', 'schema'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
      await expect(carrier(fetcher).recognize!(COLLECTED), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: COLLECTED })).rejects.toThrow('unexpectedly large');
  });

  it('takes S10 item codes, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RR900000018SK', 'RR90000001SK', 'RR9000000199SK', '123456789012', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const number = new URL(String(url)).searchParams.get('q')!;
      return reply(JSON.stringify({ parcels: [{ actions: ['notifs'], barcode: number, error: 'not_found', query: number }] }));
    });
    for (const number of ['RR900000019DE', UNKNOWN]) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([url]) => String(url))).toEqual(['RR900000019DE', UNKNOWN].map(slovenskaPostaUrl));
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(json('collected')));
    await expect(carrier(flaky).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(json('collected')));
    await expect(carrier(immediate).track({ number: COLLECTED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: COLLECTED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: COLLECTED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an item filed under Slovenská pošta to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('returned')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNED, carrier: 'slovenska-posta' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'slovenska-posta', source: 'slovenska-posta', result: { current_stage: 'returned' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === slovenskaPostaUrl(RETURNED))).toBe(true);
  });

  it('is named for its own S10 items, asked about its other Slovak codes, and reads its links', () => {
    expect(detectCarrierMatch(COLLECTED)).toMatchObject({ carrier: 'slovenska-posta', confidence: 'high' });
    expect(detectCarrierMatch('UA900000019SK')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers('UA900000019SK')).toContain('slovenska-posta');
    expect(recognitionAskedCarriers('RR900000018SK')).not.toContain('slovenska-posta');
    expect(recognitionAskedCarriers('RR900000019DE')).not.toContain('slovenska-posta');
    expect(parseTrackingInput(`https://www.posta.sk/sledovanie-zasielok#parcel=${COLLECTED}`))
      .toMatchObject({ trackingNumber: COLLECTED, carrier: 'slovenska-posta', source: 'link' });
  });
});

describe('Slovenská pošta status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(stage);
      expect(slovenskaPostaCodeStage(entry.code), entry.code).toBe(stage);
    }
    for (const code of ['constructor', 'toString', '__proto__', 'IPS_constructor']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage(null, 'delivered to addressee')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'slovenska-posta', providerCode: 'ZNP1AN', description: 'Deposited - addressee not available' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'slovenska-posta', providerCode: 'IPS_EMI_BACK', description: 'Delivered to addressee' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    for (const code of ['ZDD', 'POD', 'REKL', 'IPS_EDA']) {
      expect(statusMapAnswer({ carrier: 'slovenska-posta', providerCode: code, description: 'Any wording' }), code).toMatchObject({ kind: 'intentional_gap' });
    }
  });
});
