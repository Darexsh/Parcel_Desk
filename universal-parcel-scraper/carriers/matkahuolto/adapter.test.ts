import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MATKAHUOLTO_ENDPOINT, MatkahuoltoTracker } from './adapter.js';
import { parseMatkahuolto } from './parser.js';
import { matkahuoltoScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = 'MH000000014FI';
const WAITING = 'MH000000028FI';
const ABSENT = 'MH999999995FI';
const SSCC = '300000000000000018';
// SSCCs of Swedish and Finnish GS1 companies, the ones its tracker has answered.
const NORDIC_SSCC = '373123456789012348';
const FINNISH_SSCC = '064123456789012345';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

type Row = { time: string; date: string; description: string; place: string | null; officeCode: string | null };
type Reply = { parcelNumber: string; productCategory: string; trackingEvents: Row[] };
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name) as Reply;
  change(payload);
  return payload;
};
const row = (date: string, time: string, description: string, place: string | null = null): Row =>
  ({ date, time, description, place, officeCode: null });

describe('Matkahuolto tracking adapter', () => {
  it('asks the tracking service once, in English, through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MatkahuoltoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' mh 000 000 014 fi ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MATKAHUOLTO_ENDPOINT}?language=en&parcelNumber=${COLLECTED}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'application/json' } });
    expect(init!.method ?? 'GET').toBe('GET');
    expect(new Headers(init!.headers).has('authorization')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'matkahuolto', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel collected from a pickup point newest first, as wall clocks', () => {
    const result = parseMatkahuolto(fixture('collected'), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The consignment has been delivered. Thank you for choosing Matkahuolto!', last_update: null,
      last_update_local: '2026-03-05T17:42:00', expected_delivery: null, service_name: 'Pick-up Parcel',
      pickup_point: 'Testilä pakettipiste Esimerkkikauppa Testilä\nMallikatu 1' });
    expect(result.events!.map(event => [event.local_time, event.location, event.stage, event.stage_source])).toEqual([
      ['2026-03-05T17:42:00', 'Testilä', 'delivered', 'carrier_map'],
      ['2026-03-04T09:15:00', undefined, 'ready_for_pickup', 'none'],
      ['2026-03-04T09:15:00', 'Testilä', 'ready_for_pickup', 'carrier_map'],
      ['2026-03-04T08:02:00', 'Testilä', 'in_transit', 'carrier_map'],
      ['2026-03-04T06:30:00', 'Testilä', 'out_for_delivery', 'carrier_map'],
      ['2026-03-03T23:10:00', 'Testilä', 'in_transit', 'carrier_map'],
      ['2026-03-03T23:05:00', 'Testilä', 'in_transit', 'carrier_map'],
      ['2026-03-03T19:40:00', 'Malliala', 'in_transit', 'carrier_map'],
      ['2026-03-03T19:38:00', 'Malliala', 'in_transit', 'carrier_map'],
      ['2026-03-03T19:20:00', 'Malliala', 'in_transit', 'carrier_map'],
      ['2026-03-01T10:05:00', undefined, 'registered', 'carrier_map'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.point === undefined)).toBe(true);
    // References, the departure station, coordinates and postcodes are never read.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE-|Esimerkki"|00000|60\.1|24\.9|Service point fee|2026-03-11/);
  });

  it('keeps a parcel waiting at its locker when a notice comes after it', () => {
    const result = parseMatkahuolto(fixture('waiting'), WAITING);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', service_name: 'XXS Parcel',
      last_status_text: expect.stringMatching(/^Your parcel is available for pick up at the pick up point/),
      last_update_local: '2026-03-10T07:40:00', pickup_point: 'Malliala pakettiautomaatti Esimerkkikeskus\nMallitie 2' });
    expect(result.events!.map(event => [event.stage, event.stage_source])).toEqual([
      ['ready_for_pickup', 'none'], ['ready_for_pickup', 'carrier_map'], ['out_for_delivery', 'none'],
      ['out_for_delivery', 'carrier_map'], ['in_transit', 'carrier_map'], ['registered', 'carrier_map'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE-REF/);
    // A parcel the sender has only announced is pending.
    const announced = edited('waiting', payload => { payload.trackingEvents.splice(0, 5); });
    expect(parseMatkahuolto(announced, WAITING)).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('keeps equal clocks in the tracker’s order and drops repeated scans', () => {
    const result = parseMatkahuolto(fixture('collected'), COLLECTED);
    const shuffled = edited('collected', payload => {
      payload.trackingEvents.reverse();
      payload.trackingEvents.push(payload.trackingEvents[0]!);
    });
    expect(parseMatkahuolto(shuffled, COLLECTED).events!.map(event => [event.local_time, event.description]))
      .toEqual(result.events!.map(event => [event.local_time, event.description]));
  });

  it('names no pickup point for a parcel taken on from its point and reads only towns and public points as places', () => {
    const movedOn = edited('collected', payload => {
      payload.trackingEvents.splice(1, 0, row('05.03.2026', '08:00', 'The consignment is on its way', 'Testilä 00000'));
    });
    const result = parseMatkahuolto(movedOn, COLLECTED);
    expect(result).toMatchObject({ current_stage: 'delivered' });
    expect(result.pickup_point).toBeUndefined();
    const places = edited('waiting', payload => {
      payload.trackingEvents[1]!.place = 'Malliala pakettiautomaatti Esimerkkikeskus';
      payload.trackingEvents[2]!.place = 'Mallitie 3 B 4, 00000 Malliala';
      payload.trackingEvents[3]!.place = 'Malliala kotiautomaatti Asunto Oy Esimerkki, Mallitie 3';
    });
    const read = parseMatkahuolto(places, WAITING);
    expect(read.pickup_point).toBe('Malliala pakettiautomaatti Esimerkkikeskus');
    expect(read.events!.slice(1, 4).map(event => event.location)).toEqual(['Malliala', undefined, undefined]);
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const returned = edited('collected', payload => {
      payload.trackingEvents[0]!.description = 'The consignment has been returned to the sender';
    });
    expect(parseMatkahuolto(returned, COLLECTED)).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
    const unknown = edited('collected', payload => { payload.trackingEvents[0]!.description = 'Paketti punnittu'; });
    const result = parseMatkahuolto(unknown, COLLECTED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Paketti punnittu' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ local_time: '2026-03-05T17:42:00', description: 'Paketti punnittu', location: 'Testilä' });
    // A service whose name says it was paid in cash is not shown on the page.
    const cash = edited('collected', payload => { payload.productCategory = 'Bussipaketti käteinen'; });
    expect(parseMatkahuolto(cash, COLLECTED).service_name).toBeUndefined();
  });

  it('binds the reply to the whole requested number, with or without an SSCC’s 00', () => {
    expect(() => parseMatkahuolto(fixture('collected'), WAITING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const named of [`00${SSCC}`, SSCC]) {
      const payload = edited('collected', reply => { reply.parcelNumber = named; });
      expect(parseMatkahuolto(payload, SSCC)).toMatchObject({ status: 'delivered' });
      expect(parseMatkahuolto(payload, `00${SSCC}`)).toMatchObject({ status: 'delivered' });
    }
    for (const named of [`${COLLECTED} ${WAITING}`, `0${SSCC}`, '', `00${SSCC.slice(0, -1)}5`]) {
      const payload = edited('collected', reply => { reply.parcelNumber = named; });
      expect(() => parseMatkahuolto(payload, named.startsWith('M') || !named ? COLLECTED : SSCC), named)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects malformed histories', () => {
    for (const payload of [[], null, 'reply', { parcelNumber: COLLECTED },
      edited('collected', reply => { (reply as { parcelNumber: unknown }).parcelNumber = 14; }),
      edited('collected', reply => { (reply as { trackingEvents: unknown }).trackingEvents = {}; }),
      edited('collected', reply => { reply.trackingEvents[2]!.time = '25:75'; }),
      edited('collected', reply => { reply.trackingEvents[2]!.date = '2026-03-04'; }),
      edited('collected', reply => { reply.trackingEvents[2]!.description = ' '; }),
      edited('collected', reply => { (reply.trackingEvents as unknown[])[2] = 'scan'; })]) {
      expect(() => parseMatkahuolto(payload, COLLECTED), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the service’s own not-found reply as a missing parcel', () => {
    expect(() => parseMatkahuolto(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ notFound: false }, { notFound: true, parcelNumber: ABSENT }, { notFound: 'true' },
      edited('collected', reply => { reply.trackingEvents = []; })]) {
      expect(() => parseMatkahuolto(payload, COLLECTED), JSON.stringify(payload).slice(0, 60)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('takes its own numbers, postal S10 items and SSCCs, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['MH000000015FI', 'MA000000000000000001', 'ZZ000000015EE', '300000000000000019', '00300000000000000019', '12345', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    // Recognition asks about Matkahuolto's own numbers and SSCCs, not about a post's items.
    await expect(carrier(fetcher).recognize!('ZZ000000014EE')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    const asked = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found')));
    for (const number of [NORDIC_SSCC, `00${FINNISH_SSCC}`]) await expect(carrier(asked).recognize!(number), number).resolves.toEqual({ known: false });
    expect(asked.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('parcelNumber'))).toEqual([NORDIC_SSCC, `00${FINNISH_SSCC}`]);
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found')));
    for (const number of ['ZZ000000014EE', SSCC, `00${SSCC}`, 'MA0000000000000000001']) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('parcelNumber')))
      .toEqual(['ZZ000000014EE', SSCC, `00${SSCC}`, 'MA0000000000000000001']);
  });

  it('recognizes a known parcel and the not-found reply, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('collected'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T17:42:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[400, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [302, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: 'https://www.matkahuolto.fi/' } }) : reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps challenges, block pages, empty and malformed replies apart from missing parcels', async () => {
    const waf = vi.fn<typeof fetch>().mockResolvedValue(reply('<html><script>window.gokuProps = {}</script></html>', 202,
      { 'Content-Type': 'text/html', 'x-amzn-waf-action': 'challenge' }));
    await expect(carrier(waf).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'challenge' });
    for (const [body, kind] of [['<html><head><title>ERROR: The request could not be satisfied</title></head><body>Request blocked.</body></html>', 'challenge'],
      ['<html><body>Huoltokatko</body></html>', 'schema'], ['', 'indeterminate'], ['  ', 'indeterminate'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(COLLECTED), body).rejects.toMatchObject({ kind });
    }
    const accepted = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected'), 202));
    await expect(carrier(accepted).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'indeterminate' });
    const bom = vi.fn<typeof fetch>().mockResolvedValue(reply(`\uFEFF${text('collected')}`));
    await expect(carrier(bom).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: COLLECTED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('collected')));
    await expect(carrier(flaky).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
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

  it('routes a parcel filed under Matkahuolto to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('collected')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: COLLECTED, carrier: 'matkahuolto' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'matkahuolto', source: 'matkahuolto', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(MATKAHUOLTO_ENDPOINT))).toBe(true);
  });

  it('is asked about its MH and MA numbers, which detection leaves with the postal fallback or unclaimed, and keeps its links', () => {
    expect(detectCarrierMatch(COLLECTED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(COLLECTED)).toEqual(expect.arrayContaining(['posti', 'matkahuolto']));
    expect(recognitionAskedCarriers('MA1234567890123456789')).toContain('matkahuolto');
    for (const number of ['MH000000015FI', 'ZZ000000014FI', 'ZZ000000014EE', `00${SSCC}`, SSCC]) {
      expect(recognitionAskedCarriers(number), number).not.toContain('matkahuolto');
    }
    for (const path of ['seuranta', 'tracking', 'uppfoljning']) {
      expect(parseTrackingInput(`https://www.matkahuolto.fi/${path}?parcelNumber=${COLLECTED}`))
        .toMatchObject({ trackingNumber: COLLECTED, carrier: 'matkahuolto', source: 'link' });
    }
  });

  it('is asked about an SSCC of a Swedish or Finnish company, with or without its 00, from Finland first', () => {
    for (const number of [NORDIC_SSCC, `00${NORDIC_SSCC}`, FINNISH_SSCC, `00${FINNISH_SSCC}`]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['matkahuolto']) });
      expect(recognitionAskedCarriers(number), number).toContain('matkahuolto');
    }
    // A Swedish company's SSCC stays first with Bring, which issues its own under that prefix.
    expect(recognitionAskedCarriers(`00${NORDIC_SSCC}`, { countryHint: 'FI' }).slice(0, 2)).toEqual(['bring-posten', 'matkahuolto']);
    // A failed check digit or another country's GS1 prefix is not Matkahuolto's.
    for (const number of ['373123456789012340', '00373123456789012340', '376000000000000006', '00376000000000000006']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('matkahuolto');
    }
  });

  it('leaves its MA numbers to recognition when they also fit an Australia Post article ID', () => {
    // MA, ten digits, 000 and six digits: an article ID only if a merchant location ID began with MA.
    const MA = 'MA1234567890000123456';
    expect(detectCarrierMatch(MA)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['matkahuolto'] });
    expect(recognitionAskedCarriers(MA, { countryHint: 'AU' })).toEqual(['matkahuolto']);
    // Australia Post keeps its article IDs, those with a two-digit prefix included.
    for (const article of ['MB1234567890000123456', '12MA1234567890000123456', 'AP7123456789000123456']) {
      expect(detectCarrierMatch(article), article).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
    }
  });
});

describe('Matkahuolto status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(matkahuoltoScanStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(stage);
    }
    expect(matkahuoltoScanStage('The consignment is ready to continue its journey from Matkahuolto Malliala')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'The consignment has been delivered to the pickup point',
      'Your pick up point has changedX', 'Matkahuolto is waiting for the consignment from the senders']) {
      expect(matkahuoltoScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'consignment is being processed')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'matkahuolto', description: 'Your parcel is available for pick up at the pick up point Malliala pakettipiste Esimerkki.' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'matkahuolto', description: 'We have sent the recipient a message about the arrival of the consignment (sms).' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
