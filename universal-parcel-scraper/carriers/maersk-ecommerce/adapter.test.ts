import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MAERSK_API, MAERSK_CONSUMER_KEY, MAERSK_PAGE, MaerskTracker } from './adapter.js';
import { normalizeMaerskNumber, parseMaersk } from './parser.js';
import { maerskStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = '1MEXAMPLE0012345678';
const DELIVERED = '1MEXAMPLE0087654321';

type Row = Record<string, unknown>;
type Reply = Row & { trackingEvents: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (change: (reply: Reply) => void, name = 'in-transit') => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (code: string, description: string, group: string, extra: Row = {}) => ({
  provider: 'Amazon', localDateTime: '2026-04-07T09:00:00', countryCode: 'USA', timeZoneOffset: '-05:00', maerskStatusCode: code,
  maerskStatusDescription: description, maerskTrackingStatusGroup: group, maerskTrackingEventType: 'Consumer', isExceptionEventType: false,
  utcDateTime: '2026-04-07T14:00:00Z', isCarrierEvent: true, ...extra,
});

describe('Maersk eCommerce HTTP adapter', () => {
  it('asks the parcel page’s lookup for the whole number in capitals, with the site’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MaerskTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1mexample 0012 3456 78 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(`${MAERSK_API}${PARCEL}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Consumer-Key': MAERSK_CONSUMER_KEY, Referer: `${MAERSK_PAGE}${PARCEL}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'maersk-ecommerce', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Maersk’s scans as instants with their offsets, the partner’s number, and none of the client’s or recipient’s details', () => {
    const result = parseMaersk(fixture('in-transit'), PARCEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In-Transit Scan', last_update: '2026-04-06T16:10:00Z', expected_delivery: '2026-04-08', service_name: 'Standard',
      destination_country: 'US', delivery_carrier: 'amazon-logistics', delivery_tracking_number: 'TBA000000000001' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-04-06T16:10:00Z', undefined, '77100', 'in_transit'],
      ['2026-04-06T05:34:00Z', undefined, '77105', 'in_transit'],
      // The partner's scan listed twice counts once.
      ['2026-04-05T14:16:00Z', undefined, '77101', 'in_transit'],
      ['2026-04-04T19:54:00-05:00', 'Example City, IL', '72004', 'in_transit'],
      ['2026-04-04T18:45:00-05:00', 'Example City, IL', '72002', 'in_transit'],
      ['2026-04-04T23:39:00Z', undefined, '70001', 'registered'],
      ['2026-04-04T18:39:00-05:00', undefined, '70002', 'accepted'],
      ['2026-04-04T15:22:00-05:00', 'Example City, IL', '72001', 'in_transit'],
      ['2026-04-02T15:45:00Z', undefined, '70000', 'registered'],
    ]);
    expect(result.events!.every((event) => !('local_time' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['ORDER0000000001', 'EXAMPLE1', 'Example Town', '99999', 'MN']) expect(json).not.toContain(excluded);
  });

  it('keeps the wall clock of a partner’s scan that states no offset, and dates no delivery without an instant', () => {
    const result = parseMaersk(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parcel Successfully Delivered',
      last_update: null, last_update_local: '2026-08-13T09:28:00', expected_delivery: null, service_name: 'Home Delivery',
      destination_country: 'AT', delivery_carrier: 'dpd-at', delivery_tracking_number: '06200000000001' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.local_time, event.stage])).toEqual([
      [undefined, '2026-08-13T09:28:00', 'delivered'],
      [undefined, '2026-08-13T06:06:00', 'out_for_delivery'],
      [undefined, '2026-08-13T06:01:00', 'in_transit'],
      [undefined, '2026-08-12T13:33:00', 'in_transit'],
      ['2026-08-11T18:51:00+02:00', undefined, 'in_transit'],
      ['2026-08-11T14:37:00+02:00', undefined, 'in_transit'],
      ['2026-08-10T18:39:00Z', undefined, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toContain('mydpd');
    const dated = parseMaersk(changed((whole) => {
      whole.trackingEvents[0] = { ...whole.trackingEvents[0], timeZoneOffset: '+02:00', utcDateTime: '2026-08-13T07:28:00Z' };
    }, 'delivered'), DELIVERED);
    expect(dated).toMatchObject({ delivered_at: '2026-08-13T09:28:00+02:00', last_update: '2026-08-13T09:28:00+02:00' });
  });

  it('proposes only a partner the catalog tracks whose rule fits the number', () => {
    for (const change of [
      (whole: Reply) => { whole.lastMileCarrier = 'Sample Courier'; },
      (whole: Reply) => { whole.trackingNumber = 'SAMPLE0001'; },
      (whole: Reply) => { whole.lastMileCarrier = 'DPD'; },
    ]) {
      const result = parseMaersk(changed(change), PARCEL);
      expect(result).not.toHaveProperty('delivery_carrier');
      expect(result).not.toHaveProperty('delivery_tracking_number');
    }
    expect(parseMaersk(changed((whole) => { whole.trackingNumber = '1LS000000000001'; whole.lastMileCarrier = 'OnTrac'; }), PARCEL))
      .toMatchObject({ delivery_carrier: 'ontrac', delivery_tracking_number: '1LS000000000001' });
  });

  it('stages an unknown code by its exception flag, then its group, never as a delivery', () => {
    const staged = (row: Row) => parseMaersk(changed((whole) => { whole.trackingEvents.unshift(row); }), PARCEL).events![0]!.stage;
    expect(staged(scan('77999', 'Sample Exception', 'In Transit', { isExceptionEventType: true }))).toBe('exception');
    expect(staged(scan('77998', 'Sample Round', 'Out for Delivery'))).toBe('out_for_delivery');
    expect(staged(scan('77997', 'Sample Status Note', 'Delivered'))).toBeUndefined();
    expect(staged(scan('77996', 'Sample Status Note', 'Sample Group'))).toBeUndefined();
    const unstaged = parseMaersk(changed((whole) => { whole.trackingEvents = [scan('77996', 'Sample Status Note', 'Sample Group')]; }), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status Note' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads a parcel without scans as no history, and rejects a changed reply', () => {
    expect(() => parseMaersk(changed((whole) => { whole.trackingEvents = []; }), PARCEL)).toThrow(NoHistoryError);
    for (const change of [
      (whole: Reply) => { whole.maerskTrackingNumber = DELIVERED; },
      (whole: Reply) => { delete whole.maerskTrackingNumber; },
      (whole: Reply) => { (whole as Row).trackingEvents = null; },
      (whole: Reply) => { whole.trackingEvents[0] = { ...whole.trackingEvents[0], maerskStatusCode: 'SAMPLE' }; },
      (whole: Reply) => { whole.trackingEvents[0] = { ...whole.trackingEvents[0], localDateTime: '2026-04-06 16:10' }; },
      (whole: Reply) => { whole.trackingEvents[0] = { ...whole.trackingEvents[0], timeZoneOffset: '+25:00' }; },
      // A stated offset whose instant is not the reply's UTC clock.
      (whole: Reply) => { whole.trackingEvents[0] = { ...whole.trackingEvents[0], timeZoneOffset: '-05:00' }; },
    ]) expect(() => parseMaersk(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a refused key, a moved route and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: PARCEL });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html>Sample page</html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 401 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.maersk.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html>Sample page</html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses numbers outside Maersk’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1MEXAMPLE001234567', '1MEXAMPLE00123456789', '1M12345670012345678', '2MEXAMPLE0012345678', 'SAMPLETRACKING', `1M${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMaerskNumber('1m-example-0012345678')).toBe(PARCEL);
    expect(normalizeMaerskNumber('1MX1234A90012345678')).toBe('1MX1234A90012345678');
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('in-transit')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
  });
});

describe('Maersk eCommerce numbers', () => {
  it('suggests 1M, a client code and ten digits, and recognition asks the tracker, which files a parcel it knows', async () => {
    expect(detectCarrierMatch(PARCEL)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['maersk-ecommerce'] });
    for (const countryHint of [undefined, 'US', 'AT']) expect(recognitionAskedCarriers(PARCEL, { countryHint })).toEqual(['maersk-ecommerce']);
    for (const other of ['1MEXAMPLE001234567', '1M12345670012345678', '1MEXAMPLE001234567A']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('maersk-ecommerce');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(MAERSK_API)
      ? reply(text('in-transit')) : new Response('', { status: 503 })));
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL, carrier: 'maersk-ecommerce' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'maersk-ecommerce', source: 'maersk-ecommerce', result: { current_stage: 'in_transit' } });
  });

  it('leaves the numbers Maersk gives Cainiao’s parcels to AliExpress, and reads a parcel page link', () => {
    expect(detectCarrierMatch('1MCAINIXX0000000001')).toMatchObject({ carrier: 'aliexpress', confidence: 'high', candidates: ['aliexpress'] });
    expect(parseTrackingInput(`https://www.maersk.com/tracking/parcel/${PARCEL}`)).toMatchObject({
      carrier: 'maersk-ecommerce', trackingNumber: PARCEL, source: 'link' });
  });
});

describe('Maersk eCommerce status vocabulary', () => {
  it('maps every code it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'maersk-ecommerce', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(maerskStage(entry.code, '', false), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'maersk-ecommerce', providerCode: '77996', description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString', '77996']) expect(maerskStage(code, 'Sample Group', false), code).toBeNull();
  });
});
