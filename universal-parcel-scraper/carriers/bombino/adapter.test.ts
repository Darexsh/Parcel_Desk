import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BOMBINO_API, BombinoTracker } from './adapter.js';
import { normalizeBombinoNumber, parseBombino } from './parser.js';
import { bombinoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '0000000001';
const IN_TRANSIT = '0000000002';
const UNKNOWN = '0000000000';

type Row = Record<string, unknown>;
type Reply = Row & { docket_info: unknown[][]; docket_events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (event_state: string, event_at: string, event_description: string, extra: Row = {}): Row => ({
  event_description, event_location: 'MUMBAI', event_at, event_state, event_remark: '', ...extra });

describe('Bombino Express HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole air waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BombinoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BOMBINO_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bombino', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered history on its wall clocks, once per scan, without the shipment’s people or papers', () => {
    const result = parseBombino(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPMENT DELIVERED', last_update: null, last_update_local: '2026-03-12T14:05:10',
      expected_delivery: null, destination_country: 'GB' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-03-12T14:05:10', 'delivered', 'delivered', 'LONDON'],
      ['2026-03-12T08:40:00', 'drs', 'out_for_delivery', 'LONDON'],
      ['2026-03-11T17:22:41', 'undelivered', 'failed_attempt', 'LONDON'],
      ['2026-03-11T09:02:13', 'drs', 'out_for_delivery', 'LONDON'],
      // Cleared customs keeps its state's stage; a customs hold is customs, not the hold's exception.
      ['2026-03-10T19:15:00', 'in_transit', 'in_transit', 'LONDON'],
      ['2026-03-09T11:30:00', 'shipment_hold', 'customs', 'LONDON'],
      ['2026-03-09T06:12:44', 'incoming_manifest', 'in_transit', 'LONDON'],
      ['2026-03-07T23:50:02', 'manifest', 'in_transit', 'MUMBAI'],
      // The repeated arrival is kept once.
      ['2026-03-07T15:20:31', 'in_scan', 'in_transit', 'MUMBAI'],
      ['2026-03-07T12:01:09', 'pickup_scan', 'accepted', 'MUMBAI'],
      ['2026-03-06T18:44:20', 'entry', 'registered', 'MUMBAI'],
    ]);
    expect(result.events![5]).toMatchObject({ stage_source: 'wording:language' });
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(JSON.stringify(result)).not.toMatch(/ASHA|SAMPLETON|SAMPLE-REF|example\.invalid|00000 000000|2\.500|0000000001\d{2}/);
  });

  it('names the forwarding partner and its number when the partner’s link carries it, with the estimate', () => {
    const result = parseBombino(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'SHIPMENT FORWARDED TO FEDEX',
      last_update_local: '2026-05-04T10:12:00', expected_delivery: '2026-05-08', destination_country: 'US',
      delivery_carrier: 'fedex', delivery_tracking_number: '100000000001' });
    // A hold until the account is settled, then the unhold without the reply's trailing dash.
    expect(result.events!.slice(3, 5).map((event) => [event.description, event.stage])).toEqual([
      ['SHIPMENT UNHOLD', 'in_transit'], ['Shipment Hold Due to Inscan Credit Limit exceeded', 'exception'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE TRADING|SAMPLEVILLE|KARNATAKA|SAMPLE-REF|12\.000/);
  });

  it('leaves the partner out unless one catalog carrier’s link carries the forwarding number', () => {
    for (const [forwarding_no, forwarding_url] of [
      ['100000000001', ''],
      ['100000000001', 'https://www.fedex.com/fedextrack/'],
      ['100000000001', 'https://www.sample-partner.invalid/track?n=100000000001'],
      ['100000000001', 'https://parcelsapp.com/en/tracking/100000000001'],
      [IN_TRANSIT, `https://www.fedex.com/fedextrack/?trknbr=${IN_TRANSIT}`],
      ['', 'https://www.fedex.com/fedextrack/?trknbr=100000000001'],
    ]) {
      const result = parseBombino(changed('in-transit', (body) => {
        Object.assign(body, { forwarding_no, forwarding_url });
        body.docket_info = body.docket_info.filter((row) => row[0] !== 'Forwarding No.');
      }), IN_TRANSIT);
      expect(result, forwarding_url).not.toHaveProperty('delivery_carrier');
      expect(result, forwarding_url).not.toHaveProperty('delivery_tracking_number');
    }
    // The shipment's details name the forwarding number too.
    const detailed = parseBombino(changed('in-transit', (body) => { body.forwarding_no = ''; }), IN_TRANSIT);
    expect(detailed).toMatchObject({ delivery_carrier: 'fedex', delivery_tracking_number: '100000000001' });
  });

  it('reads a return, a scan without wording or state, and a name in a scan’s wording', () => {
    const returned = parseBombino(changed('in-transit', (body) => {
      body.docket_events.unshift(scan('rto', '2026-05-06 09:00:00', 'SHIPMENT RTO DUE TO AS PER SHIPPER INSTRUCTION'));
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', expected_delivery: null });
    const result = parseBombino(changed('delivered', (body) => {
      body.docket_events.unshift(
        scan('', '2026-03-13 10:00:00', 'SHIPMENT DELIVERED TO ASHA SAMPLE'),
        scan('re_drs', '2026-03-13 09:00:00', ''),
        scan('sample_state', '2026-03-13 08:00:00', 'SYNTHETIC NOTE'),
      );
    }), DELIVERED);
    expect(result.events!.slice(0, 3).map((event) => [event.description, event.provider_code ?? null, event.stage ?? null, event.stage_source ?? null])).toEqual([
      ['SHIPMENT DELIVERED TO', null, 'delivered', 'wording:language'],
      ['Out for delivery', 're_drs', 'out_for_delivery', 'carrier_map'],
      ['SYNTHETIC NOTE', 'sample_state', null, null],
    ]);
  });

  it('puts a history in newest-first order by wall clock, keeping the reply’s order within a second', () => {
    const result = parseBombino(changed('in-transit', (body) => {
      body.docket_events.reverse();
      body.docket_events.push(scan('manifest', '2026-05-02 02:15:00', 'SHIPMENT BAGGED FOR DEPARTURE'));
    }), IN_TRANSIT);
    expect(result.last_status_text).toBe('SHIPMENT FORWARDED TO FEDEX');
    expect(result.events!.slice(2, 4).map((event) => event.description)).toEqual(['SHIPMENT BAGGED FOR DEPARTURE', 'FLIGHT DEPARTED']);
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'entry' });
  });

  it('reads the lookup’s message alone as not found, and anything else without a shipment as inconclusive', () => {
    expect(() => parseBombino(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBombino({ errors: ['No tracking data found.'] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [
      { errors: ['Service temporarily unavailable'], docket_info: [], docket_events: [] },
      { errors: true, docket_info: [], docket_events: [] },
      changed('delivered', (data) => { data.errors = ['No tracking data found']; }),
      changed('delivered', (data) => { data.docket_events = []; }),
    ]) expect(() => parseBombino(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseBombino(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Bombino Express answered for another shipment' }));
    // The details' air waybill stands in for a missing top-level number.
    expect(parseBombino(changed('in-transit', (body) => { delete body.tracking_no; }), IN_TRANSIT).events).toHaveLength(7);
    expect(() => parseBombino(changed('in-transit', (body) => { body.tracking_no = `${IN_TRANSIT}1`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBombino(changed('in-transit', (body) => {
      delete body.tracking_no;
      body.docket_info = body.docket_info.filter((row) => row[0] !== 'AWB No.');
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { body.errors = 'none'; },
      (body: Reply) => { body.errors = [404]; },
      (body: Reply) => { body.tracking_no = 2; },
      (body: Reply) => { body.docket_info = 'details' as never; },
      (body: Reply) => { body.docket_events = 'events' as never; },
      (body: Reply) => { body.docket_events = Array.from({ length: 501 }, () => body.docket_events[0]!); },
      (body: Reply) => { body.docket_events[0] = 'scan' as never; },
      (body: Reply) => { body.docket_events[0]!.event_at = '04/05/2026 10:12'; },
      (body: Reply) => { body.docket_events[0]!.event_at = '2026-05-04 24:00:00'; },
      (body: Reply) => { body.docket_events[0]!.event_at = '2026-02-30 10:12:00'; },
      (body: Reply) => { delete body.docket_events[0]!.event_at; },
      (body: Reply) => { body.docket_events[0]!.event_state = 'in transit!'; },
      (body: Reply) => { body.docket_events[0]!.event_description = ['SHIPMENT ARRIVED']; },
      (body: Reply) => { body.docket_events[0]!.event_description = ''; body.docket_events[0]!.event_state = ''; },
      (body: Reply) => { body.consignee_country = { code: 'US' }; },
      (body: Reply) => { body.forwarding_url = 7; },
    ]) {
      expect(() => parseBombino(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBombino([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>404: This page could not be found.</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 308, headers: { Location: 'https://www.bombinoexp.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    const checkpoint = '<html><title>Vercel Security Checkpoint</title></html>';
    await expect(lookup(checkpoint, { status: 429, headers: { 'Content-Type': 'text/html', 'x-vercel-mitigated': 'challenge' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(checkpoint, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{}', { headers: { 'x-vercel-mitigated': 'challenge' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup('<html><title>Bombino Express</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known air waybill, and asks nothing for a number Bombino does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Bombino does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000', '00000000000', '000000000101', 'BOM0000001', `${'0'.repeat(65)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBombinoNumber('000-000-0001')).toBe(DELIVERED);
    expect(normalizeBombinoNumber('0000001')).toBe('0000001');
  });

  it('retries a read that fails to reach the site once, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Bombino Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'bombino' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bombino', source: 'bombino', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${BOMBINO_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Bombino Express numbers', () => {
  it('claims no bare digit run', () => {
    for (const number of ['0000001', '00000001', '000000001', DELIVERED]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('bombino');
      expect(detectCarrierMatch(number).candidates, number).not.toContain('bombino');
    }
  });
});

describe('Bombino Express status vocabulary', () => {
  it('records every state and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(bombinoStage(entry.code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // The reply's snake case and the page's compact keys are one state.
    expect(statusMapAnswer({ carrier: 'bombino', providerCode: 'shipment_hold', description: 'Shipment Hold Due to Pending Documents' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'bombino', providerCode: 'incoming-transfer-manifest', description: 'SHIPMENT ARRIVED' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'bombino', providerCode: 'in_transit', description: 'CLEARANCE IN PROGRESS' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'bombino', providerCode: 'sample_state', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(bombinoStage('in_transit', 'CLEARED FROM CUSTOMS')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(bombinoStage('', 'OUT FOR DELIVERY')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(bombinoStage('sample_state', 'Synthetic note')).toBeNull();
  });
});
