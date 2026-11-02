import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARRIERS } from '../../core/catalog/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CDL_DETAILS, CdlTracker, cdlDetailsUrl } from './adapter.js';
import { cdlRequestNumber } from './number.js';
import { parseCdl } from './parser.js';
import { cdlScanStage, cdlStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const LABEL = 'CDL00000000017';
const ORDER = '100000001-0';
const ABSENT = 'CDL99999999999';
type Payload = Record<string, unknown> & { trackingEvents: Record<string, unknown>[]; trackingInformation: Record<string, unknown> };
const fixture = (name: string): Payload => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Payload;
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const empty = (status = 204) => new Response(null, { status });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
/** The in-transit reply with its newest scan rewritten. */
const newest = (change: Record<string, unknown>): Payload => {
  const payload = fixture('in-transit');
  Object.assign(payload.trackingEvents[0]!, change);
  return payload;
};

describe('CDL tracking adapter', () => {
  it('asks the tracking service once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CdlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cdl 0000 0000 017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://apps.cdldelivers.com/Tracking-Page-API/Tracking/details?value=${LABEL}`);
    expect(String(url)).toBe(cdlDetailsUrl(LABEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cdl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('puts back the hyphen of an order number, which the service matches only as printed', async () => {
    expect(cdlRequestNumber('1000000010')).toBe(ORDER);
    expect(cdlRequestNumber(ORDER)).toBe(ORDER);
    expect(cdlRequestNumber('cdl00000000017')).toBe(LABEL);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: '1000000010' })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${CDL_DETAILS}?value=${ORDER}`);
    // The tracking link carries the printed form too.
    expect(CARRIERS.cdl.trackingUrl?.('1000000010')).toBe(`https://apps.cdldelivers.com/Tracking-Page/track?id=${ORDER}`);
  });

  it('reads a delivered parcel newest first in Eastern time, with the completed delivery last in its minute', () => {
    const result = parseCdl(fixture('delivered'), LABEL);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery complete', last_update: '2026-02-11T10:14:00-05:00', expected_delivery: null,
      delivered_at: '2026-02-11T10:14:00-05:00',
      events: [
        { time: '2026-02-11T10:14:00-05:00', description: 'Delivery complete', location: 'Sampleton, NY', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-02-11T10:14:37-05:00', description: 'Package Scanned at Delivery', location: 'Sampleton, NY',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-02-11T07:02:51.420-05:00', description: 'Package Out For Delivery', location: 'Testville, NJ',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-02-11T02:31:09-05:00', description: 'Package Scanned at Local Delivery Center', location: 'Testville, NJ',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-02-10T21:45:18-05:00', description: 'CDL Origin Scan', location: 'Hubford, NJ', stage: 'accepted', stage_source: 'carrier_map' },
        // The page leaves out where the label was made.
        { time: '2026-02-10T13:08:44.517-05:00', description: 'Label has been created', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // Photos, the driver, the delivery spot and the destination are never read.
    expect(JSON.stringify(result)).not.toMatch(/U1lOVEhF|SYNTHETIC|10001/);
    // A completion with its own seconds keeps its clock's place.
    const timed = fixture('delivered');
    timed.trackingEvents[1]!.trackingEventTimestamp = '2026-02-11T10:14:31';
    timed.trackingEvents.splice(2, 1);
    expect(parseCdl(timed, LABEL)).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Package Scanned at Delivery' });
  });

  it('keeps a parcel the shipper has not handed over registered, and sorts scans by their clocks', () => {
    const result = parseCdl(fixture('in-transit'), '1000000010');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-07-08T00:52:13-04:00' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map(event => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2026-07-08T00:52:13-04:00', 'Package Scanned at Local Delivery Center', 'Sampleton, CT', 'in_transit'],
      ['2026-07-07T19:26:40-04:00', 'CDL Origin Scan', 'Hubford, NJ', 'accepted'],
      ['2026-07-03T12:15:02.250-04:00', 'Awaiting Package From Shipper', 'Sampleton, CT', 'registered'],
      ['2026-07-01T16:40:27.903-04:00', 'Label has been created', undefined, 'registered'],
    ]);
    const shuffled = fixture('in-transit');
    shuffled.trackingEvents.reverse();
    expect(parseCdl(shuffled, ORDER).events).toEqual(result.events);
    const waiting = fixture('in-transit');
    waiting.trackingEvents.splice(0, 2);
    expect(parseCdl(waiting, ORDER)).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Awaiting Package From Shipper' });
  });

  it('keeps scans of one instant in the reply’s order, whichever way it lists them', () => {
    for (const reversed of [false, true]) {
      const payload = fixture('in-transit');
      const scan = (trackingEvent: string) => ({ ...payload.trackingEvents[0], trackingEvent, trackingEventTimestamp: '2026-07-08T07:00:00' });
      payload.trackingEvents.unshift(scan('Package Out For Delivery'), scan('Package Scanned at Local Delivery Center'));
      if (reversed) payload.trackingEvents.reverse();
      expect(parseCdl(payload, ORDER).events!.slice(0, 2).map(event => event.description))
        .toEqual(['Package Out For Delivery', 'Package Scanned at Local Delivery Center']);
    }
  });

  it('reads other flagged wording as a problem and leaves unknown unflagged wording without a stage', () => {
    expect(parseCdl(newest({ trackingEvent: 'DELAYED- Wrong Address', isException: true }), ORDER))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    expect(parseCdl(newest({ trackingEvent: 'DELAYED- Weather', isException: true }), ORDER))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    expect(parseCdl(newest({ trackingEvent: 'Recipient not available', isException: true }), ORDER))
      .toMatchObject({ current_stage: 'failed_attempt', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(parseCdl(newest({ trackingEvent: 'Returned to shipper', isException: false }), ORDER))
      .toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseCdl(newest({ trackingEvent: 'Package Rerouted to Partner', isException: false }), ORDER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Package Rerouted to Partner' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-07-08T00:52:13-04:00', description: 'Package Rerouted to Partner', location: 'Sampleton, CT' });
  });

  it('binds the reply to the whole requested number', () => {
    const lower = fixture('delivered');
    lower.trackingInformation.referenceNumber = ' cdl00000000017 ';
    expect(parseCdl(lower, LABEL)).toMatchObject({ status: 'delivered' });
    // The service matches other fields too: another reference is no answer for this number.
    for (const reference of ['CDL00000000018', 'CDL0000000001', '1000000010', '100000001-1', '10001.021026']) {
      const other = fixture('delivered');
      other.trackingInformation.referenceNumber = reference;
      expect(() => parseCdl(other, LABEL), reference).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const unhyphenated = fixture('in-transit');
    unhyphenated.trackingInformation.referenceNumber = '1000000010';
    expect(() => parseCdl(unhyphenated, ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const reference of [null, 10001, ['CDL00000000017']]) {
      const missing = fixture('delivered');
      missing.trackingInformation.referenceNumber = reference;
      expect(() => parseCdl(missing, LABEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects replies it cannot read and treats a parcel without scans as no history', () => {
    const broken: [string, (payload: Payload) => unknown][] = [
      ['no events', payload => ({ ...payload, trackingEvents: null })],
      ['no information', payload => ({ ...payload, trackingInformation: null })],
      ['too many scans', payload => ({ ...payload, trackingEvents: Array.from({ length: 201 }, () => payload.trackingEvents[0]) })],
      ['scan without wording', payload => { payload.trackingEvents[0]!.trackingEvent = ' '; return payload; }],
      ['scan wording object', payload => { payload.trackingEvents[0]!.trackingEvent = { text: 'Delivery complete' }; return payload; }],
      ['offset clock', payload => { payload.trackingEvents[0]!.trackingEventTimestamp = '2026-07-08T00:52:13Z'; return payload; }],
      ['hour 24', payload => { payload.trackingEvents[0]!.trackingEventTimestamp = '2026-07-08T24:52:13'; return payload; }],
      ['impossible day', payload => { payload.trackingEvents[0]!.trackingEventTimestamp = '2026-02-30T10:52:13'; return payload; }],
      ['date only', payload => { payload.trackingEvents[0]!.trackingEventTimestamp = '07/08/2026'; return payload; }],
      ['city object', payload => { payload.trackingEvents[0]!.eventCity = { name: 'Sampleton' }; return payload; }],
      ['flag text', payload => { payload.trackingEvents[0]!.isException = 'true'; return payload; }],
      ['array', () => [fixture('in-transit')]],
    ];
    for (const [name, change] of broken) {
      expect(() => parseCdl(change(fixture('in-transit')), ORDER), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseCdl({ ...fixture('in-transit'), trackingEvents: [] }, ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes CDL label and order numbers only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CDL0000000001', 'CDL000000000170', 'CDDL00000001', '100000001', '10000000101', '10001.021026',
      '1700000000000ABCDEFG', 'X'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads an empty HTTP 204 as not found and recognizes a known number with its newest scan, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty());
    await expect(carrier(fetcher).recognize!(LABEL)).resolves.toEqual({ known: true, lastActivityAt: '2026-02-11T15:14:37.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps redirects, missing routes, empty replies, block pages and HTTP errors apart from a missing parcel', async () => {
    const cases: [() => Response, string][] = [
      [() => new Response(null, { status: 302, headers: { Location: '/Tracking-Page/' } }), 'indeterminate'],
      [() => reply('Not Found', 404), 'transport'],
      [() => empty(200), 'indeterminate'],
      [() => reply('null'), 'indeterminate'],
      [() => reply('[]', 201), 'indeterminate'],
      [() => reply('<html><body>Server Error in Application.</body></html>'), 'schema'],
      [() => reply('<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>'), 'challenge'],
      [() => reply('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>', 200), 'challenge'],
      [() => reply('Busy', 429), 'rate_limited'],
      [() => reply('Unavailable', 503), 'maintenance'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: LABEL }), kind).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    // A malformed reply's body, which can carry photos and names, stays out of the error.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('{"trackingEvents":[{"vpod":"U1lOVEhF'));
    const error = await carrier(fetcher).track({ number: LABEL }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'schema' });
    expect(JSON.stringify(error)).not.toContain('U1lOVEhF');
  });

  it('sends the read once more after a network failure, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: ORDER }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: ORDER }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a CDL label number to the adapter and asks it about an order number typed with its hyphen', async () => {
    expect(detectCarrierMatch(LABEL)).toMatchObject({ carrier: 'cdl', confidence: 'high' });
    expect(recognitionCandidates(ORDER).map(candidate => candidate.carrier)).toContain('cdl');
    expect(recognitionCandidates('1000000010').map(candidate => candidate.carrier)).not.toContain('cdl');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: LABEL }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'cdl', source: 'cdl', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${CDL_DETAILS}?`))).toBe(true);
  });
});

describe('CDL status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(cdlScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('en-US')), entry.wording).toBe(entry.stage);
      // The map's own wording wins over the exception flag.
      expect(cdlStage(entry.wording, true), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(cdlScanStage('  PACKAGE out for  delivery ')).toBe('out_for_delivery');
    for (const wording of ['constructor', 'toString', 'Delivery', 'Package Scanned']) expect(cdlScanStage(wording), wording).toBeUndefined();
    expect(statusMap.stage('X', 'delivery complete')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'cdl', description: 'Package Scanned at Delivery' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
