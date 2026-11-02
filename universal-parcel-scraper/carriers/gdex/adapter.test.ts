import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GDEX_API, GdexTracker } from './adapter.js';
import { gdexWording, normalizeGdexNumber, parseGdex } from './parser.js';
import { gdexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'MY00000000017';
const IN_TRANSIT = 'MY00000000024';
const UNKNOWN = 'MY00000000031';

type Row = Record<string, unknown>;
type Entry = Row & { trackingNumber: string; valid: unknown; data: (Row & { trackStatuses: Row[] }) | null };
type Reply = { data: Entry[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const entry = (body: Reply) => body.data[0]!;
const scans = (body: Reply) => entry(body).data!.trackStatuses;
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('GDEX HTTP adapter', () => {
  it('asks the app’s tracking search for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GdexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' my 0000 0000 024 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GDEX_API}?search=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gdex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history on Malaysia’s clock, with a failed round the category files as in transit', () => {
    const result = parseGdex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-06T15:12:40+08:00', expected_delivery: null,
      delivered_at: '2026-05-06T15:12:40+08:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('history_truncated');
    // The repeated hub scan is kept once.
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-05-06T15:12:40+08:00', 'Delivered', 'delivered', 'Taman Contoh'],
      ['2026-05-06T09:05:11+08:00', 'Out For Delivery', 'out_for_delivery', 'Taman Contoh'],
      ['2026-05-06T06:31:02+08:00', 'In Transit', 'in_transit', 'Taman Contoh'],
      ['2026-05-05T17:02:56+08:00', 'In Transit', 'in_transit', 'Contoh Department'],
      ['2026-05-05T16:20:44+08:00', 'In Transit', 'failed_attempt', 'Taman Contoh'],
      ['2026-05-05T08:47:09+08:00', 'Out For Delivery', 'out_for_delivery', 'Taman Contoh'],
      ['2026-05-05T06:02:53+08:00', 'In Transit', 'in_transit', 'Taman Contoh'],
      ['2026-05-04T21:14:37+08:00', 'In Transit', 'in_transit', 'Contoh Hub'],
      ['2026-05-04T20:40:05+08:00', 'In Transit', 'in_transit', 'Contoh Hub'],
      ['2026-05-04T19:58:21+08:00', 'In Transit', 'in_transit', 'CTH Hub (Bandar Contoh)'],
      ['2026-05-04T17:45:18+08:00', 'Pickup', 'accepted', 'Bandar Contoh'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events![4]).toMatchObject({ description: 'Unsuccessful delivery due to Customer Request for Rescheduled Delivery' });
  });

  it('reads a consignment between hubs', () => {
    const result = parseGdex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Outbound by Contoh Hub', last_update: '2026-05-12T03:09:00+08:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted']);
  });

  it('turns a history listed oldest first round', () => {
    const result = parseGdex(changed('in-transit', (body) => { scans(body).reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-05-12T03:09:00+08:00', last_status_text: 'Outbound by Contoh Hub' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Picked up by courier' });
  });

  it('leaves an unfamiliar wording under the coarse category without a stage', () => {
    const result = parseGdex(changed('in-transit', (body) => {
      scans(body).unshift({ description: 'Synthetic note', updatedAt: '2026-05-12T04:00:00', location: 'Contoh Hub', status: 'In Transit' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note', last_update: '2026-05-12T04:00:00+08:00' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![0]).toMatchObject({ provider_code: 'In Transit' });
  });

  it('takes the person a delivery names, receivers, signers and phone numbers out of a scan’s wording', () => {
    expect(gdexWording('Delivered to Penerima Contoh')).toBe('Delivered');
    expect(gdexWording('Delivered (Penerima Contoh)')).toBe('Delivered');
    expect(gdexWording('Delivered, received by Penerima Contoh')).toBe('Delivered');
    expect(gdexWording('Returned to shipper - signed by Pengirim Contoh')).toBe('Returned to shipper');
    expect(gdexWording('Unsuccessful delivery due to Receiver not present 012-000 0000')).toBe('Unsuccessful delivery due to Receiver not present');
    expect(gdexWording('Call +60 12-000 0000 to reschedule')).toBe('Call to reschedule');
    // Sites and short numbers stay.
    expect(gdexWording('Inbound by CTH Hub (Bandar Contoh)')).toBe('Inbound by CTH Hub (Bandar Contoh)');
    expect(gdexWording('Outbound from Station 12')).toBe('Outbound from Station 12');
    expect(gdexWording('  Delivered  ')).toBe('Delivered');
  });

  it('reads the app’s invalid answer as not found', () => {
    expect(() => parseGdex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGdex(changed('not-found', (body) => { delete (entry(body) as Row).data; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const rows of [[], null]) {
      expect(() => parseGdex(changed('delivered', (body) => { entry(body).data!.trackStatuses = rows as never; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('counts an entry only when it names the number asked', () => {
    expect(() => parseGdex(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GDEX answered for another consignment' }));
    expect(() => parseGdex(changed('delivered', (body) => { body.data.push(structuredClone(entry(body))); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GDEX answered for another consignment' }));
    expect(() => parseGdex(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A search for several numbers answers each in turn.
    const both = changed('delivered', (body) => { body.data.unshift(entry(fixture('in-transit'))); });
    expect(parseGdex(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(parseGdex(changed('delivered', (body) => { entry(body).trackingNumber = ` ${DELIVERED.toLowerCase()} `; }), DELIVERED).events)
      .toHaveLength(11);
  });

  it('rejects a changed reply', () => {
    const scan = (body: Reply) => scans(body)[0]!;
    for (const change of [
      (body: Reply) => { body.data = 'entries' as never; },
      (body: Reply) => { body.data = []; },
      (body: Reply) => { body.data[0] = 'entry' as never; },
      (body: Reply) => { delete (entry(body) as Row).trackingNumber; },
      (body: Reply) => { delete (entry(body) as Row).valid; },
      (body: Reply) => { entry(body).valid = 'true'; },
      (body: Reply) => { entry(body).valid = false; },
      (body: Reply) => { entry(body).data = 'record' as never; },
      (body: Reply) => { entry(body).data = null; },
      (body: Reply) => { entry(body).data!.trackStatuses = 'scans' as never; },
      (body: Reply) => { entry(body).data!.trackStatuses = Array.from({ length: 501 }, () => scan(body)); },
      (body: Reply) => { scans(body)[0] = 'scan' as never; },
      (body: Reply) => { scan(body).updatedAt = '2026-05-06'; },
      (body: Reply) => { scan(body).updatedAt = '2026-02-30T10:00:00'; },
      (body: Reply) => { scan(body).updatedAt = '2026-05-06T24:00:00'; },
      (body: Reply) => { scan(body).updatedAt = '2026-05-06T15:12:40+08:00'; },
      (body: Reply) => { delete scan(body).updatedAt; },
      (body: Reply) => { scan(body).description = 7; },
      (body: Reply) => { scan(body).description = ''; },
      (body: Reply) => { scan(body).location = 5; },
      (body: Reply) => { scan(body).status = ['Delivered']; },
    ]) {
      expect(() => parseGdex(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', [], {}, null]) {
      expect(() => parseGdex(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The app reads an unknown number from HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup({ message: 'The route could not be found.' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://gdexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>GDEX</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ message: 'Too Many Attempts.' }, { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the invalid answer, and asks nothing for a number GDEX does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-06T07:12:40.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('MY0000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers GDEX does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['MY0000000001', 'MY000000000170', 'SG00000000017', '000000001', 'SAMPLETRACKING', `MY${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGdexNumber('my 0000 0000 017')).toBe(DELIVERED);
    expect(normalizeGdexNumber('0000-000-017')).toBe('0000000017');
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a GDEX number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gdex', source: 'gdex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(GDEX_API))).toBe(true);
  });
});

describe('GDEX numbers', () => {
  it('claims MY and eleven digits, and leaves ten digits to the carriers that share them', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'gdex', confidence: 'high' });
    expect(detectCarrierMatch('0000000017')?.carrier).not.toBe('gdex');
  });
});

describe('GDEX status vocabulary', () => {
  it('records every category and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? '';
      if (entry.unmapped) {
        expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        continue;
      }
      expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(gdexStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gdex', providerCode: 'In Transit', description: 'Unsuccessful delivery due to Customer Request for Rescheduled Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'gdex', providerCode: 'In Transit', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A wording the map does not know falls to its category, then to the shared rules.
    expect(gdexStage('Delivered', 'Synthetic note')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(gdexStage('In Transit', 'Returned to shipper')).toEqual({ stage: 'returned', source: 'wording:returned' });
    expect(gdexStage('In Transit', 'Synthetic note')).toBeNull();
    expect(gdexStage('', 'OUT FOR DELIVERY')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
  });
});
