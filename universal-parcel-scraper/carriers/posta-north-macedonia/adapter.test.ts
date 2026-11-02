import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTA_NORTH_MACEDONIA_API, PostaNorthMacedoniaTracker, postaNorthMacedoniaLookupUrl } from './adapter.js';
import { normalizePostaNorthMacedoniaNumber, parsePostaNorthMacedonia, parsePostaNorthMacedoniaBody } from './parser.js';
import { postaNorthMacedoniaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014DE';
const IN_TRANSIT = 'ZZ000000028MK';
const WITHOUT_HISTORY = 'ZZ000000031IT';
const UNKNOWN = 'ZZ000000045MK';
// The postman, the recipient, postcodes and dispatch numbers never reach the result.
const PRIVATE = /Primer Primerovski|PRIMER|PRIMERNA|99\d\d|DE-99999|DEXMP|1234|\bPV\b/;

type Row = Record<string, unknown>;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const rows = (name: string): Row[] => JSON.parse(text(name)) as Row[];
const edited = (name: string, change: (rows: Row[]) => void): Row[] => {
  const payload = rows(name);
  change(payload);
  return payload;
};
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const service = (body: string, status = 200) => vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pošta na Severna Makedonija tracking adapter', () => {
  it('asks the tracking service for the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = service(text('in-transit.json'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostaNorthMacedoniaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 028 mk ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${POSTA_NORTH_MACEDONIA_API}?code=${IN_TRANSIT}`);
    expect(postaNorthMacedoniaLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posta-north-macedonia', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad newest first, with wall clocks, offices, the countries of exchange rows and its destination', () => {
    const result = parsePostaNorthMacedonia(rows('delivered.json'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Ispora~ana', last_update: null, last_update_local: '2026-06-04T11:25:00', expected_delivery: null,
      destination_country: 'MK' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-06-04T11:25:00', 'Ogle~evo-Dostava', 'Ispora~ana', 'delivered'],
      ['2026-06-04T07:12:00', 'Ogle~evo', 'Za Dost./ Ispor.', 'out_for_delivery'],
      ['2026-06-03T21:40:00', 'Primerovo PC', 'Vo Posta', 'in_transit'],
      ['2026-06-03T09:05:00', 'Primerovo IO', 'Vo Posta', 'in_transit'],
      // A row the reply lists twice is kept once.
      ['2026-06-02T08:25:00', 'North Macedonia', 'Pristignata vo Naizmeni!na po{ta (Vlez)', 'in_transit'],
      // Rows at one clock keep the reply's order.
      ['2026-05-27T10:49:00', 'Germany', 'Pristignata vo Naizmeni!na po{ta (Izlez)', 'in_transit'],
      ['2026-05-27T10:49:00', 'Germany', 'Pratkata e stavena vo vre}a (Izlez)', 'in_transit'],
      ['2026-05-27T10:49:00', 'Germany', 'Pratkata se prima od Ispra}a~', 'accepted'],
    ]);
    // No clock carries an offset the service never gave.
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'posta-north-macedonia', steps: ['direct', 'retry'], recognition: { rank: 899 }, localClocks: true });
  });

  it('reads an item posted in North Macedonia, with either spelling of a note, and gives no destination before an inward exchange', async () => {
    const result = await carrier(service(text('in-transit.json'))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Pratkata e stavena vo vre}a(Izlez)',
      last_update_local: '2026-07-11T07:29:00' });
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2026-07-11T07:29:00', 'North Macedonia', 'in_transit'],
      ['2026-07-10T21:29:00', 'Primerovo PC', 'in_transit'],
      ['2026-07-10T14:47:00', 'Primerovo', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('keeps a day without a clock, a note the map does not know and an office code that names no country', () => {
    const changed = parsePostaNorthMacedonia(edited('in-transit.json', (payload) => {
      payload[0]!.DATA_PERPUNIMIT = '12.07.2026';
      payload[0]!.ZABELESKA = 'SYNTHETIC NOTE';
      payload[2]!.POSTA_FILLIM = 'XQ123';
    }), IN_TRANSIT);
    expect(changed.events![0]).toEqual({ local_time: '2026-07-12', location: 'Primerovo', description: 'SYNTHETIC NOTE' });
    expect(changed).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'SYNTHETIC NOTE' });
    expect(changed.events![1]).toEqual({ local_time: '2026-07-11T07:29:00', description: 'Pratkata e stavena vo vre}a(Izlez)',
      stage: 'in_transit', stage_source: 'carrier_map' });
    const unstaged = parsePostaNorthMacedonia(edited('in-transit.json', (payload) => {
      for (const row of payload) row.ZABELESKA = 'SYNTHETIC NOTE';
    }), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'SYNTHETIC NOTE' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('counts an item only when every row names the code asked', () => {
    expect(() => parsePostaNorthMacedonia(rows('in-transit.json'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Pošta na Severna Makedonija answered for a different item' }));
    for (const [name, change] of [
      ['one other row', (payload: Row[]) => { payload[1]!.NR_R_DERGESES = UNKNOWN; }],
      ['a longer code', (payload: Row[]) => { payload[0]!.NR_R_DERGESES = `${IN_TRANSIT}1`; }],
      ['a record of another item', (payload: Row[]) => { payload.push({ PRAPRIEMENBROJ: UNKNOWN, DATA_PERPUNIMIT: null }); }],
    ] as const) {
      expect(() => parsePostaNorthMacedonia(edited('in-transit.json', change), IN_TRANSIT), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parsePostaNorthMacedonia(edited('in-transit.json', (payload) => { payload[0]!.NR_R_DERGESES = ' zz000000028mk '; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads the empty list as not found and a delivery record without scans as no history, without its recipient', async () => {
    await expect(carrier(service(text('not-found.json'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const error = await carrier(service(text('no-history.json'))).track({ number: WITHOUT_HISTORY }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    expect(JSON.stringify(error)).not.toMatch(PRIVATE);
    expect(String((error as Error).message)).not.toMatch(PRIVATE);
    // A delivery record beside scans adds nothing.
    const mixed = edited('in-transit.json', (payload) => { payload.push({ PRAPRIEMENBROJ: IN_TRANSIT, PRIMAC_IME: 'PRIMER', DATA_PERPUNIMIT: null }); });
    expect(parsePostaNorthMacedonia(mixed, IN_TRANSIT).events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const [name, payload] of [
      ['an object', { data: [] }],
      ['null', null],
      ['a row that is not an object', ['Vo Posta']],
      ['a row without its item', edited('in-transit.json', (payload) => { delete payload[0]!.NR_R_DERGESES; })],
      ['a numeric item', edited('in-transit.json', (payload) => { payload[0]!.NR_R_DERGESES = 28; })],
      ['a scan without wording', edited('in-transit.json', (payload) => { payload[0]!.ZABELESKA = ' '; })],
      ['a scan without a date', edited('in-transit.json', (payload) => { payload[0]!.DATA_PERPUNIMIT = null; })],
      ['the former date format', edited('in-transit.json', (payload) => { payload[0]!.DATA_PERPUNIMIT = '10-JUL-26'; })],
      ['an impossible date', edited('in-transit.json', (payload) => { payload[0]!.DATA_PERPUNIMIT = '31.06.2026 10:00'; })],
      ['an impossible clock', edited('in-transit.json', (payload) => { payload[0]!.DATA_PERPUNIMIT = '30.06.2026 24:10'; })],
      ['an office that is not text', edited('in-transit.json', (payload) => { payload[0]!.EMRI = ['Primerovo']; })],
      ['too many rows', edited('in-transit.json', (payload) => { payload.push(...Array.from({ length: 500 }, () => payload[0]!)); })],
    ] as const) {
      expect(() => parsePostaNorthMacedonia(payload, IN_TRANSIT), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePostaNorthMacedoniaBody('')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostaNorthMacedoniaBody('<html><body>Synthetic</body></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a firewall page, an empty reply, a moved route and HTTP refusals apart from a missing item', async () => {
    const track = (fetcher: typeof fetch) => carrier(fetcher).track({ number: IN_TRANSIT });
    expect(() => parsePostaNorthMacedoniaBody(text('rejected.html'))).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(track(service(text('rejected.html')))).rejects.toMatchObject({ kind: 'challenge' });
    // The service answers a route it does not have with an empty page.
    await expect(track(service(''))).rejects.toMatchObject({ kind: 'schema' });
    for (const [name, answer] of [
      ['redirect', () => new Response(null, { status: 302, headers: { Location: '/' } })],
      ['404', () => new Response('<html>Synthetic</html>', { status: 404 })],
      ['410', () => new Response('', { status: 410 })],
    ] as const) {
      const moved = vi.fn<typeof fetch>().mockImplementation(async () => answer());
      await expect(track(moved), name).rejects.toMatchObject({ kind: 'transport' });
      expect(moved, name).toHaveBeenCalledOnce();
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = service('', status);
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known code and the not-found answer, and asks nothing about a code it cannot track', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(service(text('delivered.json'))).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-04T11:25:00' });
    await expect(carrier(service(text('not-found.json'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(service(text('rejected.html'))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('ZZ000000046MK')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => reply(text('delivered.json')));
    await expect(new PostaNorthMacedoniaTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other codes before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // A failed check digit, other shapes, the page's example order number and an oversized paste.
    for (const number of ['ZZ000000015MK', 'ZZ00000001MK', 'Z000000014MK', '00000000000', '', 'R'.repeat(65)]) {
      await expect(new PostaNorthMacedoniaTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new PostaNorthMacedoniaTracker({ fetcher: unused }).fetch(IN_TRANSIT, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    // A letter O typed for a zero in the serial.
    expect(normalizePostaNorthMacedoniaNumber('zz0OOOOOO28mk')).toBe(IN_TRANSIT);
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new PostaNorthMacedoniaTracker({ fetcher: hanging }).fetch(IN_TRANSIT, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(new PostaNorthMacedoniaTracker({ fetcher: service('x'.repeat(600_000)) }).fetch(IN_TRANSIT))
      .rejects.toThrow('unexpectedly large');
  });

  it('routes a code filed under Pošta na Severna Makedonija to the adapter', async () => {
    const fetcher = service(text('delivered.json'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'posta-north-macedonia' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'posta-north-macedonia', source: 'posta-north-macedonia', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === postaNorthMacedoniaLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Pošta na Severna Makedonija status vocabulary', () => {
  it('records every note the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'posta-north-macedonia', providerCode: null, description: 'pratkata e stavena vo vre}a(izlez)' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'posta-north-macedonia', providerCode: null, description: 'synthetic note' })).toEqual({ kind: 'unknown' });
    expect(postaNorthMacedoniaStage('SYNTHETIC NOTE')).toBeNull();
  });
});
