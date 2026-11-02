import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, M_ONE_API, MOneTracker } from './adapter.js';
import { normalizeMOneNumber, parseMOne } from './parser.js';
import { mOneStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'PL000000014RS';
const IN_TRANSIT = 'PL000000028RS';
const UNKNOWN = 'PL000000031RS';

type Row = Record<string, unknown>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Row[];
const changed = (name: string, change: (rows: Row[]) => void) => {
  const rows = fixture(name);
  change(rows);
  return rows;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=utf-8', ...init.headers } });
// The tracker's answer for a number it does not hold: HTTP 404, no content type and a body that never ends.
const unknownNumber = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 404 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('M-ONE HTTP adapter', () => {
  it('asks the tracking API for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MOneTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' pl 000 000 028 rs ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${M_ONE_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'm-one', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered history newest first, with wall clocks, codes and depots, and without names', () => {
    const result = parseMOne(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Uručena pošiljka', last_update: null, last_update_local: '2026-04-05T16:12:03', expected_delivery: null,
      weight_kg: 1.25, destination_country: 'RS' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-04-05T16:12:03', 'ST07', 'delivered', null],
      ['2026-04-05T07:40:58', 'ST48', 'ready_for_pickup', null],
      ['2026-04-04T19:02:16', 'ST04', 'in_transit', 'DC Sample'],
      ['2026-04-04T14:48:30', 'ST35', 'failed_attempt', null],
      ['2026-04-04T09:05:44', 'ST05', 'out_for_delivery', null],
      ['2026-04-04T08:30:12', 'ST04', 'in_transit', 'DC Sample'],
      // The repeated transit scan is kept once.
      ['2026-04-03T11:15:09', 'ST06', 'in_transit', null],
      ['2026-04-03T10:02:41', 'ST02', 'accepted', null],
      // The pickup order's fraction of a second and its wording's line break are dropped.
      ['2026-04-01T17:20:05', 'ST01', 'registered', 'HUB Sample'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ description: 'Kreiran nalog za preuzimanje', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Sender|Recipient)|RAZ01|brojKoleta/);
  });

  it('keeps a parcel redirected at the depot in transit', () => {
    const result = parseMOne(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'U lokalnom tranzitu',
      last_update_local: '2026-05-13T10:41:02', weight_kg: 0.4 });
    expect(result.events!.map((event) => [event.provider_code, event.description])).toEqual([
      ['ST06', 'U lokalnom tranzitu'],
      ['ST11', 'Preusmerena'],
      ['ST04', 'U distributivnom centru dostave'],
      ['ST06', 'U lokalnom tranzitu'],
      ['ST02', 'Preuzeta od pošiljaoca'],
      ['ST01', 'Kreiran nalog za preuzimanje'],
    ]);
  });

  it('reads a history already newest first as it is, and leaves out the page’s placeholders', () => {
    const result = parseMOne(changed('in-transit', (rows) => {
      rows.reverse();
      for (const row of rows) Object.assign(row, { tezina: '/', primalacSifraZemlje: '/', distributivniCentarNaziv: '/' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update_local: '2026-05-13T10:41:02', current_stage: 'in_transit' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'ST01' });
    expect(result).not.toHaveProperty('weight_kg');
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events!.some((event) => event.location)).toBe(false);
  });

  it('counts a history only when every scan names the number asked', () => {
    expect(() => parseMOne(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'M-ONE answered for another shipment' }));
    expect(() => parseMOne(changed('delivered', (rows) => { rows[3]!.brojPosiljke = IN_TRANSIT; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseMOne(changed('in-transit', (rows) => { rows[0]!.brojPosiljke = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(6);
    expect(() => parseMOne([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const body of [
      { data: fixture('in-transit') },
      changed('in-transit', (rows) => { rows[0] = 'scan' as never; }),
      changed('in-transit', (rows) => { delete rows[0]!.brojPosiljke; }),
      changed('in-transit', (rows) => { rows[0]!.brojPosiljke = 7; }),
      changed('in-transit', (rows) => { rows[0]!.datumStatusa = ''; }),
      changed('in-transit', (rows) => { rows[0]!.datumStatusa = '11.05.2026 21:44'; }),
      changed('in-transit', (rows) => { rows[0]!.datumStatusa = '2026-02-30T10:00:00'; }),
      changed('in-transit', (rows) => { rows[0]!.datumStatusa = '2026-05-11T21:44:19+02:00'; }),
      changed('in-transit', (rows) => { rows[0]!.nazivStatus = null; }),
      changed('in-transit', (rows) => { rows[0]!.nazivStatus = ['Preuzeta']; }),
      changed('in-transit', (rows) => { rows[0]!.status = 1; }),
      Array.from({ length: 501 }, () => fixture('in-transit')[0]!),
    ]) {
      expect(() => parseMOne(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the bodiless 404 as not found at once, and keeps a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    const started = Date.now();
    await expect(lookup(unknownNumber())).rejects.toMatchObject({ kind: 'not_found' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // Unknown routes answer 401 with JSON; a 404 page or JSON is a moved route.
    await expect(lookup(new Response('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply({ status: 404, error: 'Not Found' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply({ status: 401, error: 'Unauthorized', message: 'TOKEN_MISSING' }, { status: 401 })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>M-ONE</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a read that does not reach the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new MOneTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number M-ONE does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(unknownNumber());
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-05T16:12:03' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('PL000000014HU')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers M-ONE does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['PL00000001RS', 'PL000000014SR', 'RS22002201679', '000000014RS', `PL${'0'.repeat(70)}RS`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMOneNumber('pl 000-000-014 rs')).toBe(DELIVERED);
    // The letters RS and twelve digits, the number of the reply the page shows when its lookup fails.
    expect(normalizeMOneNumber('RS000000000000')).toBe('RS000000000000');
  });

  it('routes a number filed under M-ONE to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'm-one' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'm-one', source: 'm-one', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${M_ONE_API}${DELIVERED}`)).toBe(true);
  });
});

describe('M-ONE numbers', () => {
  it('leaves Serbian S10 numbers with postal detection and asks M-ONE with Pošta Srbije first', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    const asked = recognitionCandidates(DELIVERED).map(({ carrier, preferred }) => ({ carrier, preferred }));
    expect(asked[0]).toEqual({ carrier: 'posta-srbije', preferred: true });
    expect(asked.slice(0, 5)).toContainEqual({ carrier: 'm-one', preferred: false });
    // A failed check digit, or another country's code, does not suggest M-ONE.
    expect(recognitionCandidates('PL000000015RS').map(({ carrier }) => carrier)).not.toContain('m-one');
    expect(recognitionCandidates('PL000000014HU').map(({ carrier }) => carrier)).not.toContain('m-one');
  });
});

describe('M-ONE status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(mOneStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'm-one', providerCode: 'ST35', description: 'Pokušaj uručenja (primaocu ostavljeno obaveštenje)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'm-one', providerCode: 'ST99', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(mOneStage('st07', 'Uručena pošiljka')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(mOneStage('ST99', 'Synthetic note')).toBeNull();
  });
});

describe('M-ONE links', () => {
  it('name M-ONE for its two shapes only', () => {
    for (const number of ['PL000000028RS', 'RS000000000001']) {
      expect(parseTrackingInput(`https://m-one.rs/en?${number}`), number).toMatchObject({ trackingNumber: number, carrier: 'm-one', source: 'link' });
    }
    for (const number of ['SAMPLE1', 'PL00000002RS']) expect(parseTrackingInput(`https://m-one.rs/en?${number}`).carrier, number).not.toBe('m-one');
  });
});
