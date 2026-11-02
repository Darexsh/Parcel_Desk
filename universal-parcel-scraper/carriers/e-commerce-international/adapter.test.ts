import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, eciDataUrl, EciTracker } from './adapter.js';
import { normalizeEciNumber, parseEci } from './parser.js';
import { eciMappedStage, eciWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'PL15000000017UA';
const COURIER = '20400000000017';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

type Reply = { type: string; nodes: unknown[] };
const delivered = () => JSON.parse(text('delivered.json')) as Reply;
/** The delivered reply with its page's flat values changed. */
const edited = (change: (values: unknown[]) => unknown) => {
  const reply = delivered();
  const node = reply.nodes[2] as { data: unknown[] };
  const changed = change(node.data);
  if (changed !== undefined) node.data = changed as unknown[];
  return reply;
};
type Row = { number: number; timestamp: number };
const root = (values: unknown[]) => values[0] as Record<string, number>;
const rows = (values: unknown[]) => (values[root(values).history!] as number[]).map((index) => values[index] as Row);
/** The parcel before it reached a courier: its oldest statuses only. */
const inWarsaw = () => edited((values) => {
  values[root(values).history!] = (values[root(values).history!] as number[]).slice(-4);
  root(values).localtrack = -1;
});

describe('E-Commerce International HTTP adapter', () => {
  it('loads the tracking page’s data at the number’s address', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EciTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' pl15 0000 0001 7ua ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://ecommerce-system.com/track/${PARCEL}/__data.json`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'e-commerce-international', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the statuses as instants with the page’s English text, newest first, and hands the parcel to its courier', () => {
    const result = parseEci(delivered(), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-10T10:00:00Z', delivered_at: '2026-03-10T10:00:00Z', expected_delivery: null,
      delivery_carrier: 'nova-poshta', delivery_tracking_number: COURIER });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-03-10T10:00:00Z', '000000008', 'Delivered', 'delivered'],
      ['2026-03-08T13:00:00Z', '000000006', 'Delivered to the collection point', 'ready_for_pickup'],
      ['2026-03-08T07:00:00Z', '000000021', 'Handed over to the courier for delivery to the point or courier', 'out_for_delivery'],
      ['2026-03-06T12:00:00Z', '000000005', 'The parcel is handed over to the courier company', 'in_transit'],
      ['2026-03-06T08:00:00Z', '000000004', 'Shipment scanned at a warehouse in Kiev', 'in_transit'],
      ['2026-03-04T07:25:31.224Z', '100000010', 'Shipment on its way abroad', 'in_transit'],
      ['2026-03-03T16:40:12.155Z', '000000002', 'Created batch for international shipment', 'in_transit'],
      ['2026-03-03T11:02:47.958Z', '100000001', 'Accepted for storage', 'accepted'],
      ['2026-03-02T09:14:05.311Z', '000000001', 'Registered shipment', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads a parcel no courier has yet, and statuses without a stage or a text', () => {
    const early = parseEci(inWarsaw(), PARCEL);
    expect(early).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment on its way abroad' });
    expect(early).not.toHaveProperty('delivery_carrier');
    expect(early).not.toHaveProperty('delivered_at');
    // Cash on delivery names no step: the newest status with a stage decides.
    const paid = parseEci(edited((values) => { values[rows(values)[0]!.number] = '000000009'; }), PARCEL);
    expect(paid).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Received COD from courier company' });
    expect(paid.events![0]).not.toHaveProperty('stage');
    // A code the page has no text for keeps its code.
    const odd = parseEci(edited((values) => { values[rows(values)[0]!.number] = '999999999'; }), PARCEL);
    expect(odd.events![0]).toMatchObject({ description: 'Status 999999999', provider_code: '999999999' });
    expect(odd.events![0]).not.toHaveProperty('stage');
    // Of two statuses on one instant, the one listed first is the newer.
    const tied = parseEci(edited((values) => { values[rows(values)[1]!.timestamp] = values[rows(values)[0]!.timestamp]; }), PARCEL);
    expect(tied.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['000000008', '000000006']);
  });

  it('hands off only to a courier the page links to, with the courier’s own number', () => {
    const service = (name: unknown, localtrack: unknown = COURIER) => parseEci(edited((values) => {
      values[root(values).service!] = name;
      values[root(values).localtrack!] = localtrack;
    }), PARCEL);
    expect(service('ukrp', '0500000000017')).toMatchObject({ delivery_carrier: 'ukrposhta', delivery_tracking_number: '0500000000017' });
    expect(service('evri', 'H00AAA0000000017')).toMatchObject({ delivery_carrier: 'evri-uk' });
    expect(service('dhlexpress', '1000000017')).toMatchObject({ delivery_carrier: 'dhl-express' });
    for (const [name, localtrack] of [['sample', COURIER], ['constructor', COURIER], [null, COURIER], ['nova', null], ['nova', ''], ['nova', 'AB'], ['nova', PARCEL]]) {
      expect(service(name, localtrack), `${name} ${localtrack}`).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads the reply for a number the tracker does not know as not found, and a failed load as no answer', async () => {
    const unknown = 'PL15999999999UA';
    expect(() => parseEci(JSON.parse(text('not-found.json')), unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => json(text('not-found.json')))).track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
    const failed = (node: unknown) => ({ ...(JSON.parse(text('not-found.json')) as Reply), nodes: [null, delivered().nodes[1], node] });
    for (const node of [
      { type: 'error', error: { message: 'Internal Error' }, status: 500 },
      { type: 'error', error: { message: 'Parcel not found' }, status: 500 },
      { type: 'error', error: { message: 'Sample' }, status: 404 },
    ]) {
      expect(() => parseEci(failed(node), unknown)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('keeps only the parcel under the whole number asked, and has no history for one without statuses', () => {
    expect(() => parseEci(delivered(), 'PL15000000025UA'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'E-Commerce International answered for another shipment' }));
    expect(() => parseEci(edited((values) => { values[root(values).history!] = []; }), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const [index, body] of [
      null,
      [],
      { type: 'data', nodes: [] },
      { ...delivered(), nodes: delivered().nodes.slice(1) },
      { ...delivered(), type: 'sample' },
      edited(() => []),
      edited(() => 'sample'),
      edited(() => Array.from({ length: 5_001 }, () => 0)),
      edited((values) => { values[0] = []; }),
      edited((values) => { delete root(values).parcelNumber; }),
      edited((values) => { values[root(values).parcelNumber!] = 7; }),
      edited((values) => { root(values).history = 9_999; }),
      edited((values) => { values[root(values).history!] = {}; }),
      edited((values) => { values[root(values).history!] = Array.from({ length: 301 }, () => (values[root(values).history!] as number[])[0]); }),
      edited((values) => { (values[root(values).history!] as unknown[])[0] = 1.5; }),
      edited((values) => { values[(values[root(values).history!] as number[])[0]!] = 'Delivered'; }),
      edited((values) => { values[rows(values)[0]!.number] = 8; }),
      edited((values) => { values[rows(values)[0]!.number] = '00000008'; }),
      edited((values) => { values[rows(values)[0]!.timestamp] = '2026-03-10'; }),
      edited((values) => { values[rows(values)[0]!.timestamp] = 1_773_136_800_000.5; }),
      edited((values) => { values[rows(values)[0]!.timestamp] = 0; }),
      edited((values) => { values[rows(values)[0]!.timestamp] = Date.UTC(2100, 0, 1); }),
      edited((values) => { values[root(values).service!] = 7; }),
    ].entries()) {
      expect(() => parseEci(body, PARCEL), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a firewall page, a refusal, a moved route and a redirect apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: PARCEL });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => json('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://ecommerce-system.com/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => json({ type: 'redirect', location: '/' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(replying(() => new Response('', { status }))).track({ number: PARCEL })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no E-Commerce International number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A courier's number, a postal item's and other countries' are not asked.
    for (const number of ['12345', COURIER, 'RR000000017PL', 'PL1500000017UA', 'PL150000000017UA', 'DE15000000017UA', 'PL15000000017PL', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEciNumber(' pl-15000-000017-ua ')).toBe(PARCEL);
    // The page's data address takes the number as one path segment.
    expect(eciDataUrl(PARCEL)).toBe(`https://ecommerce-system.com/track/${PARCEL}/__data.json`);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => json(text('delivered.json')))).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => json(text('not-found.json')))).recognize!('PL15999999999UA')).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('12345')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under E-Commerce International to the adapter', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: PARCEL, carrier: 'e-commerce-international' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'e-commerce-international', source: 'e-commerce-international', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === eciDataUrl(PARCEL))).toBe(true);
  });
});

describe('E-Commerce International status vocabulary', () => {
  it('records every code the map stages with its text and stage', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(eciWording(entry.code), entry.code).toBe(entry.wording);
      expect(statusMapAnswer({ carrier: 'e-commerce-international', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      // Stored without its code, the text gives the same stage.
      expect(eciMappedStage(null, entry.wording), entry.wording).toBe(entry.stage);
    }
    // Every code the map knows is recorded, or left without a stage on purpose.
    const recorded = new Set([...(statuses.entries as { code: string }[]).map((entry) => entry.code), ...statusMap.gaps.map((gap) => gap.code)]);
    expect(recorded.size).toBe(123);
    for (const code of recorded) expect(eciWording(code!), code).toBeDefined();
  });
});
