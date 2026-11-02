import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PullmanCargoTracker, pullmanCargoDataUrl } from './adapter.js';
import { normalizePullmanCargoNumber, parsePullmanCargo } from './parser.js';
import { pullmanCargoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '00000000001';
const IN_TRANSIT = '00000000002';
const UNKNOWN = '00000000000';

type Row = Record<string, unknown>;
type Reply = { type: string; nodes: [unknown, { type: string; data: unknown[] }] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The flat devalue list of the page's data: the root, then what it names by index. */
const changed = (name: string, change: (values: unknown[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.nodes[1].data, reply);
  return reply;
};
const rowRefs = (values: unknown[]) => values[(values[0] as Record<string, number>).seguimiento!] as number[];
const row = (values: unknown[], index: number) => values[rowRefs(values)[index]!] as Record<string, unknown>;
/** Points a scan's field at a new value. */
const setField = (values: unknown[], index: number, key: string, value: unknown) => {
  row(values, index)[key] = values.push(value) - 1;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pullman Cargo HTTP adapter', () => {
  it('asks for the tracking page’s data of the whole ODT once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PullmanCargoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 0000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://pullmancargo.cl/seguimiento/${IN_TRANSIT}/__data.json?x-sveltekit-invalidated=01`);
    expect(String(url)).toBe(pullmanCargoDataUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pullman-cargo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery with its scans as instants, newest first', () => {
    const result = parsePullmanCargo(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Encomienda entregada', last_update: '2026-01-14T18:40:07Z', expected_delivery: null,
      delivered_at: '2026-01-14T18:40:07Z',
      events: [
        { time: '2026-01-14T18:40:07Z', location: 'DESTINO CENTRO DISTRIBUCION', description: 'Encomienda entregada', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-01-14T12:02:17Z', location: 'DESTINO CENTRO DISTRIBUCION', description: 'En reparto', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-01-13T17:51:06Z', location: 'DESTINO CENTRO DISTRIBUCION', description: 'Encomienda viajando entre agencias', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-01-13T17:42:52Z', location: 'DESTINO CENTRO DISTRIBUCION', description: 'Encomienda recibida en agencia de destino', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-01-10T00:02:16Z', location: 'ORIGEN CENTRO DISTRIBUCION', description: 'Encomienda viajando entre regiones', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-01-08T14:13:03Z', location: 'ORIGEN CENTRO DISTRIBUCION', description: 'Venta Creada', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The towns the shipment goes between, its delivery method and its piece count are not kept.
    expect(JSON.stringify(result)).not.toMatch(/CIUDAD|DOM|ODT|piezas/);
  });

  it('reads a parcel on its way, keeping the order of two scans in one second', () => {
    const result = parsePullmanCargo(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'En espera de reparto', last_update: '2026-06-19T14:32:57Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.location])).toEqual([
      ['2026-06-19T14:32:57Z', 'En espera de reparto', 'in_transit', 'PUEBLO DESTINO - A1'],
      ['2026-06-18T15:19:38Z', 'Encomienda viajando entre agencias', 'in_transit', 'PUEBLO DESTINO - A1'],
      ['2026-06-18T15:19:38Z', 'Encomienda recibida en agencia de destino', 'in_transit', 'PUEBLO DESTINO - A1'],
      ['2026-06-15T19:49:35Z', 'Encomienda viajando entre regiones', 'in_transit', 'CENTRO DISTRIBUCION MUESTRA'],
      ['2026-06-15T15:49:36Z', 'Encomienda recibida en agencia', 'in_transit', 'CENTRO DISTRIBUCION MUESTRA'],
      ['2026-06-10T19:11:58Z', 'Venta Creada', 'accepted', 'PUEBLO ORIGEN CENTRO DISTRIBUCION'],
    ]);
  });

  it('turns an oldest-first list round, keeps the reply’s order on one clock and a repeated scan once', () => {
    const reversed = parsePullmanCargo(changed('in-transit', (values) => { rowRefs(values).reverse(); }), IN_TRANSIT);
    expect(reversed.events!.map((event) => event.description)).toEqual(parsePullmanCargo(fixture('in-transit'), IN_TRANSIT).events!
      .map((event) => event.description));
    const tied = parsePullmanCargo(changed('in-transit', (values) => { row(values, 2).fecha = row(values, 1).fecha; }), IN_TRANSIT);
    expect(tied.events!.slice(1, 3).map((event) => event.description))
      .toEqual(['Encomienda viajando entre agencias', 'Encomienda recibida en agencia de destino']);
    const repeated = parsePullmanCargo(changed('in-transit', (values) => { rowRefs(values).splice(1, 0, rowRefs(values)[0]!); }), IN_TRANSIT);
    expect(repeated.events).toHaveLength(6);
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const tied = parsePullmanCargo(changed('in-transit', (values) => { row(values, 2).fecha = row(values, 1).fecha; rowRefs(values).reverse(); }), IN_TRANSIT);
    expect(tied.events!.slice(1, 3).map((event) => event.description))
      .toEqual(['Encomienda viajando entre agencias', 'Encomienda recibida en agencia de destino']);
  });

  it('stages a scan the map does not know by the shared rules, and the newest staged scan stands', () => {
    const result = parsePullmanCargo(changed('in-transit', (values) => { setField(values, 0, 'estadoWeb', 'Xyzzy'); }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Xyzzy' });
    expect(result.events![0]).not.toHaveProperty('stage');
    const worded = parsePullmanCargo(changed('in-transit', (values) => { setField(values, 0, 'estadoWeb', 'Encomienda devuelta al remitente'); }), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    const placeless = parsePullmanCargo(changed('in-transit', (values) => { setField(values, 0, 'agencia', null); }), IN_TRANSIT);
    expect(placeless.events![0]).not.toHaveProperty('location');
  });

  it('reads an empty list as not found, and a failed load as inconclusive', () => {
    expect(() => parsePullmanCargo(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePullmanCargo(changed('not-found', (values) => { values[1] = null; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePullmanCargo(changed('not-found', (_values, body) => {
      body.nodes[1] = { type: 'error', error: { message: 'Internal Error' }, status: 500 } as never;
    }), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePullmanCargo({ type: 'redirect', location: '/' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });

  it('counts a reply only when it and every scan name the ODT asked', () => {
    expect(() => parsePullmanCargo(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pullman Cargo answered for another ODT' }));
    expect(() => parsePullmanCargo(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pullman Cargo answered for another ODT' }));
    expect(() => parsePullmanCargo(changed('in-transit', (values) => { setField(values, 3, 'numeroODT', DELIVERED); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pullman Cargo answered for another shipment' }));
    // A number without its leading zeroes is another ODT to the tracker.
    expect(() => parsePullmanCargo(changed('in-transit', (values) => { setField(values, 3, 'numeroODT', '2'); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_values: unknown[], body: Reply) => { body.type = 'other'; },
      (_values: unknown[], body: Reply) => { body.nodes = [body.nodes[1]] as never; },
      (_values: unknown[], body: Reply) => { body.nodes[1] = null as never; },
      (values: unknown[]) => { values.length = 0; },
      (values: unknown[]) => { values[0] = 'root'; },
      (values: unknown[]) => { (values[0] as Row).odt = 999; },
      (values: unknown[]) => { (values[0] as Row).seguimiento = 0.5; },
      (values: unknown[]) => { values[(values[0] as Record<string, number>).odt!] = 2; },
      (values: unknown[]) => { values[1] = 'scans'; },
      (values: unknown[]) => { values[1] = Array.from({ length: 301 }, () => rowRefs(values)[0]); },
      (values: unknown[]) => { rowRefs(values)[0] = 3; },
      (values: unknown[]) => { setField(values, 0, 'numeroODT', 2); },
      (values: unknown[]) => { row(values, 0).numeroODT = -1; },
      (values: unknown[]) => { setField(values, 0, 'estadoWeb', ''); },
      (values: unknown[]) => { setField(values, 0, 'estadoWeb', ['En reparto']); },
      (values: unknown[]) => { setField(values, 0, 'fecha', '2026-06-19T14:32:57.78Z'); },
      (values: unknown[]) => { setField(values, 0, 'fecha', '2026-06-19T14:32:57-04:00[America/Santiago]'); },
      (values: unknown[]) => { setField(values, 0, 'fecha', '2026-06-19 14:32:57Z[UTC]'); },
      (values: unknown[]) => { setField(values, 0, 'fecha', '2026-06-19T24:00:00Z[UTC]'); },
      (values: unknown[]) => { setField(values, 0, 'fecha', '2026-02-30T14:32:57Z[UTC]'); },
      (values: unknown[]) => { setField(values, 0, 'fecha', 1781879577780); },
      (values: unknown[]) => { setField(values, 0, 'agencia', 7); },
    ]) {
      expect(() => parsePullmanCargo(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing ODT from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('<!doctype html><title>Not Found</title>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://pullmancargo.cl/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html><body>Seguimiento</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known ODT with its last scan and the unknown-number answer, and asks nothing for a number Pullman Cargo does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-14T18:40:07.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Pullman Cargo does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000001', '000000000001', '0000000000A', 'A0000000001', `${'0'.repeat(70)}1`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePullmanCargoNumber('000-0000 0001')).toBe(DELIVERED);
  });

  it('sends a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 1_000 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([500, 1_000]);
  });

  it('routes an ODT filed under Pullman Cargo to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pullman-cargo' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pullman-cargo', source: 'pullman-cargo', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === pullmanCargoDataUrl(DELIVERED))).toBe(true);
  });
});

describe('Pullman Cargo numbers', () => {
  it('leaves eleven digits to other carriers’ rules', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('pullman-cargo');
  });
});

describe('Pullman Cargo status vocabulary', () => {
  it('stages every wording the tracker shows as recorded', () => {
    // The entries with a code are the former tracker's states, which the current one no longer shows.
    const current = (statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[]).filter((entry) => !entry.code);
    expect(current).toHaveLength(8);
    for (const entry of current) {
      expect(entry.confirmedBy, entry.wording).toBe('live');
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(pullmanCargoStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'pullman-cargo', providerCode: null, description: 'En reparto' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'pullman-cargo', providerCode: null, description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
    expect(pullmanCargoStage('Xyzzy')).toBeNull();
  });
});
