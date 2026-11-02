import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FG_DELIVERY_API, fgDeliveryLookupUrl, FgDeliveryTracker } from './adapter.js';
import { normalizeFgDeliveryNumber, parseFgDelivery } from './parser.js';
import { fgDeliveryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'FGD0009990000000001000101';
const IN_TRANSIT = 'FGD0009990000000002000101';
const UNKNOWN = 'FGD0009990000000003000101';
// The sender's reference of the delivered parcel: Cainiao's code for it.
const CAINIAO = 'CNITZZ00000001FLM';

type Row = Record<string, unknown>;

const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(`${name}.json`)) as Row[];
const changed = (name: string, change: (rows: Row[]) => void) => {
  const rows = fixture(name);
  change(rows);
  return JSON.stringify(rows);
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('FG Delivery HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(raw('in-transit.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FgDeliveryTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${IN_TRANSIT.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FG_DELIVERY_API}?IdSpedizione=${IN_TRANSIT}`);
    expect(fgDeliveryLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fg-delivery', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and stages it by its code, or by FG Delivery’s wording', () => {
    const result = parseFgDelivery(raw('delivered.json'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Consegnato al destinatario', last_update: null, last_update_local: '2026-02-13T14:05:21', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null])).toEqual([
      // The delivery recorded twice, seconds apart, stays twice.
      ['2026-02-13T14:05:21', '262', 'delivered'],
      ['2026-02-13T14:04:58', '262', 'delivered'],
      ['2026-02-13T08:12:40', '259', 'out_for_delivery'],
      ['2026-02-12T17:48:55', '999', 'failed_attempt'],
      ['2026-02-12T07:31:17', '259', 'out_for_delivery'],
      // The branch scan listed twice is kept once.
      ['2026-02-11T21:40:12', '287', 'in_transit'],
      ['2026-02-09T09:19:04', '292', 'in_transit'],
    ]);
    expect(result.events![3]).toMatchObject({ description: 'Lasciato avviso', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    // The recipient's postcode, name and notes, the offset label and the sender's reference are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Esempio|00000"|GMT|CNITZZ|canonical/);
  });

  it('reads a parcel at the branch', () => {
    const result = parseFgDelivery(raw('in-transit.json'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Merce in filiale', last_update_local: '2026-03-04T10:02:17' });
    expect(result.events!.map((event) => event.description)).toEqual(['Merce in filiale', 'Dispaccio in partenza']);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-ORDER/);
  });

  it('orders the scans by Progressivo, whatever order the reply lists them in', () => {
    const result = parseFgDelivery(changed('delivered', (rows) => rows.reverse()), DELIVERED);
    expect(result.events!.map((event) => event.local_time)).toEqual(parseFgDelivery(raw('delivered.json'), DELIVERED).events!
      .map((event) => event.local_time));
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-02-13T14:05:21' });
  });

  it('finds a parcel by its Cainiao code and names FG Delivery’s own number', () => {
    expect(parseFgDelivery(raw('delivered.json'), CAINIAO.toLowerCase()))
      .toMatchObject({ current_stage: 'delivered', canonical_tracking_number: DELIVERED });
    // The tracker also matches a second barcode.
    const second = changed('in-transit', (rows) => rows.forEach((row) => { row.Barcode2 = CAINIAO; }));
    expect(parseFgDelivery(second, CAINIAO)).toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT });
    // An FGD number counts only as the shipment's own.
    const reference = changed('in-transit', (rows) => rows.forEach((row) => { row.RiferimentoCliente = UNKNOWN; }));
    expect(() => parseFgDelivery(reference, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FG Delivery answered for another shipment' }));
  });

  it('reads the empty list as not found and keeps another or a shared shipment inconclusive', () => {
    for (const body of [raw('not-found.json'), ' [] ', '﻿[]']) {
      expect(() => parseFgDelivery(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
    expect(() => parseFgDelivery(raw('in-transit.json'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FG Delivery answered for another shipment' }));
    expect(() => parseFgDelivery(raw('delivered.json'), `${CAINIAO.slice(0, -4)}2FLM`)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Two parcels under one reference name neither.
    const shared = JSON.stringify([...fixture('delivered'), ...fixture('in-transit').map((row) => ({ ...row, RiferimentoCliente: CAINIAO }))]);
    expect(() => parseFgDelivery(shared, CAINIAO))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FG Delivery found several shipments for the number' }));
    // Rows of another shipment beside the parcel's own are left out.
    const mixed = JSON.stringify([...fixture('delivered'), ...fixture('in-transit')]);
    expect(parseFgDelivery(mixed, DELIVERED).events).toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (rows: Row[]) => { rows[1] = 'scan' as never; },
      (rows: Row[]) => { delete rows[1]!.IdSpedizione; },
      (rows: Row[]) => { rows[1]!.IdSpedizione = 999; },
      (rows: Row[]) => { rows[1]!.Progressivo = 2; },
      (rows: Row[]) => { rows[1]!.Progressivo = '0'; },
      (rows: Row[]) => { delete rows[1]!.Progressivo; },
      (rows: Row[]) => { rows[1]!.EventCode = 262; },
      (rows: Row[]) => { rows[1]!.EventCode = 'X1'; },
      (rows: Row[]) => { rows[1]!.Causale = ''; },
      (rows: Row[]) => { rows[1]!.Causale = ['Consegnato']; },
      (rows: Row[]) => { rows[1]!.RiferimentoCliente = { id: 1 }; },
      (rows: Row[]) => { rows[1]!.Barcode2 = 7; },
      (rows: Row[]) => { rows[1]!.DataConsegna = '2026-02-13'; },
      (rows: Row[]) => { rows[1]!.DataConsegna = '13/2/2026'; },
      (rows: Row[]) => { rows[1]!.DataConsegna = '2/30/2026'; },
      (rows: Row[]) => { rows[1]!.DataConsegna = '1/1/1900'; },
      (rows: Row[]) => { delete rows[1]!.DataConsegna; },
      (rows: Row[]) => { rows[1]!.OraConsegna = '24:00:00'; },
      (rows: Row[]) => { rows[1]!.OraConsegna = '14:04'; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[1]!)); },
    ]) {
      expect(() => parseFgDelivery(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['', '{"IdSpedizione":null}', 'null', '[']) {
      expect(() => parseFgDelivery(body, DELIVERED), body).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a block page and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup('[]')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://fgdelivery.it/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(raw('blocked.html'), { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // The block page is a refusal whatever its status.
    await expect(lookup(raw('blocked.html'), { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>FG Delivery</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the empty list, and asks nothing for a number FG Delivery does not track', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(raw('delivered.json')))
      .mockResolvedValueOnce(reply(raw('delivered.json')))
      .mockResolvedValueOnce(reply('[]'))
      .mockResolvedValueOnce(reply(raw('in-transit.json')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-13T14:05:21' });
    await expect(carrier(fetcher).recognize!(CAINIAO)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-13T14:05:21' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // An answer for another shipment is no recognition.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('1')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers FG Delivery does not track and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1', 'FGD000999000000000100010', 'FGD00099900000000010001011', 'FGX0009990000000001000101',
      'CNITZZ0000001FLM', 'CNITZZ00000001XYZ', 'LP00000000000001', `FGD${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFgDeliveryNumber('fgd 0009990000 000001000101')).toBe(DELIVERED);
  });

  it('tries a read that never reaches the site once more inside the budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 200 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    const recovered = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(raw('in-transit.json')));
    await expect(carrier(recovered).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered).toHaveBeenCalledTimes(2);
  });

  it('detects FGD numbers and Cainiao’s FLM codes and routes them to the adapter', async () => {
    for (const number of [DELIVERED, CAINIAO]) expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'fg-delivery', confidence: 'high' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(raw('delivered.json')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'fg-delivery' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'fg-delivery', source: 'fg-delivery', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(FG_DELIVERY_API))).toBe(true);
  });
});

describe('FG Delivery status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries) expect(fgDeliveryStage(entry.code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
    // The map stages every code and FG Delivery's own wordings for a failed
    // round; the shared rules read the page's placeholder outcome.
    for (const entry of entries.filter(({ code, stage }) => code || stage === 'failed_attempt')) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'fg-delivery', providerCode: '259', description: 'In consegna' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'fg-delivery', providerCode: '999', description: 'Lasciato avviso' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'fg-delivery', providerCode: '998', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(fgDeliveryStage('998', 'Synthetic note')).toBeNull();
  });
});
