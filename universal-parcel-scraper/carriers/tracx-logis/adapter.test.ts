import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { discoverActionId, lookupActionId, MAX_CHUNKS, viewChunks } from './action.js';
import { adapter, TRACX_ACTION, TRACX_PAGE, TracxTracker } from './adapter.js';
import { normalizeTracxNumber, parseTracx, readActionReply, UnknownActionError } from './parser.js';
import { statusMap, tracxMappedStage, tracxStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'QSP000000101';
const IN_TRANSIT = 'QSP000000202';
const ATTEMPTED = 'QSP000000303';
const UNKNOWN = 'QSP000000404';
const RSC = 'text/x-component';
const HEAD = '0:{"a":"$@1","f":"","b":"SyntheticBuild0001"}';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Row = Record<string, unknown>;
type Result = { dataInfo: Row; history: Row[] };
const rows = (name: string) => text(name).trimEnd().split('\n');
const resultOf = (name: string) => JSON.parse(rows(name).find(row => row.startsWith('1:'))!.slice(2)) as Result;
const flight = (result: unknown, ...extra: string[]) => `${[HEAD, `1:${JSON.stringify(result)}`, ...extra].join('\n')}\n`;
/** A fixture with its result row changed; its other rows stay. */
const edited = (name: string, change: (summary: Row, history: Row[], result: Result) => void) => {
  const result = resultOf(name);
  change(result.dataInfo, result.history, result);
  return flight(result, ...rows(name).filter(row => !/^[01]:/.test(row)));
};
const parse = (body: string, number: string, type: string | null = RSC) => parseTracx(readActionReply(new TextEncoder().encode(body), type), number);
const reply = (body: string, status = 200, type = RSC) => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const UNKNOWN_ACTION = () => new Response('Server action not found.',
  { status: 404, headers: { 'Content-Type': 'text/plain', 'x-nextjs-action-not-found': '1' } });

describe('TracX Logis tracking adapter', () => {
  it('calls the tracking page’s server action for the whole number once, as the page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered.rsc')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TracxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' qsp 000-000-101 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TRACX_PAGE);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify([DELIVERED]),
      headers: { Accept: RSC, 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': TRACX_ACTION, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tracx-logis', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel handed to Sagawa newest first, at its UTC instants, with the delivery number and nothing personal', () => {
    const result = parse(text('delivered.rsc'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Completed', last_update: '2026-04-12T05:10:00Z', expected_delivery: null,
      delivered_at: '2026-04-12T05:10:00Z', destination_country: 'JP', delivery_carrier: 'sagawa', delivery_tracking_number: '100000000004' });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-04-12T05:10:00Z', 'サンプル営業所', 'Delivery Completed', 'D4', 'delivered'],
      ['2026-04-11T23:40:00Z', 'サンプル営業所', 'Departure for Delivery to Customer', 'L60', 'out_for_delivery'],
      ['2026-04-10T09:20:00Z', 'サンプル空港営業所', 'Handover/Receipt Completed by Delivery Company', 'L10', 'in_transit'],
      ['2026-04-10T07:15:00Z', undefined, 'Customs Clearance Completed in Destination Country', 'M80', 'in_transit'],
      ['2026-04-08T09:12:30Z', undefined, 'Arrival in Destination Country', 'M50', 'in_transit'],
      ['2026-04-08T09:05:10Z', undefined, 'Customs Clearance Initiated in Destination Country', 'M70', 'customs'],
      ['2026-04-07T08:30:45Z', undefined, 'Released from Collection Center', 'SI', 'in_transit'],
      ['2026-04-07T06:05:20Z', 'TracxLogis KR Sample DPC', 'Received at Collection Center', 'D2', 'in_transit'],
      ['2026-03-28T01:15:40Z', undefined, 'Received Shipping Order', 'N1', 'registered'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('last_update_local');
    // The recipient, the order's reference, the internal parcel number, the courier per scan and the flight details stay out.
    expect(JSON.stringify(result)).not.toMatch(/Sample R|SAMPLE-ORDER|KRJP|"Sagawa"|Tracxlogis"|Scheduled|SAMPLE-A|오후/);
  });

  it('reads a K-Packet parcel in transit, whose Korea Post number goes to the destination’s post', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit.rsc')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrival in Destination Country',
      last_update: '2026-05-06T09:12:30Z', destination_country: 'JP', delivery_tracking_number: 'LP000000014KR' });
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([
      ['M50', 'in_transit'], ['M70', 'customs'], ['SI', 'in_transit'], ['D2', 'in_transit'], ['N1', 'registered']]);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivered_at');
    expect(deliveryHandoff('tracx-logis', IN_TRANSIT, result)).toEqual({ carrier: 'japan-post', number: 'LP000000014KR', basis: 'destination' });
    expect(deliveryHandoff('tracx-logis', DELIVERED, parse(text('delivered.rsc'), DELIVERED)))
      .toEqual({ carrier: 'sagawa', number: '100000000004', basis: 'partner' });
  });

  it('reads a failed delivery with its reason, and no delivery number when the summary gives the parcel’s own', () => {
    const result = parse(text('attempted.rsc'), ATTEMPTED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Delivery Failed: over time',
      last_update: '2026-06-02T14:30:15Z', destination_country: 'SG' });
    expect(result.events!.map(event => [event.provider_code, event.stage, event.location])).toEqual([
      ['DX:OT', 'failed_attempt', undefined], ['L20', 'out_for_delivery', undefined], ['D2', 'in_transit', 'TracxLogis SG Sample DPC'],
      ['P3', 'accepted', 'Tracxlogis'], ['N1', 'registered', undefined]]);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE COURIER|23:30:15/);
  });

  it('names the delivering carrier only when TracX Logis’s name for it is certain and its rules fit the number', () => {
    const handed = (company: unknown, number: unknown = '100000000004') => {
      const result = parse(edited('delivered.rsc', (summary) => { summary.LastmileShippingCompany = company; summary.TrackingNo = number; }), DELIVERED);
      return [result.delivery_carrier, result.delivery_tracking_number];
    };
    expect(handed('JD Sagawa')).toEqual(['sagawa', '100000000004']);
    expect(handed(' SAGAWA ')).toEqual(['sagawa', '100000000004']);
    expect(handed('Yamato')).toEqual(['yamato', '100000000004']);
    expect(handed('JP Post')).toEqual(['japan-post', '100000000004']);
    // A number Sagawa does not issue keeps the number alone.
    expect(handed('Sagawa', '100000000005')).toEqual([undefined, '100000000005']);
    expect(handed('Sample Courier', '100000000004')).toEqual([undefined, '100000000004']);
    expect(handed('EPOST', 'LP000000014KR')).toEqual(['korea-post', 'LP000000014KR']);
    expect(handed('Sagawa', '')).toEqual([undefined, undefined]);
    expect(handed(null, null)).toEqual([undefined, undefined]);
    expect(handed('Sagawa', 'N/A')).toEqual([undefined, undefined]);
    expect(handed('Sagawa', DELIVERED.toLowerCase())).toEqual([undefined, undefined]);
  });

  it('reads a delivery round or a delivery with the return-to-origin reason as the return', () => {
    const returned = parse(edited('delivered.rsc', (_summary, history) => { history[0]!.Reason = 'RO'; history[0]!.ReasonDesc = 'Return to origin'; }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Delivery Completed: Return to origin' });
    expect(returned.events![0]!.provider_code).toBe('D4:RO');
    expect(returned).not.toHaveProperty('delivered_at');
    expect(tracxMappedStage('L60:RO')).toBe('returned');
    expect(tracxMappedStage('DX:RO')).toBe('failed_attempt');
    expect(tracxMappedStage('d4:ot')).toBe('delivered');
  });

  it('turns any order round, keeps a repeated scan once and leaves unknown codes to the wording rules', () => {
    const reference = parse(text('delivered.rsc'), DELIVERED).events!.map(event => event.time);
    expect(parse(edited('delivered.rsc', (_summary, history) => { history.reverse(); }), DELIVERED).events!.map(event => event.time)).toEqual(reference);
    expect(parse(edited('delivered.rsc', (_summary, history) => { history.splice(1, 0, { ...history[1]! }); }), DELIVERED).events).toHaveLength(9);
    // The same scan from another courier, or with another wording, is another scan.
    expect(parse(edited('delivered.rsc', (_summary, history) => { history.splice(1, 0, { ...history[1]!, StatusDesc: 'Out for delivery' }); }), DELIVERED)
      .events).toHaveLength(10);
    const later = (row: Row): Row => ({ ...row, UTCDate: '2026-05-07T01:00:00Z', Location: '', Reason: '', ReasonDesc: '' });
    const unknown = parse(edited('in-transit.rsc', (_summary, history) => { history.unshift(later({ ...history[0]!, Status: 'Z99', StatusDesc: 'Sample wording' })); }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sample wording', last_update: '2026-05-07T01:00:00Z' });
    expect(unknown.events![0]).toEqual({ time: '2026-05-07T01:00:00Z', description: 'Sample wording', provider_code: 'Z99' });
    const worded = parse(edited('in-transit.rsc', (_summary, history) => { history.unshift(later({ ...history[0]!, Status: 'L30', StatusDesc: 'Out for delivery' })); }), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(worded.events![0]!.stage_source).not.toBe('carrier_map');
    const codeless = parse(edited('in-transit.rsc', (_summary, history) => { history.splice(0, history.length, later({ ...history[0]!, Status: '', StatusDesc: 'Sample note' })); }), IN_TRANSIT);
    expect(codeless).toMatchObject({ status: 'unknown', last_status_text: 'Sample note' });
    expect(codeless.current_stage).toBeUndefined();
    expect(codeless.events![0]).not.toHaveProperty('provider_code');
    const precise = parse(edited('in-transit.rsc', (_summary, history) => { history[0]!.UTCDate = '2026-05-06T09:12:30.1234567Z'; history[0]!.ReasonDesc = 'Held<br/>for &amp; checks<br/>'; }), IN_TRANSIT);
    expect(precise).toMatchObject({ last_update: '2026-05-06T09:12:30.123Z', last_status_text: 'Arrival in Destination Country: Held. for & checks' });
  });

  it('keeps scans of one instant in the reply’s order, reversed when it lists them oldest first', () => {
    const codes = (reverse: boolean) => parse(edited('in-transit.rsc', (_summary, history) => {
      history.unshift({ ...history[0]!, Status: 'M80', StatusDesc: 'Customs Clearance Completed in Destination Country' });
      if (reverse) history.reverse();
    }), IN_TRANSIT).events!.slice(0, 2).map(event => event.provider_code);
    expect(codes(false)).toEqual(['M80', 'M50']);
    expect(codes(true)).toEqual(['M80', 'M50']);
  });

  it('reads text rows and escaped strings in the result', () => {
    const wording = 'Arrival in Destination Country ✓';
    const outlined = edited('in-transit.rsc', (_summary, history) => { history[0]!.StatusDesc = '$3'; history[1]!.Location = '$$1 Sample Hub'; });
    const bytes = new TextEncoder().encode(wording).length.toString(16);
    const result = parse(`${outlined}3:T${bytes},${wording}`, IN_TRANSIT);
    expect(result.last_status_text).toBe(wording);
    expect(result.events![1]!.location).toBe('$1 Sample Hub');
    expect(parse(edited('in-transit.rsc', (summary) => { summary.ShippingNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(5);
    expect(parse(edited('in-transit.rsc', (summary) => { summary.DeliveryNationCd = '$undefined'; }), IN_TRANSIT)).not.toHaveProperty('destination_country');
    expect(parse(edited('in-transit.rsc', (summary) => { summary.DeliveryNationCd = 'Japan'; }), IN_TRANSIT)).not.toHaveProperty('destination_country');
  });

  it('reads the lookup’s empty answer as missing, and its other answers as inconclusive', async () => {
    expect(() => parse(text('not-found.rsc'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const lookup = (body: string, status = 200, type = RSC) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found.rsc'))).rejects.toMatchObject({ kind: 'not_found' });
    // A known parcel without scans, and a summary with only some fields, are not a missing parcel.
    await expect(lookup(edited('in-transit.rsc', (summary, history) => { history.length = 0; summary.ShippingNo = UNKNOWN; })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(edited('not-found.rsc', (summary) => { summary.InputNo = UNKNOWN; })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`${HEAD}\n1:E{"digest":"1234567890"}\n`)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(`${HEAD}\n1:E{"digest":"NEXT_REDIRECT;replace;/;307;"}\n`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`${HEAD}\n1:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}\n`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Request blocked</body></html>', 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"dataInfo":null}', 200, 'application/json')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the reply to the whole requested number and rejects changed replies', () => {
    expect(() => parse(text('delivered.rsc'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TracX Logis answered for another parcel' }));
    // The tracker also finds a parcel by its delivery number; only its own number counts.
    expect(() => parse(edited('delivered.rsc', (summary) => { summary.TrackingNo = IN_TRANSIT; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const scan = (change: (row: Row) => void) => edited('in-transit.rsc', (_summary, history) => { change(history[1]!); });
    for (const body of [
      `${HEAD}\n`, '0:{"a":"x"}\n1:{"dataInfo":{},"history":[]}\n', `${HEAD}\n2:{"dataInfo":{},"history":[]}\n`, '1:{}\n',
      flight([]), flight({ dataInfo: {} }), flight({ dataInfo: null, history: [] }), flight({ dataInfo: {}, history: {} }),
      `${HEAD}\n1:"$1"\n`, `${HEAD}\n1:{"dataInfo":"$2","history":[]}\n`, `${HEAD}\n1:{"dataInfo":"$Dnot a date","history":[]}\n`,
      `${HEAD}\nzz:{}\n`, `${HEAD}\n1:T10,short\n`, `${HEAD}\n1:{"dataInfo":\n`, 'Server action not found.',
      edited('in-transit.rsc', (summary) => { summary.ShippingNo = null; }),
      edited('in-transit.rsc', (summary) => { summary.ShippingNo = 7; }),
      edited('in-transit.rsc', (summary) => { summary.LastmileShippingCompany = ['Sagawa']; }),
      edited('in-transit.rsc', (_summary, history) => { history.push(...Array.from({ length: 501 }, () => history[0]!)); }),
      edited('in-transit.rsc', (_summary, history) => { (history as unknown[])[1] = 'scan'; }),
      scan((row) => { row.Status = 7; }),
      scan((row) => { row.StatusDesc = ''; }),
      scan((row) => { row.StatusDesc = null; }),
      scan((row) => { row.StatusDesc = '$Sreact.element'; }),
      scan((row) => { row.Location = 7; }),
      scan((row) => { row.UTCDate = '2026-05-05 06:05:20'; }),
      scan((row) => { row.UTCDate = '2026-05-05T06:05:20'; }),
      scan((row) => { row.UTCDate = '2026-05-05T06:05:20+09:00'; }),
      scan((row) => { row.UTCDate = '2026-02-30T06:05:20Z'; }),
      scan((row) => { row.UTCDate = '2026-05-05T24:18:12Z'; }),
      scan((row) => { row.UTCDate = ''; }),
      scan((row) => { row.UTCDate = null; }),
      scan((row) => { row.UTCDate = 1780000000000; }),
    ]) {
      expect(() => parse(body, IN_TRANSIT), body.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTracx(readActionReply(new Uint8Array([0x30, 0x3a, 0x22, 0xff, 0x22, 0x0a]), RSC), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // A page in place of the reply is Next's answer to an action it no longer has.
    expect(() => parse('<!DOCTYPE html><html><body>Tracking Parcel</body></html>', IN_TRANSIT, 'text/html')).toThrow(UnknownActionError);
  });

  it('takes QSP and nine digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['QSP00000010', 'QSP0000001011', 'QSX000000101', 'JP0000001', '100000000004', `${DELIVERED},${IN_TRANSIT}`,
      'SAMPLETRACKING', `QSP${'0'.repeat(70)}`, '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTracxNumber(' qsp-000 000 101 ')).toBe(DELIVERED);
  });

  it('recognizes a known parcel and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered.rsc'))).mockResolvedValueOnce(reply(text('not-found.rsc')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-12T05:10:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too Many Requests',
      { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found.rsc'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered.rsc')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered.rsc')));
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
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a TracX Logis number, and the tracker’s links, to the adapter', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'tracx-logis', confidence: 'high' });
    for (const link of [`https://www.tracxlogis.com/tracking?trackingNo=${DELIVERED}`,
      `https://www.qxpress.net/Customer/PopupTraceParcels?TrackingNo=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'tracx-logis', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered.rsc')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tracx-logis', source: 'tracx-logis', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === TRACX_PAGE)).toHaveLength(1);
    // The delivering carrier the summary names is asked about its own number.
    expect(answer.handoff).toMatchObject({ carrier: 'sagawa', number: '100000000004', basis: 'partner' });
  });
});

const FRESH = '7f0e1d2c3b4a59687766554433221100ffeeddccbb';
const HTML = 'text/html; charset=utf-8';
const chunkUrl = (name: string) => `https://www.tracxlogis.com/_next/static/chunks/0000000000000${name}.js`;
const VIEW_CHUNK = chunkUrl('a03');
const DECOY = '(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,'
  + '200001,e=>{"use strict";var m=e.i(100003),x=(0,m.createServerReference)("40aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",m.callServer,void 0,'
  + 'm.findSourceMapURL,"getTrackingInfoList")}]);';
type Site = { live: string; unknown: () => Response; page: () => Response; chunks: Record<string, string> };
const headerOf = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

/** TracX Logis's site after a release: only `live` answers, and the view's chunk names `FRESH`. */
function site(change: Partial<Site> = {}) {
  const state: Site = { live: FRESH, unknown: UNKNOWN_ACTION, page: () => reply(text('page.html'), 200, HTML), ...change,
    chunks: { [chunkUrl('a01')]: DECOY, [chunkUrl('a02')]: DECOY, [VIEW_CHUNK]: text('view-chunk.js'), [chunkUrl('a04')]: DECOY,
      [chunkUrl('a05')]: DECOY, ...change.chunks } };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') return headerOf(init, 'Next-Action') === state.live ? reply(text('delivered.rsc')) : state.unknown();
    if (url === TRACX_PAGE) return state.page();
    const chunk = state.chunks[url];
    return chunk === undefined ? new Response('Not Found', { status: 404 }) : reply(chunk, 200, 'application/javascript');
  });
  const calls = () => fetcher.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}${init?.method === 'POST' ? ` ${headerOf(init, 'Next-Action')}` : ''}`);
  return { state, fetcher, calls };
}

const stepsOf = (step: ReturnType<typeof vi.fn>) => step.mock.calls.map(([event]) => {
  const { step: id, outcome } = event as { step: string; outcome: string };
  return [id, outcome];
});

describe('TracX Logis action discovery', () => {
  it('reads the id the tracking view binds to its history lookup when the tracker no longer has its own, and starts there next time', async () => {
    const { fetcher, calls } = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new TracxTracker({ fetcher, recorder });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    // The view's chunks from the last one back, until one binds the lookup.
    expect(calls()).toEqual([`POST ${TRACX_PAGE} ${TRACX_ACTION}`, `GET ${TRACX_PAGE}`, `GET ${chunkUrl('a05')}`, `GET ${chunkUrl('a04')}`,
      `GET ${VIEW_CHUNK}`, `POST ${TRACX_PAGE} ${FRESH}`]);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal && init.redirect === 'manual')).toBe(true);
    expect(stepsOf(recorder.step)).toEqual([['direct', 'schema'], ['action', 'ok']]);
    fetcher.mockClear();
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(calls()).toEqual([`POST ${TRACX_PAGE} ${FRESH}`]);
    // A missing parcel is an answer too: the id stays.
    const unknown = site({ unknown: () => reply(text('not-found.rsc')) });
    const known = new TracxTracker({ fetcher: unknown.fetcher, action: FRESH.replace('7f', '7e') });
    await expect(known.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    unknown.fetcher.mockClear();
    await expect(known.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown.calls()).toEqual([`POST ${TRACX_PAGE} ${FRESH.replace('7f', '7e')}`]);
  });

  it('takes the page Next returns for an action it no longer has as a changed id, not as a missing parcel', async () => {
    const { fetcher, calls } = site({ unknown: () => reply(text('page.html'), 200, HTML) });
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(calls().at(-1)).toBe(`POST ${TRACX_PAGE} ${FRESH}`);
    // A missing page is the tracker being away, never a missing parcel.
    const gone = site({ unknown: () => new Response('Not Found', { status: 404 }), page: () => new Response('Not Found', { status: 404 }) });
    await expect(carrier(gone.fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport', status: 404 });
    expect(gone.calls()).toEqual([`POST ${TRACX_PAGE} ${TRACX_ACTION}`]);
    const away = site({ page: () => new Response('Not Found', { status: 404 }) });
    await expect(carrier(away.fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport', status: 404 });
    expect(away.calls()).toEqual([`POST ${TRACX_PAGE} ${TRACX_ACTION}`, `GET ${TRACX_PAGE}`]);
  });

  it('goes back to its own id when the one it read expires or stops answering', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { state, fetcher, calls } = site();
      const tracker = new TracxTracker({ fetcher });
      await tracker.fetch(DELIVERED);
      vi.setSystemTime(Date.now() + 6 * 3_600_000 + 1);
      fetcher.mockClear();
      await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
      expect(calls()[0]).toBe(`POST ${TRACX_PAGE} ${TRACX_ACTION}`);
      // A release that brings the built-in id back.
      state.live = TRACX_ACTION;
      state.chunks[VIEW_CHUNK] = text('view-chunk.js').replace(FRESH, TRACX_ACTION);
      fetcher.mockClear();
      await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
      expect(calls().filter(call => call.startsWith('POST'))).toEqual([`POST ${TRACX_PAGE} ${FRESH}`, `POST ${TRACX_PAGE} ${TRACX_ACTION}`]);
      fetcher.mockClear();
      await tracker.fetch(DELIVERED);
      expect(calls()).toEqual([`POST ${TRACX_PAGE} ${TRACX_ACTION}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails as a changed lookup, never as a missing parcel, when the page binds no new id to it', async () => {
    const view = text('view-chunk.js');
    for (const change of [
      { chunks: { [VIEW_CHUNK]: view.replace('"getTrackingHistory"', '"getTrackingHistoryV2"') } },
      { chunks: { [VIEW_CHUNK]: view.replace(`createServerReference)("${FRESH}"`, 'createServerReference)(id') } },
      { chunks: { [VIEW_CHUNK]: view.replace(FRESH, TRACX_ACTION) } },
      { page: () => reply(text('page.html').replace(/TrackingContent/g, 'OtherContent').replace(/<script src=[^>]*><\/script>/g, ''), 200, HTML) },
      { live: '' },
    ] satisfies Partial<Site>[]) {
      const { fetcher, calls } = site(change);
      await expect(carrier(fetcher).track({ number: DELIVERED }), JSON.stringify(change))
        .rejects.toMatchObject({ kind: 'schema', message: expect.stringContaining('the tracking lookup changed') });
      expect(calls().filter(call => call.startsWith('POST')).length).toBeLessThanOrEqual(2);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('keeps a browser check, a failed connection and an oversized page or chunk as they are', async () => {
    const checked = site({ page: () => reply(CHECK, 200, 'text/html') });
    await expect(carrier(checked.fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    const refused = site({ page: () => reply('<html><body>Forbidden</body></html>', 403, 'text/html') });
    await expect(carrier(refused.fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    // A page that fails to load is read again by the retry, which then asks with the new id.
    const flaky = site();
    let failed = false;
    const page = flaky.state.page;
    flaky.state.page = () => {
      if (failed) return page();
      failed = true;
      throw new TypeError('fetch failed');
    };
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TracxTracker({ fetcher: flaky.fetcher, recorder }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(stepsOf(recorder.step)).toEqual([['direct', 'schema'], ['action', 'transport'], ['retry', 'ok']]);
    expect(flaky.calls().at(-1)).toBe(`POST ${TRACX_PAGE} ${FRESH}`);
    const large = site({ chunks: { [chunkUrl('a05')]: DECOY.padEnd(700_000) } });
    await expect(carrier(large.fetcher).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
    const bulky = site({ page: () => reply('<html>'.padEnd(700_000), 200, HTML) });
    await expect(carrier(bulky.fetcher).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('reads the page and its chunks inside the lookup’s budget and signal', async () => {
    const { fetcher } = site();
    const hanging = vi.fn<typeof fetch>((input, init) => init?.method === 'GET'
      ? new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); })
      : fetcher(input, init));
    await expect(carrier(hanging).track({ number: DELIVERED }, { budgetMs: 40.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(hanging.mock.calls.filter(([, init]) => init?.method === 'GET').every(([, init]) => init?.signal?.aborted)).toBe(true);
    const cancelled = new AbortController();
    const stop = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'GET') cancelled.abort(new Error('cancelled'));
      return fetcher(input, init);
    });
    await expect(carrier(stop).track({ number: DELIVERED }, { signal: cancelled.signal })).rejects.toThrow();
    expect(stop.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('lists the view’s chunks across the page’s streamed pieces, binds only the history lookup’s id and reads a few chunks at most', async () => {
    const page = text('page.html');
    expect(viewChunks(page, TRACX_PAGE)).toEqual(['a01', 'a02', 'a03', 'a04', 'a05'].map(chunkUrl));
    // Without the view's row, the page's own module scripts, never polyfills or another origin's.
    expect(viewChunks(page.replace(/TrackingContent/g, 'OtherContent'), TRACX_PAGE)).toEqual(['b01', 'a01', 'a02', 'a03'].map(chunkUrl));
    expect(lookupActionId(text('view-chunk.js'))).toBe(FRESH);
    expect(lookupActionId(DECOY)).toBeUndefined();
    const many = Array.from({ length: 12 }, (_, index) => `/_next/static/chunks/${String(index).padStart(16, '0')}.js`);
    const html = `<script>self.__next_f.push([1,"e:I[1,[${many.map(path => `\\"${path}\\"`).join(',')}],\\"TrackingContent\\"]\\n"])</script>`;
    const read = vi.fn(async () => DECOY);
    await expect(discoverActionId(html, TRACX_PAGE, read)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(MAX_CHUNKS);
    expect(read.mock.calls[0]).toEqual([`https://www.tracxlogis.com${many.at(-1)}`]);
  });
});

describe('TracX Logis status vocabulary', () => {
  it('maps every code and wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(tracxMappedStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(tracxStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'tracx-logis', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    for (const code of ['constructor', 'toString', 'SC', 'L30', 'Z99', ':RO', '']) expect(tracxMappedStage(code), code).toBeUndefined();
    expect(statusMap.stage(null, 'delivery completed')).toBeUndefined();
    expect(tracxStage('', '')).toBeNull();
  });
});
