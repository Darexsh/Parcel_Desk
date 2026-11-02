import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AMERIJET_API, AmerijetTracker, amerijetLookupUrl } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeAmerijetNumber, parseAmerijet } from './parser.js';
import { amerijetStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '81000000011';
const IN_TRANSIT = '81000000022';
const UNKNOWN = '81000000000';

type Row = Record<string, unknown>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Row[];
const changed = (name: string, change: (rows: Row[]) => void) => {
  const rows = fixture(name);
  change(rows);
  return rows;
};
// The tracker labels its JSON as HTML.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page Cloudflare serves in place of the reply when it blocks a client.
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-wrapper">'
  + '<div id="cf-error-details"><h1>Sorry, you have been blocked</h1></div></div></body></html>';

describe('Amerijet HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole air waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AmerijetTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 810-0000 0022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${AMERIJET_API}?awbNo=${IN_TRANSIT}`);
    expect(amerijetLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('method');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'amerijet', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each station’s wall clock and its code, newest first, through to the delivery', () => {
    const result = parseAmerijet(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered at DST', last_update: null, last_update_local: '2026-03-12T15:20:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      ['2026-03-12T15:20:00', 'Delivered', 'delivered', 'DST', 'Delivered at DST'],
      ['2026-03-12T06:40:00', 'Arrived', 'in_transit', 'DST', 'Arrived in DST'],
      ['2026-03-11T21:15:00', 'Departed', 'in_transit', 'HUB', 'Departed from HUB'],
      ['2026-03-10T08:05:00', 'Arrived', 'in_transit', 'HUB', 'Arrived in HUB'],
      ['2026-03-09T18:30:00', 'Departed', 'in_transit', 'ORG', 'Departed from ORG'],
      ['2026-03-09T11:00:00', 'Accepted', 'accepted', 'ORG', 'Accepted at ORG'],
      ['2026-03-02T16:45:00', 'Booked', 'registered', 'ORG', 'Booked'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // Flights and trucks are not kept.
    expect(JSON.stringify(result)).not.toMatch(/M6\d/);
  });

  it('says how many pieces a scan moved when it moved part of the shipment', () => {
    const result = parseAmerijet(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departed from HUB (2 of 5 pieces)',
      last_update_local: '2026-05-21T19:45:00' });
    expect(result.events!.map((event) => event.description)).toEqual([
      'Departed from HUB (2 of 5 pieces)', 'Arrived in HUB', 'Departed from ORG', 'Accepted at ORG', 'Booked',
    ]);
  });

  it('reads the time the page shows, orders one wall clock by milestone and keeps a repeated scan once', () => {
    const result = parseAmerijet(changed('in-transit', (rows) => {
      // The page shows the day of TMEVENTDATE with TMEVENTTIME; a row without TMEVENTTIME keeps TMEVENTDATE's.
      Object.assign(rows[0]!, { TMEVENTDATE: '2026-05-20T00:00:00', TMEVENTTIME: '12:10 AM' });
      Object.assign(rows[3]!, { TMEVENTDATE: '2026-05-19T09:20:00.000', TMEVENTTIME: '' });
      rows[2]!.TMEVENTDATE = '2026-05-19T09:20:00';
      rows[2]!.TMEVENTTIME = '09:20 AM';
      rows.push({ ...rows[4]! });
    }), IN_TRANSIT);
    expect(result.events!.map((event) => [event.local_time, event.provider_code])).toEqual([
      ['2026-05-21T19:45:00', 'Departed'],
      ['2026-05-20T00:10:00', 'Arrived'],
      ['2026-05-19T09:20:00', 'Departed'],
      ['2026-05-19T09:20:00', 'Accepted'],
      ['2026-05-15T10:05:00', 'Booked'],
    ]);
  });

  it('stages a milestone the map does not know by its wording, and leaves other wording without a stage', () => {
    const result = parseAmerijet(changed('in-transit', (rows) => {
      Object.assign(rows[0]!, { TMEVENTSTATUSCODE: 'Synthetic', TMEVENTDESC: 'Synthetic note at HUB' });
    }), IN_TRANSIT);
    expect(result.events!.find((event) => event.provider_code === 'Synthetic')).not.toHaveProperty('stage');
    expect(amerijetStage('Synthetic', 'Delivered to consignee')).toMatchObject({ stage: 'delivered' });
    expect(amerijetStage('delivered', 'Synthetic')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(amerijetStage('Synthetic', 'Synthetic note')).toBeNull();
  });

  it('reads an unknown air waybill as not found, another message as inconclusive and a record without scans as no history', () => {
    expect(() => parseAmerijet(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAmerijet({ Message: 'An error has occurred.' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAmerijet([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a history only when every scan names the air waybill asked', () => {
    expect(() => parseAmerijet(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Amerijet answered for another air waybill' }));
    expect(() => parseAmerijet(changed('delivered', (rows) => { rows[3]!.TMAWB = IN_TRANSIT; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseAmerijet(changed('delivered', (rows) => { rows[0]!.TMAWB = '810-00000011'; rows[1]!.TMAWB = 81000000011; }), DELIVERED).events)
      .toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (rows: Row[]) => { rows[0] = 'scan' as never; },
      (rows: Row[]) => { delete rows[0]!.TMAWB; },
      (rows: Row[]) => { rows[0]!.TMAWB = { awb: DELIVERED }; },
      (rows: Row[]) => { delete rows[0]!.TMEVENTDATE; },
      (rows: Row[]) => { rows[0]!.TMEVENTDATE = '12/03/2026 15:20'; },
      (rows: Row[]) => { rows[0]!.TMEVENTDATE = '2026-02-30T15:20:00'; },
      (rows: Row[]) => { rows[0]!.TMEVENTTIME = '15:20'; },
      (rows: Row[]) => { rows[0]!.TMEVENTTIME = '13:20 PM'; },
      (rows: Row[]) => { rows[0]!.TMEVENTDESC = ['Delivered']; },
      (rows: Row[]) => { rows[0]!.TMEVENTDESC = ''; rows[0]!.TMEVENTSTATUSCODE = ''; },
      (rows: Row[]) => { rows[0]!.TMNUMBEROFPIECES = '3'; },
      (rows: Row[]) => { rows[0]!.TMTOTALPIECES = -1; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[0]!)); },
    ]) {
      expect(() => parseAmerijet(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [{ data: [] }, 'shipment', null]) {
      expect(() => parseAmerijet(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown air waybill, a moved route, a block, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads an unknown air waybill from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://amerijet.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Cloudflare blocks some clients' names outright.
    await expect(lookup(BLOCKED, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Amerijet</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('recognizes a known air waybill and the unknown answer, and asks nothing for a number Amerijet does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T15:20:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('81000000012')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Amerijet does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A failed check digit, another airline's prefix, a short or long serial, letters, nothing.
    for (const number of ['81000000012', '00100000000', '8100000000', '810000000000', 'M600000000', '', `810${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAmerijetNumber(' 810-0000 0011 ')).toBe(DELIVERED);
    // Every air waybill in the corpus passes.
    for (const record of numbers.records) expect(normalizeAmerijetNumber(record.number), record.number).toBe(record.number.replace('-', ''));
  });

  it('routes an air waybill filed under Amerijet, or printed with its dash, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'amerijet' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'amerijet', source: 'amerijet', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: '810-00000011' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'amerijet', source: 'amerijet' });
    expect(fetcher.mock.calls.every(([url]) => String(url) === amerijetLookupUrl(DELIVERED))).toBe(true);
    // Without the dash, the eleven digits fit other carriers' numbers too.
    expect(detectCarrierMatch(DELIVERED).candidates as readonly string[]).not.toContain('amerijet');
  });
});

describe('Amerijet status vocabulary', () => {
  it('records every milestone the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const wording = entry.wording.replace('[station]', 'SMP');
      expect(statusMap.stage(entry.code, wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(amerijetStage(entry.code, wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'amerijet', providerCode: entry.code, description: wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'amerijet', providerCode: 'Synthetic', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
