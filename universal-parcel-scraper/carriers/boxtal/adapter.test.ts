import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, boxtalTrackingUrl, BoxtalTracker } from './adapter.js';
import { normalizeBoxtalReference, parseBoxtal } from './parser.js';
import { boxtalMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const REFERENCE = '2603150000MONRAB12FR';
const UNKNOWN = '2603150000MONRZZ99FR';
const RELAY = '00000017';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

type Line = Record<string, unknown>;
type Parcel = Record<string, unknown> & { lines: Line[] };
type Reply = Record<string, unknown> & { packageTrackings: Parcel[] };
const delivered = () => JSON.parse(text('delivered.json')) as Reply;
const notFound = () => JSON.parse(text('not-found.json')) as Record<string, unknown>;
/** The delivered reply with its parcel changed. */
const edited = (change: (parcel: Parcel, reply: Reply) => void) => {
  const reply = delivered();
  change(reply.packageTrackings[0]!, reply);
  return reply;
};
const line = (change: (line: Line) => void) => edited((parcel) => change(parcel.lines[0]!));

describe('Boxtal HTTP adapter', () => {
  it('asks the tracking page’s lookup for the reference', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BoxtalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2603150000 monr ab12 fr ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://private-gateway.boxtal.com/v2.1/carrier/tracking/${REFERENCE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'boxtal', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the scans as wall clocks, newest first, and hands the parcel to its collecting carrier', () => {
    const result = parseBoxtal(delivered(), REFERENCE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Colis livré au destinataire', last_update: null, last_update_local: '2026-03-19T15:56:30', expected_delivery: null,
      delivery_carrier: 'mondial-relay', delivery_tracking_number: RELAY });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-03-19T15:56:30', 'F', 'Colis livré au destinataire', 'Relais Test', 'delivered'],
      ['2026-03-18T09:12:00', 'G', 'Colis disponible au Point Relais', 'Relais Test', 'ready_for_pickup'],
      // The carrier's detail follows its text, as the page joins them.
      ['2026-03-16T21:40:00', 'C', 'Colis en cours d\'acheminement - Agence de tri', undefined, 'in_transit'],
      ['2026-03-16T11:32:00', 'C', 'Prise en charge point relais', 'Relais Origine', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    // The shipper's account and order reference stay out of the result.
    expect(JSON.stringify(result)).not.toMatch(/TEST0000|ORDER-0001|mondialrelay\.com/);
  });

  it('reads scans without a known state from the carrier’s text, and Boxtal’s own text when the carrier gave none', () => {
    const other = parseBoxtal(line((row) => { row.boxtalState = 'Z'; }), REFERENCE);
    // "livré" alone gives the stage, by the shared wording rules.
    expect(other.events![0]).toMatchObject({ provider_code: 'Z', stage: 'delivered' });
    expect(other.events![0]!.stage_source).not.toBe('carrier_map');
    const bare = parseBoxtal(line((row) => { row.boxtalState = null; row.message = null; }), REFERENCE);
    expect(bare.events![0]).toMatchObject({ description: 'Livré' });
    expect(bare.events![0]).not.toHaveProperty('provider_code');
    // A scan the carrier text cannot stage leaves the stage to an older one.
    const quiet = parseBoxtal(line((row) => { row.boxtalState = 'Z'; row.message = 'Information transmise'; }), REFERENCE);
    expect(quiet).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Information transmise' });
    expect(quiet.events![0]).not.toHaveProperty('stage');
    // Of two scans on one clock, the one listed first is the newer; a repeated scan is kept once.
    const tied = parseBoxtal(edited((parcel) => {
      parcel.lines[1]!.trackingDate = parcel.lines[0]!.trackingDate;
      parcel.lines.push({ ...parcel.lines[3]! });
    }), REFERENCE);
    expect(tied.events!.map((event) => event.provider_code)).toEqual(['F', 'G', 'C', 'C']);
  });

  it('hands off only one parcel whose carrier link names its number', () => {
    const parcel = (change: (parcel: Parcel) => void) => parseBoxtal(edited(change), REFERENCE);
    expect(parcel((row) => {
      row.carrierReference = 'XX000000017FR';
      row.trackingUrl = 'https://www.chronopost.fr/expedier/inputLTNumbersNoJahia.do?listeNumeros=XX000000017FR';
    })).toMatchObject({ delivery_carrier: 'chronopost', delivery_tracking_number: 'XX000000017FR' });
    for (const [name, change] of [
      ['no number', (row: Parcel) => { row.carrierReference = null; }],
      ['short number', (row: Parcel) => { row.carrierReference = '1234'; }],
      ['number not in the link', (row: Parcel) => { row.carrierReference = '00000025'; }],
      ['the reference itself', (row: Parcel) => { row.carrierReference = REFERENCE; row.trackingUrl = `https://www.mondialrelay.com/?exp=${REFERENCE}`; }],
      ['no link', (row: Parcel) => { row.trackingUrl = null; }],
      ['not a link', (row: Parcel) => { row.trackingUrl = 'mondialrelay 00000017'; }],
      ['another scheme', (row: Parcel) => { row.trackingUrl = 'ftp://www.mondialrelay.com/00000017'; }],
      ['an unknown host', (row: Parcel) => { row.trackingUrl = 'https://tracking.example.com/?exp=00000017'; }],
    ] as const) {
      expect(parcel(change), name).not.toHaveProperty('delivery_carrier');
    }
    // A booking of two parcels names no single number.
    const two = parseBoxtal(edited((row, reply) => {
      reply.packageTrackings.push({ ...row, carrierReference: '00000025', lines: [{ ...row.lines[3]!, carrierReference: '00000025' }] });
    }), REFERENCE);
    expect(two).not.toHaveProperty('delivery_carrier');
    expect(two.events).toHaveLength(4);
  });

  it('reads the reply for a reference the tracker does not know as not found', async () => {
    expect(() => parseBoxtal(notFound(), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => json(text('not-found.json'), { status: 404 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    // The message names the reference asked; any other 404 is a moved route.
    await expect(carrier(replying(() => json(text('not-found.json'), { status: 404 }))).track({ number: REFERENCE }))
      .rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(carrier(replying(() => json({ ...notFound(), packageTrackings: [{}] }, { status: 404 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(carrier(replying(() => json('<html>Not Found</html>', { status: 404 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'transport', status: 404 });
    // The same failure without its 404 is a changed reply.
    expect(() => parseBoxtal({ ...notFound(), responseStatus: { successful: false, description: 'Sample' } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only parcels under the whole reference asked, and has no history for a booking without scans', () => {
    expect(() => parseBoxtal(delivered(), '2603150000MONRAB13FR'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Boxtal answered for another booking' }));
    expect(() => parseBoxtal(edited((_, reply) => { reply.packageTrackings = []; }), REFERENCE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBoxtal(edited((parcel) => { parcel.lines = []; }), REFERENCE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const [index, body] of [
      null,
      [],
      { ...delivered(), responseStatus: {} },
      edited((_, reply) => { reply.packageTrackings = {} as never; }),
      edited((_, reply) => { reply.packageTrackings = Array.from({ length: 51 }, () => reply.packageTrackings[0]!); }),
      edited((_, reply) => { reply.packageTrackings = ['sample'] as never; }),
      edited((parcel) => { parcel.boxtalReference = 7; }),
      edited((parcel) => { parcel.lines = 'sample' as never; }),
      edited((parcel) => { parcel.lines = Array.from({ length: 501 }, () => parcel.lines[0]!); }),
      edited((parcel, reply) => {
        parcel.lines = Array.from({ length: 300 }, () => parcel.lines[0]!);
        reply.packageTrackings.push({ ...parcel });
      }),
      line((row) => { row.trackingDate = null; }),
      line((row) => { row.trackingDate = '2026-03-19T15:56:30Z'; }),
      line((row) => { row.trackingDate = '2026-03-19 15:56:30'; }),
      line((row) => { row.trackingDate = '2026-02-30T15:56:30'; }),
      line((row) => { row.trackingDate = '2026-03-19T24:00:00'; }),
      line((row) => { row.trackingDate = 1_773_935_790_000; }),
      line((row) => { row.boxtalState = 'DELIVERED'; }),
      line((row) => { row.boxtalState = 7; }),
      line((row) => { row.message = null; row.description = null; row.boxtalMessage = null; }),
      line((row) => { row.message = ['Livré']; }),
      line((row) => { row.localization = 7; }),
    ].entries()) {
      expect(() => parseBoxtal(body, REFERENCE), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a firewall page, a refusal, a moved route and a redirect apart from an unknown reference', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: REFERENCE });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => json('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport', status: 410 });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://www.boxtal.com/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => new Response('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(replying(() => new Response('', { status }))).track({ number: REFERENCE })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no Boxtal reference, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The collecting carrier's number and other layouts are not asked.
    for (const number of ['12345', RELAY, 'XX000000017FR', '2603150000MONRAB12', '2603150000MONRAB12DE', '260315000MONRAB12FR',
      '2603150000MON1AB12FR', '2603150000MONRAB1-FR', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: REFERENCE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBoxtalReference(' 2603150000-monr-ab12-fr ')).toBe(REFERENCE);
    expect(boxtalTrackingUrl(REFERENCE)).toBe(`https://private-gateway.boxtal.com/v2.1/carrier/tracking/${REFERENCE}`);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: REFERENCE }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a reference the tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => json(text('delivered.json')))).recognize!(REFERENCE)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => json(text('not-found.json'), { status: 404 }))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('12345')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a reference filed under Boxtal to the adapter', async () => {
    const fetcher = replying(() => json(text('delivered.json')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: REFERENCE, carrier: 'boxtal' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'boxtal', source: 'boxtal', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === boxtalTrackingUrl(REFERENCE))).toBe(true);
  });
});

describe('Boxtal status vocabulary', () => {
  it('records every state letter the map stages with the page’s label and stage', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(boxtalMappedStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'boxtal', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    const recorded = new Set([...(statuses.entries as { code: string }[]).map((entry) => entry.code), ...statusMap.gaps.map((gap) => gap.code)]);
    expect([...recorded].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'R', 'Z']);
  });
});
