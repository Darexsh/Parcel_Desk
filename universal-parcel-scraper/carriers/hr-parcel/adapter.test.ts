import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HR_PARCEL_API, HrParcelTracker, hrParcelLookupUrl } from './adapter.js';
import { normalizeHrParcelNumber, parseHrParcel } from './parser.js';
import { hrParcelStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '19900000000123';
const IN_TRANSIT = '19000000000456';
const UNKNOWN = '19900000000000';

type Row = Record<string, unknown>;
type Reply = Row & { shipment: Row; steps: Row[]; response: Row & { BarcodeList: Row[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// WordPress serves the action's JSON as HTML.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('HR Parcel HTTP adapter', () => {
  it('asks the tracking page’s barcode search for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HrParcelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1900 0000 0004-56 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HR_PARCEL_API}?action=api-hrparcel-tracking&api-method=get&api-action=barcode&q=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hr-parcel', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(hrParcelLookupUrl('IHB000000001')).toContain('&q=IHB000000001');
  });

  it('reads a door delivery after a failed attempt and a hold, without the record the page does not show', () => {
    const result = parseHrParcel(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Spedizione Consegnata', last_update: null, last_update_local: '2026-03-12T17:24:50' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-03-12T17:24:50', '1003', 'delivered', 'MILANO (MI)'],
      ['2026-03-12T09:47:33', '1002', 'out_for_delivery', 'Milano (MI)'],
      ['2026-03-10T07:49:36', '1007', 'ready_for_pickup', 'Milano (MI)'],
      ['2026-03-09T17:20:29', '1015', 'failed_attempt', 'MILANO (MI)'],
      ['2026-03-09T08:31:53', '1002', 'out_for_delivery', 'Milano (MI)'],
      // The repeated branch scan is kept once.
      ['2026-03-09T06:12:00', '1010', 'in_transit', 'Milano (MI)'],
      ['2026-03-07T18:05:50', '1001', 'accepted', null],
      ['2026-03-05T14:51:36', '1000', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Signer|SYNTHETIC-ORDER|Synthetic item|X00000001|Hub Sintetico|0\.75/);
  });

  it('binds one barcode of a shipment of several and gives a town its province once', () => {
    const result = parseHrParcel(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrivata in Filiale',
      last_update_local: '2026-04-02T07:12:49' });
    expect(result.events!.map((event) => [event.provider_code, event.location ?? null])).toEqual([
      ['1010', 'Firenze (FI)'], ['1001', null], ['1000', null],
    ]);
    expect(parseHrParcel(fixture('in-transit'), '19000000000449').events).toHaveLength(3);
  });

  it('stages a collection, a held parcel and a lost one by their codes', () => {
    const collected = parseHrParcel(changed('in-transit', (body) => {
      body.steps.unshift(
        { code: 1021, status: 'Ritirato dal Destinatario', originalDate: '2026-04-09T10:00:00', town: 'Firenze (FI)', completed: true },
        { code: 1020, status: 'Disponibile per il Ritiro', originalDate: '2026-04-03T08:00:00', town: 'Firenze (FI)', completed: true },
      );
    }), IN_TRANSIT);
    expect(collected.events!.slice(0, 2).map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup']);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    const held = parseHrParcel(changed('in-transit', (body) => {
      body.steps.unshift({ code: 1007, status: 'In Giacenza', originalDate: '2026-04-03T08:00:00', town: 'Firenze (FI)' });
    }), IN_TRANSIT);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'In Giacenza' });
    const lost = parseHrParcel(changed('in-transit', (body) => {
      body.steps.unshift({ code: 1009, status: 'Smarrimento/Furto', originalDate: '2026-04-05T17:21:15', town: 'Firenze (FI)' });
    }), IN_TRANSIT);
    expect(lost).toMatchObject({ status: 'exception', current_stage: 'exception' });
    // A code the map does not know falls to the shared wording rules.
    const unmapped = parseHrParcel(changed('in-transit', (body) => {
      body.steps.unshift({ code: 1999, status: 'Nota sintetica', originalDate: '2026-04-05T17:21:15', town: '' });
    }), IN_TRANSIT);
    expect(unmapped).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Nota sintetica' });
    expect(unmapped.events![0]!.stage).toBeUndefined();
  });

  it('orders the scans newest first and drops a fraction of a second', () => {
    const result = parseHrParcel(changed('in-transit', (body) => {
      body.steps.reverse();
      body.steps[0]!.originalDate = '2026-03-30T14:51:36.517';
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-04-02T07:12:49', '2026-04-01T17:09:50', '2026-03-30T14:51:36']);
  });

  it('reads an unknown number as not found, a booked shipment without scans as no history and a service error as inconclusive', () => {
    expect(() => parseHrParcel(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHrParcel(changed('in-transit', (body) => { body.steps = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseHrParcel(changed('not-found', (body) => {
      body.response.InternalError = { ErrorCode: 0, ErrorDescription: 'Synthetic failure' };
    }), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when the number asked is among its barcodes', () => {
    expect(() => parseHrParcel(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHrParcel(changed('in-transit', (body) => { body.response.BarcodeList = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The sender's own barcode on the record is not the number HR Parcel searched.
    expect(() => parseHrParcel(fixture('delivered'), 'X00000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A sender's label number HR Parcel tracks under is matched in capitals.
    const partner = changed('in-transit', (body) => { body.response.BarcodeList = [{ Barcode: 'IHB000000001', CustomerBarcode: '' }]; });
    expect(parseHrParcel(partner, 'ihb000000001').events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).shipment; },
      (body: Reply) => { body.steps = null as never; },
      (body: Reply) => { delete (body as Row).response; },
      (body: Reply) => { body.shipment.id = '10000456'; },
      (body: Reply) => { body.shipment.id = null; },
      (body: Reply) => { delete (body.response as Row).BarcodeList; },
      (body: Reply) => { body.response.BarcodeList = [{ Barcode: 19000000000456 }]; },
      (body: Reply) => { body.steps = Array.from({ length: 501 }, () => body.steps[0]!); },
      (body: Reply) => { body.steps[0] = 'scan' as never; },
      (body: Reply) => { body.steps[0]!.originalDate = '02/04/2026 07:12'; },
      (body: Reply) => { body.steps[0]!.originalDate = '2026-04-02T24:00:00'; },
      (body: Reply) => { body.steps[0]!.originalDate = '0001-01-01T00:00:00'; },
      (body: Reply) => { delete body.steps[0]!.originalDate; },
      (body: Reply) => { body.steps[0]!.status = ''; },
      (body: Reply) => { body.steps[0]!.status = ['Arrivata in Filiale']; },
      (body: Reply) => { body.steps[0]!.town = { name: 'Firenze' }; },
    ]) {
      expect(() => parseHrParcel(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a missing route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The search answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.hrparcel.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // WordPress's answer for an action no plugin registers.
    await expect(lookup('0', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<p>Si è verificato un errore critico sul tuo sito web.</p>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('[]')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number HR Parcel does not track', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1990-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers HR Parcel does not track and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1990000', 'SAMPLETRACKING', `1${'0'.repeat(40)}`, '1990/0000/0000/00']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHrParcelNumber('ihb 000-000.001')).toBe('IHB000000001');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under HR Parcel to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'hr-parcel' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'hr-parcel', source: 'hr-parcel', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === hrParcelLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('HR Parcel status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries.filter((candidate) => 'code' in candidate)) {
      const code = (entry as { code: string }).code;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(hrParcelStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'hr-parcel', providerCode: '1007', description: 'In Giacenza, disponibile per Ritiro' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'hr-parcel', providerCode: '1999', description: 'Nota sintetica' })).toEqual({ kind: 'unknown' });
    expect(hrParcelStage('1999', 'Spedizione Consegnata')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(hrParcelStage('1999', 'Nota sintetica')).toBeNull();
  });
});
