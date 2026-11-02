import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KEX_TRACK_PAGE, KexTracker, kexLookupUrl } from './adapter.js';
import { normalizeKexNumber, parseKex } from './parser.js';
import { kexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'SYNT000000017';
const IN_TRANSIT = 'SYNT000000025';
const UNKNOWN = 'SYNT000000033';
const PLATFORM = 'SHP0000000049';

type Row = Record<string, unknown>;
type Ref = Row & { icon: Row & { current_idx: number; display: Row[] }; shipment: Row; shipment_status: Row[] };
type Entry = Row & { ref: Ref };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Entry[];
const changed = (name: string, change: (ref: Ref, body: Entry[]) => void) => {
  const body = fixture(name);
  change(body[0]!.ref, body);
  return body;
};
// The tracker answers with JSON under an HTML content type.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The number the page's encoded `track` parameter carries, between its padding. */
const tracked = (url: string) => {
  const parts = atob(new URL(url).searchParams.get('track')!).split('fHx8');
  expect(parts).toHaveLength(5);
  for (const padding of [...parts.slice(0, 2), ...parts.slice(3)]) expect(padding).toMatch(/^[0-9a-f]{32}$/);
  return parts[2];
};
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('KEX Express HTTP adapter', () => {
  it("posts the number as the page's search does, in its encoded track parameter, through the supplied transport", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' synt 000000025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(`${KEX_TRACK_PAGE}?track=`)).toBe(true);
    expect(tracked(url)).toBe(IN_TRANSIT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', 'kett-lang': 'en', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init.body))).toEqual({ tracking_no: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('pads the number with fresh random hex each time, encoded for a query string', () => {
    const first = kexLookupUrl(DELIVERED);
    expect(tracked(first)).toBe(DELIVERED);
    expect(kexLookupUrl(DELIVERED)).not.toBe(first);
    expect(kexLookupUrl(DELIVERED, () => 'f'.repeat(32))).toBe(`${KEX_TRACK_PAGE}?track=${encodeURIComponent(btoa(
      ['f'.repeat(32), 'f'.repeat(32), DELIVERED, 'f'.repeat(32), 'f'.repeat(32)].join('fHx8')))}`);
  });

  it("reads a delivered parcel on Bangkok's clock, without the people, the call, the signature or the photos", () => {
    const result = parseKex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Successfully delivered', last_update: '2026-03-06T14:21:04+07:00', expected_delivery: null,
      delivered_at: '2026-03-06T14:21:04+07:00' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null, event.description]))
      .toEqual([
        ['2026-03-06T14:21:04+07:00', 'POD', 'delivered', 'Sample District, Sample Province', 'Successfully delivered'],
        ['2026-03-06T14:15:07+07:00', 'CAL', null, null, 'Courier has contacted the recipient'],
        ['2026-03-06T09:38:28+07:00', '045', 'out_for_delivery', 'Sample District, Sample Province', 'Out for delivery'],
        ['2026-03-06T04:38:49+07:00', '103', 'in_transit', 'Sample District, Sample Province', 'Arrived at the destination station'],
        ['2026-03-05T20:51:41+07:00', '110', 'in_transit', 'Hub District, Hub Province', 'Departed from Distribution center'],
        ['2026-03-05T15:33:45+07:00', '109', 'in_transit', 'Hub District, Hub Province', 'Arrived at Distribution center'],
        ['2026-03-04T18:20:08+07:00', '106', 'in_transit', 'Origin District, Origin Province', 'Departed from Origin station'],
        ['2026-03-04T17:50:00+07:00', '105.1', 'in_transit', 'Origin District, Origin Province', 'Arrived at Origin station'],
        ['2026-03-04T17:28:41+07:00', '005', 'accepted', 'Origin District, Origin Province', 'Your parcel has been dropped at KEX service point'],
      ]);
    // Only station and distribution-centre scans keep their coordinates; a delivery round's are the courier's or the recipient's.
    expect(result.events!.map((event) => event.point ?? null)).toEqual([null, null, null, { latitude: 13.7123, longitude: 100.5123 },
      { latitude: 13.6, longitude: 100.7 }, { latitude: 13.6, longitude: 100.7 }, null, null, null]);
    expect(JSON.stringify(result)).not.toMatch(/Sample [RSC]|099|SAMPLE-REF|BK0|example\.invalid|c3ludGhldGlj|PROVINCE|10000/);
  });

  it('reads a parcel on its way with its due date, and lower-case echoes of the number', () => {
    const result = parseKex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departed from Distribution center', last_update: '2026-03-05T20:51:41+07:00', expected_delivery: '2026-03-09' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.point ?? null])).toEqual([
      ['110', 'in_transit', { latitude: 13.6, longitude: 100.7 }],
      ['109', 'in_transit', { latitude: 13.6, longitude: 100.7 }],
      // A courier's pickup is at the sender's.
      ['010', 'accepted', null],
    ]);
    const echoed = fixture('in-transit');
    echoed[0]!.tracking_no = IN_TRANSIT.toLowerCase();
    echoed[0]!.ref.shipment.con = IN_TRANSIT.toLowerCase();
    expect(parseKex(echoed, IN_TRANSIT).events).toHaveLength(3);
  });

  it("files a parcel under the rail's delivered or returned step, and drops the due date then", () => {
    const returned = parseKex(changed('in-transit', (ref) => { ref.icon.display[1]!.code = '401'; }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', expected_delivery: null });
    const delivered = parseKex(changed('in-transit', (ref) => { ref.icon.display[1]!.code = '400'; }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(delivered).not.toHaveProperty('delivered_at');
    expect(parseKex(changed('in-transit', (ref) => { ref.shipment.edt = ''; }), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    expect(parseKex(changed('in-transit', (ref) => { ref.shipment.edt = '31 Feb 2026'; }), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('keeps an unknown code without a stage and takes phone numbers out of the wording', () => {
    const result = parseKex(changed('in-transit', (ref) => {
      ref.shipment_status[0]!.s_code = 'ZZZ';
      ref.shipment_status[0]!.s_desc = 'Synthetic note 099-999-9999';
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ time: '2026-03-05T20:51:41+07:00', location: 'Hub District, Hub Province', description: 'Synthetic note',
      provider_code: 'ZZZ' });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
  });

  it("reads the tracker's answer for a number it has no shipment for as not found, and its placeholder as no history", () => {
    expect(() => parseKex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const tooShort = fixture('not-found');
    tooShort[0]!.ref.sta = { code: '400', desc: 'Shipment not Found' };
    expect(() => parseKex(tooShort, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = fixture('not-found');
    other[0]!.ref.sta = { code: '500', desc: 'Error' };
    expect(() => parseKex(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A selling platform's number, known or not, gets a waiting row stamped with the time of the lookup.
    expect(() => parseKex(fixture('placeholder'), PLATFORM)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseKex(changed('delivered', (ref) => { ref.shipment_status = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // The service's own failure says nothing about the parcel; the captcha is a challenge.
    expect(() => parseKex(fixture('service-error'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKex({ needCaptcha: true }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('counts a reply only when its entry and its shipment are the number asked', () => {
    expect(() => parseKex(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'KEX Express answered for another shipment' }));
    expect(() => parseKex(changed('in-transit', (ref) => { ref.shipment.con = DELIVERED; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'KEX Express answered for another shipment' }));
    expect(() => parseKex(changed('in-transit', (ref) => { ref.shipment.con = `${IN_TRANSIT}1`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKex([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Its entry is found among others.
    expect(parseKex([...fixture('not-found'), ...fixture('in-transit')], IN_TRANSIT).events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    const scan = (ref: Ref) => ref.shipment_status[3]!;
    for (const change of [
      (_ref: Ref, body: Entry[]) => { (body as unknown[])[0] = 'entry'; },
      (_ref: Ref, body: Entry[]) => { body.push(...Array.from({ length: 30 }, () => body[0]!)); },
      (_ref: Ref, body: Entry[]) => { delete (body[0] as Row).ref; },
      (ref: Ref) => { (ref as Row).shipment = 'shipment'; },
      (ref: Ref) => { delete ref.shipment.con; },
      (ref: Ref) => { (ref as Row).shipment_status = 'rows'; },
      (ref: Ref) => { ref.shipment_status = Array.from({ length: 501 }, () => scan(ref)); },
      (ref: Ref) => { (ref.shipment_status as unknown[]).push('row'); },
      (ref: Ref) => { scan(ref).s_datetime = '2026-03-06 04:38:49'; },
      (ref: Ref) => { scan(ref).s_datetime = '2026-02-31T04:38:49'; },
      (ref: Ref) => { scan(ref).s_datetime = '2026-03-06T24:00:00'; },
      (ref: Ref) => { scan(ref).s_datetime = '2026-03-06T04:38:49+07:00'; },
      (ref: Ref) => { delete scan(ref).s_datetime; },
      (ref: Ref) => { scan(ref).s_desc = 7; },
      (ref: Ref) => { scan(ref).s_desc = ''; },
      (ref: Ref) => { scan(ref).loc = ['Sample']; },
      (ref: Ref) => { scan(ref).GEO_Location = { lat: 1 }; },
    ]) {
      expect(() => parseKex(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', {}, null, { data: null }]) {
      expect(() => parseKex(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, the captcha, a block, a rate limit, a moved route and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit, number = UNKNOWN) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init)))
      .track({ number });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('placeholder'), {}, PLATFORM)).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(lookup(fixture('service-error'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ needCaptcha: true })).rejects.toMatchObject({ kind: 'challenge' });
    for (const status of [400, 401, 403, 429]) {
      await expect(lookup({ needCaptcha: true }, { status }), String(status)).rejects.toMatchObject({ kind: 'challenge', status });
    }
    await expect(lookup(CLOUDFLARE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup('', { status: 401 })).rejects.toMatchObject({ kind: 'indeterminate', status: 401 });
    await expect(lookup('', { status: 400 })).rejects.toMatchObject({ kind: 'indeterminate', status: 400 });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://th.kex-express.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>KEX Express</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance'], [524, 'indeterminate']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('error code', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number KEX Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-06T07:21:04.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('KEX-1')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // The placeholder is no answer either way.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('placeholder')))).recognize!(PLATFORM))
      .rejects.toMatchObject({ name: 'NoHistoryError' });
  });

  it('rejects numbers KEX Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['KEX1234', 'SAMPLETRACKING', `KEX${'0'.repeat(18)}`, `${DELIVERED},${IN_TRANSIT}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKexNumber('synt-0000 00017')).toBe(DELIVERED);
    expect(normalizeKexNumber('12345678')).toBe('12345678');
  });

  it('tries once more with fresh padding when the lookup fails to reach KEX Express', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [first, second] = fetcher.mock.calls.map(([url]) => String(url));
    expect([tracked(first!), tracked(second!)]).toEqual([DELIVERED, DELIVERED]);
    expect(first).not.toBe(second);
  });

  it('ends a hanging lookup inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('routes a number filed under KEX Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'kex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'kex', source: 'kex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(`${KEX_TRACK_PAGE}?track=`))).toBe(true);
  });
});

describe('KEX Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      // Wordings from the old tracker came without a code; the shared rules read them.
      if (!entry.code) continue;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(kexStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'kex', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(kexStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    // A suffixed code reads as its first three digits.
    expect(statusMapAnswer({ carrier: 'kex', providerCode: '109.1', description: 'Arrived at Distribution center' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'kex', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(kexStage('ZZZ', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(kexStage('ZZZ', 'Synthetic note')).toBeNull();
    expect(kexStage('pod', 'Successfully delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
