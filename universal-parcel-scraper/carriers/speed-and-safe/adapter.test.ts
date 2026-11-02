import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPEED_AND_SAFE_API, speedAndSafeLookupUrl, SpeedAndSafeTracker } from './adapter.js';
import { normalizeSpeedAndSafeNumber, parseSpeedAndSafe, speedAndSafeWording } from './parser.js';
import { speedAndSafeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The fixtures' consignment; the ERP holds nothing under the other one.
const NUMBER = '00000001';
const OTHER = '000000000';

type Row = Record<string, unknown>;
type Reply = Row & { data: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (rows: Row[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (body: unknown, init?: ResponseInit) => vi.fn<typeof fetch>().mockImplementation(async () => reply(body, init));
// The page Sucuri's firewall serves when it blocks a visitor.
const FIREWALL = '<!DOCTYPE html><html><head><title>Sucuri WebSite Firewall - Access Denied</title></head><body>Access Denied</body></html>';

describe('Gokulam Speed & Safe tracking adapter', () => {
  it('asks the ERP’s status lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = answering(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpeedAndSafeTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0000-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://erp.gokulamspeedandsafe.com/online/getconsignmentstatus?consignmentno=${NUMBER}`);
    expect(String(url)).toBe(speedAndSafeLookupUrl(NUMBER));
    expect(String(url).startsWith(SPEED_AND_SAFE_API)).toBe(true);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'speed-and-safe', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery with its scans at India’s offset, newest first, without the branch’s phone or the delivery’s area', () => {
    const result = parseSpeedAndSafe(fixture('delivered'), NUMBER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-06T18:42:10+05:30', expected_delivery: null,
      delivered_at: '2026-05-06T18:42:10+05:30', timezone: 'Asia/Kolkata',
      events: [
        { time: '2026-05-06T18:42:10+05:30', location: 'Testpur-Franchisee', description: 'Delivered', provider_code: 'D',
          stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-05-06T09:15:03+05:30', location: 'Testpur-Franchisee', description: 'Out for Delivery', provider_code: 'O',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-05-06T07:58:41+05:30', location: 'Testpur-Franchisee', description: 'Arrived at Testpur-Franchisee', provider_code: 'I',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-05-05T23:10:12+05:30', location: 'Sample City-Hub', description: 'Dispatched to Testpur-Franchisee', provider_code: 'M',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-05-05T04:20:55+05:30', location: 'Sample City-Hub', description: 'Arrived at Sample City-Hub', provider_code: 'I',
          stage: 'in_transit', stage_source: 'carrier_map' },
        // The repeated dispatch is kept once; the one a few seconds earlier is a scan of its own.
        { time: '2026-05-04T19:31:20+05:30', location: 'Sampleton-Branch', description: 'Dispatched to Sample City-Hub', provider_code: 'M',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-05-04T19:30:59+05:30', location: 'Sampleton-Branch', description: 'Dispatched to Sample City-Hub', provider_code: 'M',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-05-04T17:05:00+05:30', location: 'Sampleton-Branch', description: 'Arrived at Sampleton-Branch', provider_code: 'I',
          stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/0000000000|Example Nagar|Testpur\b(?!-)|Exampur|branchcontact|remarks/);
  });

  it('reads a parcel on its way', () => {
    const result = parseSpeedAndSafe(fixture('in-transit'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived at Sample City-Hub',
      last_update: '2026-09-14T02:47:31+05:30', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location, event.description])).toEqual([
      ['2026-09-14T02:47:31+05:30', 'Sample City-Hub', 'Arrived at Sample City-Hub'],
      ['2026-09-13T20:12:08+05:30', 'Sampleton-Branch', 'Dispatched to Sample City-Hub'],
      ['2026-09-13T16:30:44+05:30', 'Sampleton-Branch', 'Arrived at Sampleton-Branch'],
    ]);
  });

  it('keeps an instant’s own offset, orders scans by instant and lets the newest staged scan decide', () => {
    const result = parseSpeedAndSafe(changed('in-transit', (rows) => {
      // A scan an hour later at another offset is still the newest.
      rows.push({ ...rows[0]!, id: 2004, transit: 'O', status: 'Out for Delivery- ', processdate: '2026-09-13 22:17:31+00' });
      rows.unshift({ ...rows[0]!, id: 2005, transit: 'X', status: 'Synthetic note- ', processdate: '2026-09-14 04:00:00.1+05:30' });
    }), NUMBER);
    expect(result.events!.slice(0, 3).map((event) => [event.time, event.description, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-09-14T04:00:00+05:30', 'Synthetic note', 'X', null],
      ['2026-09-13T22:17:31Z', 'Out for Delivery', 'O', 'out_for_delivery'],
      ['2026-09-14T02:47:31+05:30', 'Arrived at Sample City-Hub', 'I', 'in_transit'],
    ]);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Synthetic note',
      last_update: '2026-09-14T04:00:00+05:30' });
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const result = parseSpeedAndSafe(changed('in-transit', (rows) => {
      rows.reverse();
      rows.push({ ...rows.at(-1)!, id: 2004, transit: 'O', status: 'Out for Delivery- ' });
    }), NUMBER);
    expect(result.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['O', 'I']);
  });

  it('drops what the ERP writes after a status’s dash, and stages other wordings by the shared rules', () => {
    expect(speedAndSafeWording('Delivered- ')).toBe('Delivered');
    expect(speedAndSafeWording('Delivered- Sample Person')).toBe('Delivered');
    expect(speedAndSafeWording('Out for Delivery - Sample Staff 0000000000')).toBe('Out for Delivery');
    expect(speedAndSafeWording('Re-Dispatched- ')).toBe('Re-Dispatched');
    expect(speedAndSafeWording('Delivered-')).toBe('Delivered');
    expect(speedAndSafeWording('Delivered')).toBe('Delivered');
    const result = parseSpeedAndSafe(changed('delivered', (rows) => {
      Object.assign(rows[0]!, { status: 'Undelivered- Sample Person', transit: 'U' });
    }), NUMBER);
    expect(result.events![0]).toMatchObject({ description: 'Undelivered', provider_code: 'U', stage: 'failed_attempt' });
    expect(result).toMatchObject({ current_stage: 'failed_attempt' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toContain('Sample Person');
    // An arrival or dispatch without its other branch keeps the status alone.
    const bare = parseSpeedAndSafe(changed('in-transit', (rows) => { rows[0]!.dest = null; }), NUMBER);
    expect(bare.events![0]).toEqual({ time: '2026-09-14T02:47:31+05:30', description: 'Arrived', provider_code: 'I', stage: 'in_transit',
      stage_source: 'carrier_map' });
  });

  it('reads no rows as not found, and another status code as inconclusive', async () => {
    expect(() => parseSpeedAndSafe(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(fixture('not-found'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    for (const statusCode of ['500', 500, '404', null]) {
      expect(() => parseSpeedAndSafe({ ...fixture('not-found'), statusCode, status: 'failure' }, NUMBER), String(statusCode))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The page compares the code loosely, so a number is the same answer.
    expect(parseSpeedAndSafe({ ...fixture('in-transit'), statusCode: 200 }, NUMBER).events).toHaveLength(3);
  });

  it('binds every row to the whole number asked', () => {
    const named = (consignmentno: string) => changed('delivered', (rows) => { rows[3]!.consignmentno = consignmentno; });
    for (const consignmentno of [`Sampleton-Testpur( Example Nagar )-${OTHER}`, 'Sampleton-Testpur( Example Nagar )-0000000',
      'Sampleton-Testpur( Example Nagar )-00000001-0', 'Sampleton-Testpur( Example Nagar )']) {
      expect(() => parseSpeedAndSafe(named(consignmentno), NUMBER), consignmentno)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Gokulam Speed & Safe answered for another consignment' }));
    }
    // A route with a dash in a branch's name, or none at all, still ends with the number.
    expect(parseSpeedAndSafe(named(`Sample- Town-Testpur( Example Nagar )- ${NUMBER}`), NUMBER).events).toHaveLength(8);
    expect(parseSpeedAndSafe(named(NUMBER), NUMBER).events).toHaveLength(8);
  });

  it('keeps the newest hundred scans of a long history', () => {
    const long = parseSpeedAndSafe(changed('in-transit', (rows) => {
      const base = rows[0]!;
      rows.length = 0;
      for (let minute = 0; minute < 120; minute += 1) {
        rows.push({ ...base, processdate: `2026-09-14 0${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}:00+05:30` });
      }
    }), NUMBER);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ history_truncated: true, last_update: '2026-09-14T01:59:00+05:30' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], body: Reply) => { delete (body as Row).statusCode; },
      (_rows: Row[], body: Reply) => { body.data = null as never; },
      (_rows: Row[], body: Reply) => { body.data = 'scans' as never; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 300 }, () => rows[0]!)); },
      (rows: Row[]) => { rows[0] = 'scan' as never; },
      (rows: Row[]) => { delete rows[0]!.consignmentno; },
      (rows: Row[]) => { rows[0]!.consignmentno = { number: NUMBER }; },
      (rows: Row[]) => { rows[0]!.processdate = '2026-09-14 02:47:31.62'; },
      (rows: Row[]) => { rows[0]!.processdate = '14/09/2026 02:47+05:30'; },
      (rows: Row[]) => { rows[0]!.processdate = '2026-02-30 02:47:31+05:30'; },
      (rows: Row[]) => { rows[0]!.processdate = '2026-09-14 24:00:00+05:30'; },
      (rows: Row[]) => { rows[0]!.processdate = 1789000000000; },
      (rows: Row[]) => { delete rows[0]!.processdate; },
      (rows: Row[]) => { rows[0]!.status = ' - '; },
      (rows: Row[]) => { rows[0]!.status = null; },
      (rows: Row[]) => { rows[0]!.status = ['Arrived']; },
      (rows: Row[]) => { rows[0]!.transit = 1; },
      (rows: Row[]) => { rows[0]!.source = { name: 'Sampleton-Branch' }; },
    ]) {
      expect(() => parseSpeedAndSafe(changed('in-transit', change), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], 'ok', { status: 'success', data: [] }]) {
      expect(() => parseSpeedAndSafe(body, NUMBER), JSON.stringify(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a firewall page in place of the reply, or a refusal, as a challenge, and other pages as a broken reply', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: NUMBER });
    await expect(lookup(html(FIREWALL))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><script src="/sucuri_cloudproxy_js"></script></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html(FIREWALL, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>Gokulam Speed &amp; Safe</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply(''))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a moved route or a missing lookup apart from an unknown number', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: NUMBER });
    await expect(lookup(new Response('', { status: 302, headers: { Location: 'https://www.gokulamspeedandsafe.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    });

  it('reports a rate limit with its wait', async () => {
    await expect(carrier(answering('Too Many Requests', { status: 429, headers: { 'Retry-After': '30' } })).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it('refuses numbers the tracker does not issue before any request', async () => {
    const fetcher = answering(fixture('in-transit'));
    for (const number of ['', '0000000', OTHER, 'A0000000', '00000000,00000000', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpeedAndSafeNumber('0000 0001')).toBe(NUMBER);
    expect(() => parseSpeedAndSafe(fixture('in-transit'), OTHER)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async () => reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging lookup inside the caller’s budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('routes a number filed under Gokulam Speed & Safe to the adapter, and leaves eight digits to the caller', async () => {
    const answer = await createTracker({ fetcher: answering(fixture('delivered')), providers: [], env: {} })
      .track({ number: NUMBER, carrier: 'speed-and-safe' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'speed-and-safe', source: 'speed-and-safe', result: { current_stage: 'delivered' } });
    expect(carrier(answering(fixture('delivered'))).recognize).toBeUndefined();
    expect(detectCarrierMatch(NUMBER).carrier).not.toBe('speed-and-safe');
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('speed-and-safe');
    expect(recognitionAskedCarriers(NUMBER)).not.toContain('speed-and-safe');
  });
});

describe('Gokulam Speed & Safe status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.stage) continue;
      const wording = entry.wording.replace('<branch>', 'Sample City-Hub');
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(wording)), entry.wording).toBe(entry.stage);
      expect(speedAndSafeStage(wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'speed-and-safe', providerCode: 'M', description: 'Dispatched to Sample City-Hub' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'speed-and-safe', providerCode: 'X', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A status that only ends with a mapped word is not that status.
    expect(speedAndSafeStage('Undelivered')).toEqual({ stage: 'failed_attempt', source: expect.stringMatching(/^wording:/) });
    expect(speedAndSafeStage('Synthetic note')).toBeNull();
  });
});
