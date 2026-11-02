import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BUSSGODS_API, BussgodsTracker } from './adapter.js';
import { normalizeBussgodsNumber, parseBussgods } from './parser.js';
import { bussgodsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BG9000000018';
const IN_TRANSIT = 'BG9000000026';
const UNKNOWN = 'BG9000000000';

type Row = Record<string, unknown>;
type Reply = { Information: Row; Statuses: Row[] };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, status = 200, type = 'application/json; charset=utf-8') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Bussgods tracking adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BussgodsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bg 9000-000-026 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BUSSGODS_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bussgods', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, dating every scan in Sweden and keeping the agent it was handed out at', () => {
    const result = parseBussgods(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Utbetald',
      last_update: '2026-10-28T08:00:05+01:00', expected_delivery: null, delivered_at: '2026-10-27T14:48:31+01:00',
      pickup_point: 'Sample Agent Sampleby', service_name: 'Sample Freight', events: expect.any(Array),
    });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location])).toEqual([
      // The cash-on-delivery payout moves nothing.
      ['2026-10-28T08:00:05+01:00', '6', null, 'SAMPLEBY'],
      ['2026-10-27T14:48:31+01:00', '13', 'delivered', 'SAMPLEBY'],
      ['2026-10-26T09:12:00+01:00', '10', 'ready_for_pickup', 'SAMPLEBY'],
      // The hour the clocks go back reads as its first occurrence.
      ['2026-10-25T02:30:00+02:00', '12', 'in_transit', 'TESTVIK'],
      ['2026-10-23T01:14:40+02:00', '12', 'in_transit', 'TESTVIK'],
      // The hand-in scan of each parcel is kept once.
      ['2026-10-22T16:05:12+02:00', '11', 'accepted', 'EXEMPELSTAD'],
    ]);
    expect(result.events![1]).toEqual({ time: '2026-10-27T14:48:31+01:00', location: 'SAMPLEBY', description: 'Utlämnad',
      provider_code: '13', stage: 'delivered', stage_source: 'carrier_map' });
    // The parcel numbers stay out.
    expect(JSON.stringify(result)).not.toMatch(/9000000018000/);
  });

  it('reads a fraktsedel on its way, without a product or an agent, and leaves an agent drop unstaged', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'På väg till ombud/kund',
      last_update: '2026-03-30T11:45:00+02:00', expected_delivery: null });
    expect(result).not.toHaveProperty('service_name');
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-03-30T11:45:00+02:00', '18', 'in_transit'],
      ['2026-03-30T04:20:00+02:00', '12', 'in_transit'],
      ['2026-03-27T17:30:00+01:00', '26', null],
      ['2026-03-27T10:02:40+01:00', '25', 'in_transit'],
      ['2026-03-27T10:02:11+01:00', '24', 'accepted'],
    ]);
  });

  it('names the agent a parcel waits at, but not the station the page names none for or a door delivery', () => {
    const waiting = edited('delivered', (body) => { body.Statuses.splice(5); });
    expect(parseBussgods(waiting, DELIVERED)).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Sample Agent Sampleby' });
    const unnamed = edited('delivered', (body) => { body.Statuses.splice(5); body.Statuses[4]!.StationNumber = 5399; });
    expect(parseBussgods(unnamed, DELIVERED)).not.toHaveProperty('pickup_point');
    const door = parseBussgods(edited('delivered', (body) => {
      Object.assign(body.Statuses[5]!, { StatusCode: 14, StatusDescription: 'Utkörd' });
    }), DELIVERED);
    expect(door).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-10-27T14:48:31+01:00' });
    expect(door).not.toHaveProperty('pickup_point');
    // A delivery that was not the next movement after the arrival names no agent either.
    const sentOn = parseBussgods(edited('delivered', (body) => {
      body.Statuses.splice(5, 0, { ...body.Statuses[3]!, Timestamp: '2026-10-26T18:00:00' });
    }), DELIVERED);
    expect(sentOn).toMatchObject({ current_stage: 'delivered' });
    expect(sentOn).not.toHaveProperty('pickup_point');
  });

  it('binds the reply to the fraktsedel asked, with or without its BG', () => {
    expect(parseBussgods(edited('delivered', (body) => { body.Information.ShipmentNumber = '9000000018'; }), DELIVERED).events).toHaveLength(6);
    expect(parseBussgods(fixture('delivered'), '9000000018').events).toHaveLength(6);
    expect(parseBussgods(edited('delivered', (body) => { body.Information.ShipmentNumber = null; }), DELIVERED).events).toHaveLength(6);
    expect(() => parseBussgods(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Bussgods answered for another shipment' }));
    expect(() => parseBussgods(edited('delivered', (body) => { body.Statuses[3]!.ShipmentNumber = IN_TRANSIT; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBussgods(edited('not-found', (body) => { body.Information.ShipmentNumber = IN_TRANSIT; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Scans that no field ties to a number cannot be bound.
    expect(() => parseBussgods(edited('delivered', (body) => {
      body.Information.ShipmentNumber = null;
      for (const row of body.Statuses) row.ShipmentNumber = null;
    }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads an unknown number as not found, and a fraktsedel without scans as no history', async () => {
    expect(() => parseBussgods(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The tracker names the number asked when it does not take it for an online fraktsedel.
    expect(() => parseBussgods(edited('not-found', (body) => { body.Information.ShipmentNumber = '9000000000'; }), '9000000000'))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBussgods(edited('delivered', (body) => { body.Statuses = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps an offset the reply gives and reads fractions of a second off the wall clock', () => {
    const result = parseBussgods(edited('in-transit', (body) => {
      body.Statuses[4]!.Timestamp = '2026-03-30T09:45:00Z';
      body.Statuses[3]!.Timestamp = '2026-03-30T04:20:00.1234567';
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2).map((event) => event.time)).toEqual(['2026-03-30T09:45:00Z', '2026-03-30T04:20:00+02:00']);
  });

  it('rejects a changed reply', () => {
    for (const payload of [[], null, 'sample', { Information: null, Statuses: [] }, { Information: {}, Statuses: {} },
      edited('delivered', (body) => { body.Information.ShipmentNumber = 9000000018; }),
      edited('delivered', (body) => { body.Information.ProductCode = '1'; }),
      edited('delivered', (body) => { body.Information.ParcelNumbers = 'sample'; }),
      edited('delivered', (body) => { body.Statuses = Array.from({ length: 501 }, () => body.Statuses[0]!); }),
      edited('delivered', (body) => { body.Statuses[0] = 'scan' as never; }),
      edited('delivered', (body) => { body.Statuses[0]!.StatusCode = null; }),
      edited('delivered', (body) => { body.Statuses[0]!.StatusCode = '11'; }),
      edited('delivered', (body) => { body.Statuses[0]!.StatusCode = -1; }),
      edited('delivered', (body) => { body.Statuses[0]!.StatusDescription = ' '; }),
      edited('delivered', (body) => { body.Statuses[0]!.StatusDescription = ['Inlämnad']; }),
      edited('delivered', (body) => { body.Statuses[0]!.Timestamp = null; }),
      edited('delivered', (body) => { body.Statuses[0]!.Timestamp = '/Date(1792677912000)/'; }),
      edited('delivered', (body) => { body.Statuses[0]!.Timestamp = '2026-02-30T10:00:00'; }),
      edited('delivered', (body) => { body.Statuses[0]!.CityName = 7; }),
      edited('delivered', (body) => { body.Statuses[0]!.StationNumber = 'sample'; })]) {
      expect(() => parseBussgods(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a moved route, a browser check and a broken reply apart from a missing parcel', async () => {
    const lookup = (body: unknown, status?: number, type?: string) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type))).track({ number: UNKNOWN });
    await expect(lookup({ Message: 'No HTTP resource was found that matches the request URI.' }, 404)).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup('', 301)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(`\uFEFF${text('delivered')}`))).track({ number: DELIVERED }))
      .resolves.toMatchObject({ status: 'delivered' });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
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
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('takes ten digits with or without BG, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BG900000001', 'BG90000000180', 'BX9000000018', '900000001', 'SAMPLETRACKING', `BG${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBussgodsNumber(' bg 900 000 0018 ')).toBe(DELIVERED);
    expect(normalizeBussgodsNumber('9000-000-018')).toBe('9000000018');
  });

  it('recognizes a known fraktsedel and an unknown one from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-28T07:00:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked first about a BG9 number, which detection only suggests, and reads the tracker links', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['bussgods']) });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('bussgods');
    expect(recognitionAskedCarriers('9000000018')).not.toContain('bussgods');
    expect(parseTrackingInput(`https://bussgods.se/spara-paket/#${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'bussgods' });
    expect(parseTrackingInput(`https://bussgods.se/foretag/sok-paket/${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'bussgods' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => reply(String(url).endsWith(DELIVERED) ? text('delivered') : text('not-found')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'bussgods' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bussgods', source: 'bussgods', result: { current_stage: 'delivered' } });
  });
});

type Entry = { code?: string; wording: string; stage?: string };

describe('Bussgods status vocabulary', () => {
  it('maps every code and wording it recorded to the stage recorded for it, and leaves the others out on purpose', () => {
    for (const entry of statuses.entries as Entry[]) {
      const code = entry.code ?? null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(bussgodsStage(code ?? '', entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
      expect(statusMapAnswer({ carrier: 'bussgods', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    // The older codes are read by their wording; a code the map has no stage for falls to it too.
    expect(statusMapAnswer({ carrier: 'bussgods', providerCode: '1', description: 'Inlämnad' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'bussgods', providerCode: '99', description: 'Utkörd' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'bussgods', providerCode: '99', description: 'Sample note' })).toEqual({ kind: 'unknown' });
    expect(bussgodsStage('99', 'Sample note')).toBeNull();
  });
});
