import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GO4_API, Go4Tracker } from './adapter.js';
import { normalizeGo4Number, parseGo4 } from './parser.js';
import { go4Stage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '20000000001';
const MOVING = '20000000002';
const SHORT = '1000000003';
type Row = Record<string, unknown>;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Row[] => JSON.parse(text(name)) as Row[];
const edited = (name: string, change: (record: Row, payload: Row[]) => void): Row[] => {
  const payload = fixture(name);
  change(payload[0]!, payload);
  return payload;
};
const lookupUrl = (number: string) => `${GO4_API}?from=go4status&parcelId=${number}`;
const reply = (body: string | null, status = 200, type = 'application/json, charset=utf-8') =>
  new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('GO4 tracking adapter', () => {
  it('asks the tracker’s lookup for the whole number once, naming the page as it does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new Go4Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 200 0000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lookupUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'go4', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery after a failed attempt from Bratislava wall clocks, without names, notes or phone numbers', () => {
    const result = parseGo4(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered - in good condition', last_update: '2026-03-30T12:00:00+02:00', expected_delivery: null,
      delivered_at: '2026-03-30T12:00:00+02:00' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-03-30T12:00:00+02:00', 'Doručená', 'delivered', 'carrier_map'],
      ['2026-03-29T10:05:00+02:00', 'Pokus o doručenie: adresát nezastihnutý, tel.', 'failed_attempt', 'carrier_map'],
      ['2026-03-28T15:00:00+01:00', 'Na doručení', 'accepted', 'carrier_map'],
      ['2026-03-28T13:26:00+01:00', 'Objednaná', 'registered', 'carrier_map'],
    ]);
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toMatch(/Sample|Synthetic note|\+421|0900|OK"/);
  });

  it('reads a parcel on its way with its estimate, the repeated hour as its first occurrence and a zero date as none', () => {
    const result = parseGo4(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Na doručení', last_update: '2026-10-25T02:30:00+02:00', expected_delivery: '2026-10-26T11:00:00+01:00' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-10-25T02:30:00+02:00', 'Na doručení', 'accepted'],
      ['2026-10-24T18:40:00+02:00', 'Objednaná', 'registered'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps an offset the reply gives, a clock without seconds, and an attempt without its reason', () => {
    const result = parseGo4(edited('in-transit', (record) => {
      record.DatumObjed = '2026-10-24T16:40:00Z';
      record.DatumPrevz = '2026-10-25 09:15';
      record.kedyNedorucena = [{ Datum: '2026-10-25 14:00:00', detailnyStatus: null }];
    }), MOVING);
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-10-25T14:00:00+01:00', 'Pokus o doručenie', 'failed_attempt'],
      ['2026-10-25T09:15:00+01:00', 'Na doručení', 'accepted'],
      ['2026-10-24T16:40:00Z', 'Objednaná', 'registered'],
    ]);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', status: 'exception', expected_delivery: '2026-10-26T11:00:00+01:00' });
  });

  it('lets the main status settle a delivery the milestones have not reached, and stage a record without them', () => {
    const settled = parseGo4(edited('in-transit', (record) => { record.hlavnyStatus = 'Delivered'; }), MOVING);
    expect(settled).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', expected_delivery: null });
    expect(settled).not.toHaveProperty('delivered_at');
    // An earlier status does not step the parcel back, and an unknown one leaves the milestones' stage.
    expect(parseGo4(edited('delivered', (record) => { record.hlavnyStatus = 'Objednaná'; }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(parseGo4(edited('in-transit', (record) => { record.hlavnyStatus = 'Synthetic status'; }), MOVING))
      .toMatchObject({ current_stage: 'accepted', last_status_text: 'Synthetic status' });
    const summary = parseGo4(edited('delivered', (record) => {
      for (const key of ['DatumObjed', 'DatumPrevz', 'DatumDoruc', 'kedyNedorucena']) delete record[key];
    }), DELIVERED);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered - in good condition',
      last_update: null, summary_only: true, events: [] });
    expect(() => parseGo4(edited('in-transit', (record) => {
      record.DatumObjed = null; record.DatumPrevz = null; record.hlavnyStatus = null;
    }), MOVING)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker’s empty record as not found, and binds a record to the whole number asked', () => {
    expect(() => parseGo4(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGo4(fixture('delivered'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GO4 answered for another shipment' }));
    expect(() => parseGo4(edited('delivered', (record) => { record.Zasielka_Kod = 200000000010; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGo4(edited('delivered', (_record, payload) => { payload.push({ Zasielka_Kod: 20000000009 }); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page shows the first record only; a second empty one changes nothing.
    expect(parseGo4(edited('delivered', (_record, payload) => { payload.push(fixture('not-found')[0]!); }), DELIVERED).events).toHaveLength(4);
    expect(parseGo4(edited('in-transit', (record) => { record.Zasielka_Kod = '200 000 000 02'; }), MOVING).events).toHaveLength(2);
    expect(() => parseGo4([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GO4 returned no record for the number' }));
  });

  it('rejects changed replies', () => {
    expect(() => parseGo4({ Zasielka_Kod: 20000000001 }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGo4(['record'], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGo4(Array.from({ length: 51 }, () => fixture('delivered')[0]), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (record: Row) => { record.Zasielka_Kod = 20000000001.5; },
      (record: Row) => { record.Zasielka_Kod = -20000000001; },
      (record: Row) => { record.Zasielka_Kod = ['20000000001']; },
      (record: Row) => { record.Zasielka_Kod = ''; },
      (record: Row) => { record.hlavnyStatus = { name: 'Delivered' }; },
      (record: Row) => { record.DatumDoruc = 1774864800000; },
      (record: Row) => { record.DatumDoruc = '30. 3. 2026 12:00'; },
      (record: Row) => { record.DatumDoruc = '2026-02-30 12:00:00'; },
      (record: Row) => { record.DatumDoruc = '2026-03-30 24:00:00'; },
      (record: Row) => { record.DatumDoruc = '2026-03-30T12:00:00+25:00'; },
      (record: Row) => { record.kedyNedorucena = 'adresát nezastihnutý'; },
      (record: Row) => { record.kedyNedorucena = ['attempt']; },
      (record: Row) => { record.kedyNedorucena = [{ detailnyStatus: 'adresát nezastihnutý' }]; },
      (record: Row) => { record.kedyNedorucena = Array.from({ length: 101 }, () => ({ Datum: '2026-03-29 10:05:00' })); },
    ]) {
      expect(() => parseGo4(edited('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an empty reply, a browser check, a moved route and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: DELIVERED });
    await expect(lookup(reply(text('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply(''))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply(CHECK, 200, 'text/html'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply(CHECK, 403, 'text/html'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('int(200)\n', 401, 'text/html'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>GO4</title></html>', 200, 'text/html'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(new Response(null, { status: 302, headers: { Location: 'https://www.go4.sk/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('takes 1 and ten digits or 2 and eleven, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['200000000001', '2000000000', '10000000003', '100000000', '30000000001', '0000000001', '2000000000A', 'ABCD0001']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGo4Number('100-000-0003')).toBe(SHORT);
    expect(normalizeGo4Number(' 2000 000 0001')).toBe(DELIVERED);
  });

  it('recognizes a shipment the tracker shows and not a number it does not know', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(text(String(url) === lookupUrl(DELIVERED) ? 'delivered' : 'not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-30T10:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(SHORT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)('keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
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
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under GO4, or opened from its tracking link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'go4' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'go4', source: 'go4', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === lookupUrl(DELIVERED))).toBe(true);
    expect(parseTrackingInput(`https://zona.go4.eu/status/?parcelId=${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'go4', source: 'link' });
  });

  it('is not claimed or asked by number alone: ten and eleven digits are shared by many carriers', () => {
    for (const number of [DELIVERED, SHORT]) {
      expect(detectCarrierMatch(number).carrier).not.toBe('go4');
      expect(recognitionAskedCarriers(number)).not.toContain('go4');
    }
  });
});

type Entry = { code?: string; wording: string; stage?: string; confirmedBy: string };

describe('GO4 status vocabulary', () => {
  it('maps every recorded wording to the stage recorded for it', () => {
    for (const entry of statuses.entries as Entry[]) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(go4Stage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'go4', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'go4', providerCode: null, description: 'Pokus o doručenie: adresát nezastihnutý' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(go4Stage('Pokus o doručeniex')).toBeNull();
    expect(go4Stage('Synthetic status')).toBeNull();
    expect(statusMapAnswer({ carrier: 'go4', providerCode: null, description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
