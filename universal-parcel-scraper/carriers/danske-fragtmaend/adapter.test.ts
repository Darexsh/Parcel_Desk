import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DANSKE_FRAGTMAEND_API, DanskeFragtmaendTracker } from './adapter.js';
import { normalizeDanskeFragtmaendNumber, parseDanskeFragtmaend } from './parser.js';
import { danskeFragtmaendStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ123457';
const IN_TRANSIT = 'ZZ654321';
const UNKNOWN = 'ZZ000000';
const COLLI = `00000000000000000002${DELIVERED}`;
const UNKNOWN_COLLI = `00000000000000000009${UNKNOWN}`;

type Row = Record<string, unknown>;
type Reply = Row & { ConsignmentNote: Row & { Goods: (Row & { ColliCodes: Row[] })[]; DeliveryTime: Row }; ConsignmentNoteTraces: Row[] };
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
const consignmentUrl = (number: string) => `${DANSKE_FRAGTMAEND_API}GetByConsignmentNumber?consignmentNumber=${number}&language=2`;
const colliUrl = (number: string) => `${DANSKE_FRAGTMAEND_API}GetByColliCode?colliCode=${number}&language=2`;
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Danske Fragtmænd tracking adapter', () => {
  it('asks the page’s lookup for the whole number once, in English, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DanskeFragtmaendTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 654-321 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(consignmentUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'danske-fragtmaend', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, dating every scan in Denmark and leaving out the earlier note’s scan', () => {
    const result = parseDanskeFragtmaend(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Consignment delivered to the recipient.', last_update: '2026-06-10T10:58:21+02:00', expected_delivery: null,
      delivered_at: '2026-06-10T10:58:21+02:00', weight_kg: 42.5 });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-06-10T10:58:21+02:00', 'LEV', 'delivered'],
      ['2026-06-10T08:50:40+02:00', 'OMX', 'out_for_delivery'],
      ['2026-06-10T08:36:54+02:00', 'KTU', 'in_transit'],
      ['2026-06-10T03:39:32+02:00', 'ANK', 'in_transit'],
      ['2026-06-10T01:00:48+02:00', 'ANK', 'in_transit'],
      ['2026-06-09T15:06:17+02:00', 'AFH', 'accepted'],
      ['2026-06-09T14:10:08+02:00', 'DAT', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2026-06-10T10:58:21+02:00', description: 'Consignment delivered to the recipient.',
      provider_code: 'LEV', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    // The delivery's coordinates, the goods, their value and the sender's reference stay out.
    expect(JSON.stringify(result)).not.toMatch(/55\.0001|Sample goods|SAMPLE-REF|99\.5|2024-10-30/);
  });

  it('reads a consignment out again after a failed attempt, with the delivery day it expects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-12-02T09:40:01+01:00',
      expected_delivery: '2026-12-01', weight_kg: 10 });
    // The reply sets its delivery date at the failed attempt.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['OMX', 'out_for_delivery'], ['FIH', 'failed_attempt'], ['OMX', 'out_for_delivery'], ['AFH', 'accepted'], ['DAT', 'registered'],
    ]);
  });

  it('looks a collicode up as a parcel and binds the reply to the whole code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(fetcher).track({ number: COLLI })).resolves.toMatchObject({ current_stage: 'delivered', canonical_tracking_number: DELIVERED });
    expect(String(fetcher.mock.calls[0]![0])).toBe(colliUrl(COLLI));
    // A note that lists its collicodes must list the one asked; a note without any is bound by its number.
    expect(() => parseDanskeFragtmaend(fixture('delivered'), `00000000000000000004${DELIVERED}`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Danske Fragtmænd answered for another consignment' }));
    expect(parseDanskeFragtmaend(edited('delivered', (body) => { body.ConsignmentNote.Goods = []; }), `00000000000000000004${DELIVERED}`))
      .toMatchObject({ canonical_tracking_number: DELIVERED });
    expect(() => parseDanskeFragtmaend(fixture('delivered'), `00000000000000000002${IN_TRANSIT}`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDanskeFragtmaend(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseDanskeFragtmaend(edited('delivered', (body) => { body.ConsignmentNote.ConsignmentNumber = 'zz123457'; }), DELIVERED).events)
      .toHaveLength(7);
  });

  it('reads a repeated wall clock as its first occurrence and leaves out the booked delivery windows', () => {
    const result = parseDanskeFragtmaend(edited('in-transit', (body) => {
      body.ConsignmentNote.ConsignmentDate = '2026-10-25T00:00:00';
      body.ConsignmentNoteTraces.push({ ...body.ConsignmentNoteTraces[4], Date: '2026-10-25T02:30:00.5' });
      body.ConsignmentNoteTraces.unshift({ ...body.ConsignmentNoteTraces[0], EventCode: 'DO2', EventCodeText: 'Sample window', Date: '2026-12-02T10:00:00' });
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: 'OMX' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-10-25T02:30:00+02:00', provider_code: 'DAT' });
  });

  it('stages an unmapped code by its delivered or cancelled icon, else by its wording, and keeps a place the scan names', () => {
    const result = parseDanskeFragtmaend(edited('in-transit', (body) => {
      Object.assign(body.ConsignmentNoteTraces[0]!, { EventCode: 'LFF', EventCodeText: 'Sample handover', Status: 3, CargoHubDisplayText: 'Sample Terminal' });
      Object.assign(body.ConsignmentNoteTraces[1]!, { EventCode: 'ZZZ', EventCodeText: 'Sample note', Status: 6, Location: 'Sampleby' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-12-02T09:40:01+01:00', expected_delivery: null });
    expect(result.events![0]).toMatchObject({ location: 'Sample Terminal', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![1]).toEqual({ time: '2026-12-01T14:01:46+01:00', location: 'Sampleby', description: 'Sample note', provider_code: 'ZZZ' });
    expect(danskeFragtmaendStage('ZZZ', 7, 'Sample note')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(danskeFragtmaendStage('ZZZ', 2, 'Out for delivery')).toEqual({ stage: 'out_for_delivery', source: expect.stringMatching(/^wording:/) });
    expect(danskeFragtmaendStage('', null, 'Sample note')).toBeNull();
  });

  it('puts the page’s notice over a cancelled consignment, with or without scans', () => {
    expect(parseDanskeFragtmaend(edited('in-transit', (body) => { body.State = 'Annulleret'; }), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'The shipment is cancelled', expected_delivery: null });
    expect(parseDanskeFragtmaend(edited('in-transit', (body) => { body.State = 'Annulleret'; body.ConsignmentNoteTraces = []; }), IN_TRANSIT))
      .toEqual({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'The shipment is cancelled',
        last_update: null, expected_delivery: null, weight_kg: 10, summary_only: true, events: [] });
    expect(() => parseDanskeFragtmaend(edited('in-transit', (body) => { body.ConsignmentNoteTraces = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const payload of [[], null, 'sample', { ConsignmentNote: null },
      edited('delivered', (body) => { delete body.ConsignmentNote.ConsignmentNumber; }),
      edited('delivered', (body) => { body.ConsignmentNote.ConsignmentNumber = 7; }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces = {} as never; }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces = Array.from({ length: 501 }, () => body.ConsignmentNoteTraces[0]!); }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces[0] = 'scan' as never; }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces[0]!.Date = null; }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces[0]!.Date = '10-06-2026 10:58'; }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces[0]!.Date = '2026-06-10T10:58:21Z'; }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces[0]!.Date = '2026-02-30T10:58:21'; }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces[0]!.EventCodeText = ['Delivered']; }),
      edited('delivered', (body) => { Object.assign(body.ConsignmentNoteTraces[0]!, { EventCode: null, EventCodeText: ' ' }); }),
      edited('delivered', (body) => { body.ConsignmentNoteTraces[0]!.Status = '3'; }),
      edited('delivered', (body) => { body.State = 1; })]) {
      expect(() => parseDanskeFragtmaend(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A goods line without a weight drops the total; a missing date or estimate drops nothing else.
    const bare = parseDanskeFragtmaend(edited('in-transit', (body) => {
      body.ConsignmentNote.Goods[0]!.Weight = null;
      delete body.ConsignmentNote.ConsignmentDate;
      body.ConsignmentNote.DeliveryTime = null as never;
    }), IN_TRANSIT);
    expect(bare).not.toHaveProperty('weight_kg');
    expect(bare).toMatchObject({ expected_delivery: null, current_stage: 'out_for_delivery' });
  });

  it('keeps a missing consignment, a moved route, an invalid code, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, status?: number, type?: string, number = UNKNOWN) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type))).track({ number });
    await expect(lookup(text('not-found'), 404)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ Message: `Failed to find consignment from the given collicode: ${UNKNOWN_COLLI}` }, 404, undefined, UNKNOWN_COLLI))
      .rejects.toMatchObject({ kind: 'not_found' });
    // A 404 that does not name the number asked is not the tracker's answer.
    await expect(lookup({ Message: 'Couldn\'t find fragtbrev with number: ZZ999999' }, 404)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 - File or directory not found.</title></html>', 404, 'text/html')).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', 301)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ Message: `Colli code is not valid: ${UNKNOWN_COLLI}` }, 400, undefined, UNKNOWN_COLLI)).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('"No value for consignmentNumber!"', 400)).rejects.toMatchObject({ kind: 'schema', status: 400 });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered')}`, 200, undefined, DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(COLLI)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(COLLI)).rejects.toMatchObject({ kind });
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

  it('takes consignment note numbers and collicodes, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['Z1234567', 'ZZ12345', 'ZZ1234567', '0000000000000000000ZZ123456', '000000000000000000000ZZ123456', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDanskeFragtmaendNumber(' 0000 0000 0000 0000 0002 zz123457 ')).toEqual({ number: COLLI, kind: 'colli' });
    expect(normalizeDanskeFragtmaendNumber('zz-123-457')).toEqual({ number: DELIVERED, kind: 'consignment' });
  });

  it('recognizes a known collicode and an unknown one from plain HTTP, and does not ask about a bare consignment number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered')))
      .mockResolvedValueOnce(reply({ Message: `Failed to find consignment from the given collicode: ${UNKNOWN_COLLI}` }, 404));
    await expect(carrier(fetcher).recognize!(COLLI)).resolves.toEqual({ known: true, lastActivityAt: '2026-06-10T08:58:21.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN_COLLI)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a detected collicode, or a number filed under Danske Fragtmænd, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => reply(String(url).includes('GetByColliCode') || String(url).includes(DELIVERED)
      ? text('delivered') : text('not-found'), String(url).includes(DELIVERED) ? 200 : 404));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: COLLI }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'danske-fragtmaend', source: 'danske-fragtmaend', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED, carrier: 'danske-fragtmaend' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'danske-fragtmaend', source: 'danske-fragtmaend' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === colliUrl(COLLI))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url) === consignmentUrl(DELIVERED))).toBe(true);
  });

  it('claims the collicode only, which detection settles without recognition, and reads both tracker links', () => {
    expect(detectCarrierMatch(COLLI)).toMatchObject({ carrier: 'danske-fragtmaend', confidence: 'high' });
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('danske-fragtmaend');
    expect(recognitionAskedCarriers(COLLI)).toEqual([]);
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('danske-fragtmaend');
    expect(parseTrackingInput(`https://trace.fragt.dk/${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'danske-fragtmaend' });
    expect(parseTrackingInput(`https://trace.fragt.dk/colli/${COLLI}`)).toMatchObject({ trackingNumber: COLLI, carrier: 'danske-fragtmaend' });
  });
});

type Entry = { code?: string; wording: string; stage?: string; unmapped?: boolean };

describe('Danske Fragtmænd status vocabulary', () => {
  it('maps every code it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries as Entry[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(danskeFragtmaendStage(entry.code, 2, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'danske-fragtmaend', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'danske-fragtmaend', providerCode: 'ZZZ', description: 'Sample note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage(null, 'consignment delivered to the recipient.')).toBeUndefined();
    expect(danskeFragtmaendStage('lev', null, 'Sample')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
