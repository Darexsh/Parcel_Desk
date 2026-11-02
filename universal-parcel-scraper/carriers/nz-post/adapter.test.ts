import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, NzPostTracker } from './adapter.js';
import { normalizeNzPostNumber, parseNzPost } from './parser.js';
import { classifyNzPostStatus } from './status.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '00000000000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const payload = () => structuredClone(fixture);
const absent = () => ({ success: true, status_code: 2, results: [{ tracking_reference: NUMBER,
  errors: [{ code: 400002, message: 'Invalid parameter(s)', details: 'No data found for this Tracking Reference' }] }] });

describe('NZ Post exact-reference projection', () => {
  it('returns actual scans, UTC instants and depot names while excluding recipient fields', () => {
    const result = normalizeCarrierResult(parseNzPost(payload(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-06T12:00:00Z',
      delivered_at: '2026-01-06T12:00:00Z', expected_delivery: null });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.[0]).toMatchObject({ location: 'Example Depot', description: 'Delivered', provider_code: '22' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|signed_by|seqref|run_name|source/);
    const declared = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const evidence: Record<string, boolean> = { history: Boolean(result.events?.length),
      location: Boolean(result.events?.[0]?.location), delivered_at: Boolean(result.delivered_at) };
    for (const capability of declared.capabilities) expect(evidence[capability], capability).toBe(true);
  });

  it('rejects unrelated, duplicated or expanded references and malformed envelopes', () => {
    const wrong = payload(); wrong.results[0].tracking_reference = '00000000000000000002';
    const punctuation = payload(); punctuation.results[0].tracking_reference = '0000000000 0000000001';
    const duplicates = payload(); duplicates.results.push(duplicates.results[0]);
    for (const value of [null, {}, { success: true, status_code: 1 }, wrong, punctuation, duplicates]) {
      expect(() => parseNzPost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const padding = payload(); padding.results[0].tracking_reference = ` ${NUMBER} `;
    expect(parseNzPost(padding, NUMBER).status).toBe('delivered');
  });

  it('accepts only the identity-bound absence signature and leaves unknown outcomes inconclusive', () => {
    expect(() => parseNzPost(absent(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const generic = absent(); generic.results[0]!.errors[0]!.details = 'Invalid reference';
    const incomplete = absent(); incomplete.results[0]!.errors.push(incomplete.results[0]!.errors[0]!);
    const mixed = { ...absent(), results: [{ ...absent().results[0], tracking_events: [] }] };
    const empty = payload(); empty.results[0].tracking_events = [];
    for (const value of [generic, incomplete, mixed, empty, { success: false, status_code: 2 },
      { success: true, status_code: 1, results: [] }]) {
      expect(() => parseNzPost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const wrong = absent(); wrong.results[0]!.tracking_reference = '00000000000000000002';
    expect(() => parseNzPost(wrong, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['2026-02-30T12:00:00Z', '2026-01-06T12:00:00+02:99', '2026-01-06T12:00:00+99:00', '12:00', '', null])(
    'keeps an unresolved newest clock %s from borrowing an older timestamp', (clock) => {
      const value = payload(); value.results[0].tracking_events.at(-1).date_time = clock;
      const result = parseNzPost(value, NUMBER);
      expect(result.status).toBe('delivered'); expect(result.last_update).toBeNull();
      expect(result.events?.[0]!.description).toBe('Delivered');
      expect(result.events?.[0]).not.toHaveProperty('time'); expect(result).not.toHaveProperty('delivered_at');
      if (clock) expect(result.events?.[0]).toMatchObject({ provider_time_text: clock });
    });

  it('preserves offsetless clocks, unknown latest status, stable ties and exact duplicate scans', () => {
    const local = payload(); local.results[0].tracking_events.at(-1).date_time = '2026-01-06T12:00:00';
    expect(parseNzPost(local, NUMBER)).toMatchObject({ last_update: null, last_update_local: '2026-01-06T12:00:00' });
    const unknown = payload(); Object.assign(unknown.results[0].tracking_events.at(-1), { status: 'Unmapped provider scan', edifact_code: '__proto__' });
    expect(parseNzPost(unknown, NUMBER)).toMatchObject({ status: 'unknown' });
    expect(parseNzPost(unknown, NUMBER)).not.toHaveProperty('current_stage');
    expect(parseNzPost(unknown, NUMBER).events?.[0]).not.toHaveProperty('stage');
    expect(classifyNzPostStatus('constructor')).toBeUndefined();
    const duplicate = payload(); duplicate.results[0].tracking_events.push({ ...duplicate.results[0].tracking_events.at(-1), seqref: 'another' });
    expect(parseNzPost(duplicate, NUMBER).events).toHaveLength(5);
    const tie = payload(); tie.results[0].tracking_events.at(-1).date_time = tie.results[0].tracking_events.at(-2).date_time;
    expect(parseNzPost(tie, NUMBER).events?.[0]!.description).toBe('Delivered');
  });

  it('takes back the Auckland clock NZ Post reads a scan abroad on, after the item leaves New Zealand', () => {
    const item = 'ZZ123456785NZ';
    const scan = (date_time: string, edifact_code: string, status: string, depot_name?: string) =>
      ({ date_time, edifact_code, status, ...(depot_name ? { depot_name } : {}), source: 'IPS' });
    const events = [
      scan('2026-08-06T01:55:10Z', '5007', 'International departure', 'EXAMPLE CITY'),
      scan('2026-08-07T09:23:00Z', '5064', 'In transit with airline', 'Hong Kong'),
      scan('2026-08-07T10:23:00Z', '5283', 'In transit with airline', 'Guangzhou'),
      scan('2026-08-08T21:05:00Z', '5015', 'International arrival', 'Hong Kong'),
      scan('2026-08-14T00:47:00Z', '5019', 'Held for clearance', 'EXAMPLE CITY'),
    ];
    const parse = (scans: typeof events) =>
      parseNzPost({ success: true, status_code: 1, results: [{ tracking_reference: item, tracking_events: scans }] }, item);
    const result = parse(events);
    // Hong Kong keeps one clock, which the scan at a town borrows. The departure and the airline's scans are as sent.
    expect(result.events?.map(event => event.time ?? `local ${String(event.local_time)}`)).toEqual([
      '2026-08-14T12:47:00+08:00', '2026-08-09T09:05:00+08:00', '2026-08-07T10:23:00Z', '2026-08-07T09:23:00Z', '2026-08-06T01:55:10Z']);
    expect(result).toMatchObject({ last_update: '2026-08-14T12:47:00+08:00' });
    // A scan at a town borrows the country of the nearest earlier scan naming one, an airline's included.
    const towns = parse(events.map(scan => scan.edifact_code === '5015' ? { ...scan, depot_name: 'EXAMPLE CITY' } : scan));
    expect(towns.events?.slice(0, 2).map(event => event.time)).toEqual(['2026-08-14T12:47:00+08:00', '2026-08-09T09:05:00+08:00']);
    const china = parse(events.map(scan => scan.edifact_code === '5015' ? { ...scan, depot_name: 'EXAMPLE CITY' }
      : scan.edifact_code === '5283' ? { ...scan, depot_name: 'China' } : scan));
    expect(china.events?.[0]?.time).toBe('2026-08-14T12:47:00+08:00');
    // A country with several clocks, or none named after the departure, keeps NZ Post's Auckland reading.
    for (const depot of ['United States', undefined]) {
      const unplaced = parse(events.map(scan => scan.edifact_code === '5015' ? { ...scan, depot_name: 'EXAMPLE CITY' }
        : scan.edifact_code.startsWith('5') && scan.edifact_code !== '5007' && scan.edifact_code !== '5019' ? { ...scan, depot_name: depot } : scan));
      expect(unplaced.events?.slice(0, 2).map(event => event.time)).toEqual(['2026-08-14T00:47:00Z', '2026-08-08T21:05:00Z']);
      expect(unplaced).toMatchObject({ last_update: '2026-08-14T00:47:00Z' });
    }
    // An item arriving from abroad is scanned in New Zealand after its departure.
    const inbound = 'ZZ123456785CH';
    expect(parseNzPost({ success: true, status_code: 1, results: [{ tracking_reference: inbound, tracking_events: events }] }, inbound)
      .events?.[0]?.time).toBe('2026-08-14T00:47:00Z');
  });

  it("takes back the Auckland clock NZ Post reads the origin post's scans on, until an item from abroad leaves", () => {
    const scan = (date_time: string, edifact_code: string, status: string, depot_name?: string) =>
      ({ date_time, edifact_code, status, ...(depot_name ? { depot_name } : {}), source: 'IPS' });
    const events = [
      scan('2026-10-01T01:51:00Z', '5000', 'Picked up/Collected'),
      scan('2026-10-08T20:34:00Z', '5002', 'Processed at outbound depot', 'EXAMPLE CITY'),
      scan('2026-10-08T20:57:00Z', '5007', 'International departure', 'EXAMPLE CITY'),
      scan('2026-10-12T00:07:13Z', '5057', 'Pending border clearance', 'AUCKLAND'),
      scan('2026-10-12T05:38:00Z', '5015', 'International arrival', 'AUCKLAND'),
      scan('2026-10-13T23:50:32Z', '5022', 'Delivered'),
    ];
    const parse = (item: string, scans = events) =>
      parseNzPost({ success: true, status_code: 1, results: [{ tracking_reference: item, tracking_events: scans }] }, item);
    // NZ Post read 14:51 at the origin post as 14:51 in Auckland (+13:00). The issuer's country gives the clock back.
    expect(parse('ZZ123456785CN').events?.map(event => [event.time, event.stage])).toEqual([
      ['2026-10-13T23:50:32Z', 'delivered'], ['2026-10-12T05:38:00Z', 'in_transit'], ['2026-10-12T00:07:13Z', 'customs'],
      ['2026-10-09T09:57:00+08:00', 'in_transit'], ['2026-10-09T09:34:00+08:00', 'in_transit'], ['2026-10-01T14:51:00+08:00', 'accepted']]);
    // A depot naming its country outranks the issuer, and a country of several clocks keeps the Auckland reading.
    const named = parse('ZZ123456785CN', events.map(event => event.edifact_code === '5002' ? { ...event, depot_name: 'Japan' } : event));
    expect(named.events?.slice(3).map(event => event.time)).toEqual(['2026-10-09T09:57:00+09:00', '2026-10-09T09:34:00+09:00', '2026-10-01T14:51:00+09:00']);
    expect(parse('ZZ123456785US').events?.slice(3).map(event => event.time)).toEqual(['2026-10-08T20:57:00Z', '2026-10-08T20:34:00Z', '2026-10-01T01:51:00Z']);
    // Without a departure, the origin's leg ends where New Zealand's scans begin.
    expect(parse('ZZ123456785CN', events.filter(event => event.edifact_code !== '5007')).events?.[2]?.time).toBe('2026-10-12T00:07:13Z');
  });

  it('distinguishes pre-advice, pickup availability, failed attempts and unknown codes', () => {
    for (const code of ['205', '206', '997']) expect(classifyNzPostStatus(code)).toMatchObject({ status: 'pending', stage: 'registered' });
    expect(classifyNzPostStatus('141')).toMatchObject({ status: 'in_transit', stage: 'ready_for_pickup' });
    expect(classifyNzPostStatus('42')).toMatchObject({ status: 'exception', stage: 'exception' });
    expect(classifyNzPostStatus('40')?.status).toBe('exception');
    expect(classifyNzPostStatus('new-code')).toBeUndefined();
  });

  it('bounds scans, validates required fields and keeps the newest retained events', () => {
    for (const scan of [null, {}, { status: 'Delivered', edifact_code: '22', date_time: 123 }]) {
      const value = payload(); value.results[0].tracking_events.push(scan);
      expect(() => parseNzPost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const value = payload(); value.results[0].tracking_events = Array.from({ length: 101 }, (_, i) => ({
      status: `Synthetic scan ${i}`, edifact_code: '8', date_time: '',
    }));
    expect(parseNzPost(value, NUMBER).events).toHaveLength(100);
    expect(parseNzPost(value, NUMBER).events?.[0]!.description).toBe('Synthetic scan 100');
    value.results[0].tracking_events = Array(501).fill(value.results[0].tracking_events[0]);
    expect(() => parseNzPost(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('NZ Post courier labels and international mail', () => {
  const LABEL = '0000000000000001ABC001XY';
  const international = () => ({ success: true, status_code: 1, results: [{ tracking_reference: LABEL, tracking_events: [
    { date_time: '2026-01-04T08:00:00Z', status: 'Label created', edifact_code: '5303', depot_name: '(Location Not Available)' },
    { date_time: '2026-01-04T09:00:00Z', status: 'Picked up/Collected', edifact_code: '5000', depot_name: 'Example Post Shop' },
    { date_time: '2026-01-05T09:00:00Z', status: 'International departure', edifact_code: '5007', depot_name: 'EXAMPLE GATEWAY' },
    { date_time: '2026-01-06T09:00:00Z', status: 'In transit with airline', edifact_code: '5283' },
    { date_time: '2026-01-07T09:00:00Z', status: 'With border agency', edifact_code: '5016', depot_name: 'EXAMPLE EMS' },
    { date_time: '2026-01-08T09:00:00Z', status: 'Held for clearance', edifact_code: '5019' },
  ] }] });

  it('tracks the whole courier label, not its digits alone', () => {
    expect(normalizeNzPostNumber(` ${LABEL.toLowerCase()} `)).toBe(LABEL);
    for (const number of [LABEL.slice(0, 16), `${LABEL}1`, '0000000000000001AB1001XY']) {
      expect(() => normalizeNzPostNumber(number)).toThrow(InvalidInputError);
    }
  });

  it('classifies international codes and keeps a held item in customs', () => {
    const result = parseNzPost(international(), LABEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Held for clearance' });
    expect(result.events?.map(event => event.stage)).toEqual(['customs', 'customs', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.at(-1)).not.toHaveProperty('location');
    expect(result.events?.at(-2)).toMatchObject({ location: 'Example Post Shop' });
    expect(classifyNzPostStatus('5023')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(classifyNzPostStatus('6908')).toEqual({ status: 'pending', stage: 'registered' });
    // A carded parcel handed over to an outlet is not yet ready for collection.
    expect(classifyNzPostStatus('144')).toEqual({ status: 'in_transit', stage: 'in_transit' });
  });

  it('lets a stored scan take its code\'s stage and lose the placeholder depot in place', () => {
    expect(sameInstantIdentityPolicy('nz-post')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('nz-post', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['nz-post'], requireProviderCode: true, matchEachScan: true, relabelledFrom: 'Pacific/Auckland' });
    const stored = { stage: 'in_transit', description: 'With border agency', location: 'EXAMPLE EMS', providerCode: '5016' };
    const incoming = { ...stored, stage: 'customs', description: ' with border agency ' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    const placeholder = { stage: 'registered', description: 'Label created', location: '(Location Not Available)', providerCode: '5303' };
    expect(policy?.matches?.({ ...placeholder, location: '' }, placeholder)).toBe(true);
    for (const different of [{ ...stored, location: 'ANOTHER DEPOT' }, { ...stored, providerCode: '5019' },
      { ...stored, description: 'Held for clearance' }, { ...stored, location: '' }]) {
      expect(policy?.matches?.(incoming, different)).toBe(false);
    }
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, { ...stored, providerCode: '' })).toBe(false);
  });
});

describe('NZ Post bounded anonymous transport', () => {
  it('uses one no-store GET and recognizes only evidenced history or absence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(payload())))
      .mockResolvedValueOnce(new Response(JSON.stringify(absent())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-06T12:00:00.000Z' });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://tools.nzpost.co.nz/tracking/api/parceltrack/parcels?tracking_reference=${NUMBER}`);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.has('Authorization')).toBe(false); expect(headers.has('Cookie')).toBe(false);
    expect(normalizeNzPostNumber('rr 000000005 nz')).toBe('RR000000005NZ');
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']])(
    'does not turn HTTP %s into parcel absence', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: Number(status) }));
      await expect(new NzPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('rejects invalid inputs before I/O and bounds response bytes and cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123', 'RR000000006NZ', `${NUMBER}&private=value`]) {
      expect(() => new NzPostTracker({ fetcher }).fetch(number)).toThrow(InvalidInputError);
    }
    await expect(new NzPostTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new NzPostTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Unavailable</html>'));
    await expect(new NzPostTracker({ fetcher: malformed }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
});
