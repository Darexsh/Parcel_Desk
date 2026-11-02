import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, YWE_API, YWE_PAGE, yweLookupUrl, YweTracker } from './adapter.js';
import { normalizeYweNumber, parseYwe } from './parser.js';
import { statusMap, yweStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'YWE99000000000001';
const UNKNOWN = 'YWE99000000000002';

type Row = Record<string, unknown>;
type Entry = Row & { events: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Entry[];
const changed = (change: (entry: Entry, reply: Entry[]) => void) => {
  const reply = fixture('returned');
  change(reply[0]!, reply);
  return reply;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// 2026-05-16 15:00:00 UTC.
const scan = (message: unknown, extra: Row = {}) => ({ message, timestamp: Date.UTC(2026, 4, 16, 15), timeZone: '-07:00',
  location: { address1: '', address2: '', city: 'SAMPLE TOWN', state: 'CA', country: 'US' }, category: 'Transit', operationTip: '19', ...extra });

describe('YWE HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('returned')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new YweTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ywe 9900 0000 0000 01 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YWE_API);
    expect([...asked.searchParams]).toEqual([['label', PARCEL]]);
    expect(String(url)).toBe(yweLookupUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${YWE_PAGE}?label=${PARCEL}`, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ywe', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the scans at the offsets the tracker states, with their places and codes and without the street lines', () => {
    const result = parseYwe(fixture('returned'), PARCEL);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Returned to sender, shipment has been received in sender warehouse.', last_update: '2026-05-23T08:34:37-07:00',
      expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-05-23T08:34:37-07:00', 'EXAMPLE HUB CITY, CA, US', 'Returned to sender, shipment has been received in sender warehouse.', '18', 'returned'],
      ['2026-05-23T08:25:12-07:00', 'EXAMPLE STATION CITY, CA, US', 'Return to sender', '17', 'exception'],
      ['2026-05-10T21:28:15-07:00', 'EXAMPLE TOWN, CA, US',
        'Parcel delivery abnormal [Restricted Address].Parcel will be returned to the warehouse.', '08', 'failed_attempt'],
      // The row listed twice counts once.
      ['2026-05-10T21:15:22-07:00', 'EXAMPLE TOWN, CA, US', 'Parcel is out for delivery.', '03', 'out_for_delivery'],
      ['2026-05-10T07:09:18-07:00', 'EXAMPLE STATION CITY, CA, US', 'Parcel received by local Facility.', '67', 'in_transit'],
      ['2026-05-09T09:45:44-07:00', 'EXAMPLE HUB CITY, CA, US', 'Parcel departed from Facility.', '19', 'in_transit'],
      ['2026-05-08T14:13:45-07:00', 'EXAMPLE HUB CITY, CA, US', 'Parcel received by in LAX01.', '01', 'accepted'],
      ['2026-05-08T11:44:31-07:00', 'EXAMPLE HUB CITY, CA, US', 'Container picked up by YWE,LAX01 Awaiting Item.', '33', 'accepted'],
      ['2026-05-08T11:44:28-07:00', 'EXAMPLE HUB CITY, CA, US', 'Container received', '25', 'accepted'],
      ['2026-05-08T11:14:11-07:00', 'EXAMPLE HUB CITY, CA, US', 'Container picked up by YWE,LAX01 Awaiting Item.', '67', 'accepted'],
      ['2026-05-08T01:00:00-07:00', 'EXAMPLE HUB CITY, CA, US', 'Shipping Order Created.', '11', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['PRIVATE', 'Returned"', 'Alert', 'Awaiting"']) expect(json).not.toContain(excluded);
  });

  it('maps the recorded wording whatever hub, reason or place it names, and stages new wording through the shared rules', () => {
    expect(yweStage('Container picked up by YWE,JFK02 Awaiting Item.')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(yweStage('Parcel received by in ORD01.')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(yweStage('Parcel received by SFO02.')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    // A failed delivery goes back to YWE's warehouse, not to the sender, with or without a space after its full stop.
    for (const wording of ['Parcel delivery abnormal [Business Closed].Parcel will be returned to the warehouse.',
      'Parcel delivery abnormal [No Access]. Parcel will be returned to the warehouse.',
      'Parcel delivery failed [Rejected Package]. Parcel will be returned to the warehouse.',
      'Parcel delivery failed [Sample Reason].Parcel will be returned to the warehouse.']) {
      expect(yweStage(wording), wording).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe('failed_attempt');
    }
    expect(yweStage('Parcel has been delivered.(Sample Place)')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const wording of ['Parcel received by transit facility.', 'In processing at transit facility.', 'In transit to next facility.']) {
      expect(yweStage(wording)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    }
    // The place a delivery was left stays in its wording.
    const left = parseYwe(changed((entry) => {
      entry.events = [scan('Parcel has been delivered.(Sample Place)', { timestamp: Date.UTC(2026, 4, 16, 16), category: 'Deliverd', operationTip: '07' })];
    }), PARCEL);
    expect(left).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been delivered.(Sample Place)', delivered_at: '2026-05-16T09:00:00-07:00' });
    const worded = parseYwe(changed((entry) => {
      entry.events = [scan('Delivered, signed by SAMPLE RECIPIENT', { timestamp: Date.UTC(2026, 4, 16, 16), category: 'Deliverd', operationTip: '04' }),
        scan('Parcel is out for delivery.'), scan('Sample Status Note', { timestamp: Date.UTC(2026, 4, 16, 14), operationTip: 'A1' })];
    }), PARCEL);
    expect(worded.events!.map((event) => [event.description, event.provider_code, event.stage, event.stage_source])).toEqual([
      ['Delivered', '04', 'delivered', 'wording:language'], ['Parcel is out for delivery.', '19', 'out_for_delivery', 'carrier_map'],
      ['Sample Status Note', undefined, undefined, undefined]]);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      delivered_at: '2026-05-16T09:00:00-07:00' });
    expect(JSON.stringify(worded)).not.toContain('SAMPLE RECIPIENT');
    const unstaged = parseYwe(changed((entry) => { entry.events = [scan('Sample Status Note')]; }), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status Note' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('checks every clock and offset, and keeps a scan without a place', () => {
    for (const extra of [{ timeZone: '' }, { timeZone: null }, { timeZone: 'America/Los_Angeles' }, { timeZone: '-0700' }, { timeZone: '+15:00' },
      { timeZone: '-07:60' }, { timestamp: '1778900000000' }, { timestamp: 1.5e12 + 0.5 }, { timestamp: Date.UTC(1999, 11, 31) },
      { timestamp: Date.UTC(2100, 0, 1) }, { timestamp: null }]) {
      expect(() => parseYwe(changed((entry) => { entry.events = [scan('Parcel departed from Facility.', extra)]; }), PARCEL), JSON.stringify(extra))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const east = parseYwe(changed((entry) => { entry.events = [scan('Parcel departed from Facility.', { timeZone: '+05:30', location: null })]; }), PARCEL);
    expect(east.events).toEqual([{ time: '2026-05-16T20:30:00+05:30', description: 'Parcel departed from Facility.', provider_code: '19',
      stage: 'in_transit', stage_source: 'carrier_map' }]);
  });

  it('reads an entry without scans as no history, and drops rows without wording', () => {
    expect(() => parseYwe(fixture('no-history'), UNKNOWN)).toThrow(NoHistoryError);
    expect(() => parseYwe(changed((entry) => { entry.events = []; }), PARCEL)).toThrow(NoHistoryError);
    expect(() => parseYwe(changed((entry) => { (entry as Row).events = null; }), PARCEL)).toThrow(NoHistoryError);
    expect(() => parseYwe(changed((entry) => { entry.events = [scan(''), scan(null)]; }), PARCEL)).toThrow(NoHistoryError);
  });

  it('reads only the entry that names the whole number asked, and rejects a changed reply', () => {
    for (const change of [
      (entry: Entry) => { entry.expressCode = UNKNOWN; },
      (entry: Entry) => { entry.expressCode = `${PARCEL}1`; },
      (entry: Entry, whole: Entry[]) => { whole.push({ ...entry }); },
      (_entry: Entry, whole: Entry[]) => { whole.length = 0; },
      (entry: Entry) => { (entry as Row).events = 'scans'; },
      (entry: Entry) => { (entry as Row).events = ['scan']; },
      (entry: Entry) => { entry.events = [scan(7)]; },
      (entry: Entry) => { entry.events = [scan('Parcel departed from Facility.', { location: 'SAMPLE TOWN' })]; },
      (entry: Entry) => { entry.events = [scan('Parcel departed from Facility.', { location: { city: 7 } })]; },
      (entry: Entry) => { entry.events = Array.from({ length: 501 }, () => scan('Parcel departed from Facility.')); },
    ]) expect(() => parseYwe(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, {}, 'reply', { status: 400, error: 'Bad Request' }]) {
      expect(() => parseYwe(payload, PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // Another number's entry beside the one asked is left alone.
    const both = changed((_entry, whole) => { whole.unshift({ expressCode: UNKNOWN, events: [scan('Sample Status Note')] }); });
    expect(parseYwe(both, PARCEL)).toMatchObject({ current_stage: 'returned' });
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseYwe(changed((entry) => {
      entry.events = Array.from({ length: 120 }, (_, index) => scan('Parcel departed from Facility.', { timestamp: Date.UTC(2026, 4, 10, 0, index) }));
    }), PARCEL);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-05-09T18:59:00-07:00' });
  });

  it('keeps scans of one second in the tracker’s order, reversed when it lists them oldest first', () => {
    const result = parseYwe(changed((entry) => {
      entry.events[1]!.timestamp = entry.events[0]!.timestamp;
      entry.events.reverse();
    }), PARCEL);
    expect(result.events!.slice(0, 3).map((event) => event.provider_code)).toEqual(['18', '17', '08']);
  });

  it('keeps a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('no-history'))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The lookup answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(text('no-history'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.yanwenexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script src="/challenge.js"></script><script>var awsWafCookieDomainList=[]</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The tracking page, or an empty body, in place of the lookup's JSON.
    await expect(lookup('<!doctype html><html><head><title>Tracking</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[400, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers outside YWE’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YWE9900000000001', 'YWE990000000000001', 'YWX99000000000001', 'YWE9900000000000A', 'SAMPLETRACKING', `YWE${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeYweNumber('ywe 9900-0000-0000-01')).toBe(PARCEL);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('returned')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(carrier(large).track({ number: PARCEL })).rejects.toThrow('unexpectedly large');
  });

  it('answers a number detection names YWE for', async () => {
    expect(detectCarrierMatch(PARCEL)).toMatchObject({ carrier: 'ywe', confidence: 'high', candidates: ['ywe'] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(YWE_API)
      ? reply(text('returned')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ywe', source: 'ywe', result: { current_stage: 'returned' } });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(YWE_API)).map(([url]) => String(url))).toEqual([yweLookupUrl(PARCEL)]);
  });
});

describe('YWE status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ywe', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(yweStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'ywe', providerCode: null, description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Sample Status Note']) expect(yweStage(wording), wording).toBeNull();
  });
});
