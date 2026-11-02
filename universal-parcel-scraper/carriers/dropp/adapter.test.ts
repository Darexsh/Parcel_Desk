import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DROPP_API, DroppTracker } from './adapter.js';
import { normalizeDroppNumber, parseDropp } from './parser.js';
import { DROPP_STEPS, droppStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'DR000000010AA';
const IN_TRANSIT = 'DR000000000BB';
const HOME = 'DR000000000CC';
const UNKNOWN = 'DR0000000000000';

type Reply = Record<string, unknown>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracker page's answer to a number it does not know: a generic error, in ISO-8859-1.
const TRACKER_ERROR = '<!DOCTYPE html><html lang="en"><head><title>Dropp</title></head><body><div class="top"><h1 class="topTitle">Pöntunin þín</h1></div>'
  + '<div class="messageBox" id="messageBox">Því miður er ekki allt í góðu.....vinsamlegast reynið síðar</div></body></html>';

describe('Dropp HTTP adapter', () => {
  it('asks the search’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DroppTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' dr 000-000-000 bb ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DROPP_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dropp', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each step’s wall clock, newest first, and leaves out the estimate and the sender', () => {
    const result = parseDropp(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel delivered', last_update: null, last_update_local: '2026-05-07T17:05:00', expected_delivery: null,
      events: [
        { local_time: '2026-05-07T17:05:00', description: 'Parcel delivered', provider_code: 'delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-05-06T13:20:00', description: 'Parcel ready for pickup', provider_code: 'consignment', stage: 'ready_for_pickup',
          stage_source: 'carrier_map' },
        // Two steps in the same minute keep the page's order, the later one first.
        { local_time: '2026-05-06T07:40:00', description: 'Parcel out for delivery', provider_code: 'transit', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-05-06T07:40:00', description: 'Parcel arrived at Dropp terminal', provider_code: 'warehouse', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { local_time: '2026-05-04T11:30:00', description: 'Parcel on the way to Iceland', provider_code: 'airborne', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { local_time: '2026-05-02T08:15:00', description: 'Parcel expected', provider_code: 'added', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Sample Shop|12:00/);
  });

  it('reads a parcel on its way to Iceland, and the step to the door of a home delivery as out for delivery', () => {
    expect(parseDropp(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Parcel on the way to Iceland', last_update_local: '2026-05-12T14:45:00', expected_delivery: null });
    const home = parseDropp(fixture('home'), HOME);
    expect(home).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Parcel out for delivery',
      last_update_local: '2026-05-19T11:15:00' });
    expect(home.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['transit', 'out_for_delivery'], ['warehouse', 'in_transit'], ['added', 'registered'],
    ]);
  });

  it('takes the furthest step reached as the state, even when an earlier step carries a later clock', () => {
    const result = parseDropp(changed('delivered', (body) => { body.airborne = '08.05.2026 09:00'; }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Parcel delivered', last_update_local: '2026-05-08T09:00:00' });
    expect(result.events![0]).toMatchObject({ provider_code: 'airborne' });
  });

  it('reads the unknown-number answer as not found, a record without steps as no history and another parcel as inconclusive', () => {
    expect(() => parseDropp(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDropp(changed('not-found', (body) => { body.barcode = ''; }), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDropp(changed('in-transit', (body) => { body.added = ''; body.airborne = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseDropp(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Dropp answered for another shipment' }));
    expect(parseDropp(changed('in-transit', (body) => { body.barcode = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(2);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.barcode; },
      (body: Reply) => { body.barcode = 7; },
      (body: Reply) => { body.barcode = null; },
      (body: Reply) => { body.added = '2026-05-11 09:05'; },
      (body: Reply) => { body.added = '11.05.2026 09:05:00'; },
      (body: Reply) => { body.added = '30.02.2026 09:05'; },
      (body: Reply) => { body.added = '11.05.2026 24:00'; },
      (body: Reply) => { body.airborne = 1_778_600_000_000; },
      (body: Reply) => { body.home = 'false'; },
    ]) {
      expect(() => parseDropp(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDropp([fixture('in-transit')], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The search reads an unknown number from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('<html><body><h1>HTTP Status 404 – Not Found</h1></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://dropp.is/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The tracker page's generic error is no answer about the parcel.
    await expect(lookup(TRACKER_ERROR, { headers: { 'Content-Type': 'text/html;charset=ISO-8859-1' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Dropp does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-07T17:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A reply about another parcel is no answer either way.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('DR-0')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Dropp does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DR0', 'SAMPLETRACKING', `DR${'0'.repeat(39)}`, `DR${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDroppNumber('dr 000-000-010 aa')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('home')));
    await expect(carrier(fetcher).track({ number: HOME }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
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

  it('routes a number filed under Dropp to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dropp' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dropp', source: 'dropp', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${DROPP_API}${DELIVERED}`]);
  });
});

describe('Dropp numbers', () => {
  it('leaves its barcodes to the caller, since merchants may print their own order ids', () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('dropp');
  });
});

describe('Dropp status vocabulary', () => {
  it('records every step the map knows with the stage it gives, and stages the step to the door by the delivery', () => {
    const coded = (statuses.entries as { code?: string; wording: string; stage?: string }[]).filter((entry) => entry.code);
    expect(coded.map((entry) => [entry.code, entry.wording])).toEqual(DROPP_STEPS.map(({ step, wording }) => [step, wording]));
    for (const entry of coded) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      if (entry.stage) expect(droppStage(entry.code as never, false), entry.code).toBe(entry.stage);
    }
    expect(droppStage('transit', false)).toBe('in_transit');
    expect(droppStage('transit', true)).toBe('out_for_delivery');
    expect(statusMapAnswer({ carrier: 'dropp', providerCode: 'delivered', description: 'Parcel delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    // The step to the door or the pickup point depends on the reply's home flag.
    expect(statusMapAnswer({ carrier: 'dropp', providerCode: 'transit', description: 'Parcel out for delivery' })).toEqual({ kind: 'unknown' });
  });
});
