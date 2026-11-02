import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TWS_API, TwsTracker } from './adapter.js';
import { normalizeTwsNumber, parseTws } from './parser.js';
import { statusMap, twsStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '280000A000001';
const IN_TRANSIT = '280000B000002';
const UNKNOWN = '280000C000003';

type Row = Record<string, unknown>;
type Leg = Row & { ldv: string; stati_tracking: Row[] };
type Reply = Row & { response: Leg[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (legs: Leg[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.response, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TWS Express HTTP adapter', () => {
  it('posts the bare waybill in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TwsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 280000b 000-002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TWS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: IN_TRANSIT,
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'text/plain', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tws-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads both legs of a delivered waybill newest first, as wall clocks staged by their codes', () => {
    const result = parseTws(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'CONSEGNATA', last_update: null, last_update_local: '2026-03-11T14:48:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-03-11T14:48:00', '000', 'delivered'],
      // The repeated scan is kept once.
      ['2026-03-11T08:21:00', 'GGG', 'out_for_delivery'],
      ['2026-03-11T08:20:45', 'SVO', 'in_transit'],
      ['2026-03-10T17:55:00', '008', 'exception'],
      ['2026-03-10T09:30:00', 'GGG', 'out_for_delivery'],
      // A round that delivered nothing, without saying what happened.
      ['2026-03-07T11:15:00', '029', null],
      ['2026-03-07T10:03:00', '008', 'failed_attempt'],
      ['2026-03-06T19:22:14', '008', 'failed_attempt'],
      ['2026-03-06T08:47:00', 'GGG', 'out_for_delivery'],
      ['2026-03-05T02:31:00', 'HBS', 'in_transit'],
      // Of two scans on one clock, the later in the reply is the newer.
      ['2026-03-04T18:05:00', 'PPP', 'in_transit'],
      ['2026-03-04T18:05:00', 'THE', 'in_transit'],
      ['2026-03-03T15:40:02', 'PRT', 'accepted'],
      ['2026-03-02T09:12:31', 'NV', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(result.events![3]).toMatchObject({ description: 'GIACENZA: : DESTINATARIO ASSENTE', stage_source: 'carrier_map' });
    // The signer, the sender's references, the branch codes and the note are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Sample Signer|SAMPLE-|"XB"|XB|"note"|numColli/);
  });

  it('reads a waybill on its way with the newest leg’s estimate', () => {
    const result = parseTws(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'IN TRANSITO HUB',
      last_update_local: '2026-05-20T00:49:00', expected_delivery: '2026-05-21' });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['HBS', 'PPP', 'THE', 'CF', 'NV']);
    const later = parseTws(changed('delivered', (legs) => { legs[1]!.stati_tracking.splice(-2); legs[1]!.eta = '12-03-2026'; }), DELIVERED);
    expect(later).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: '2026-03-12' });
    // Only the newest leg's estimate counts, and an impossible day is none.
    expect(parseTws(changed('delivered', (legs) => { legs[1]!.stati_tracking.splice(-2); }), DELIVERED).expected_delivery).toBeNull();
    expect(parseTws(changed('in-transit', (legs) => { legs[0]!.eta = '31-02-2026'; }), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('reads a waybill created but not handed over as registered', () => {
    const result = parseTws(changed('in-transit', (legs) => { legs[0]!.stati_tracking.splice(2); }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'CONFERMATA' });
  });

  it('lists the parcels’ own scans only when the shipment has none, as the page does', () => {
    const parcel = (row: Row) => ({ ...row, codice_collo: 'SAMPLEPARCEL1' });
    const split = parseTws(changed('in-transit', (legs) => { legs[0]!.stati_tracking[4] = parcel(legs[0]!.stati_tracking[4]!); }), IN_TRANSIT);
    expect(split.events!.map((event) => event.provider_code)).toEqual(['PPP', 'THE', 'CF', 'NV']);
    const parcelsOnly = parseTws(changed('in-transit', (legs) => {
      legs[1]!.stati_tracking = legs[0]!.stati_tracking.map(parcel);
      legs[0]!.stati_tracking = [];
    }), IN_TRANSIT);
    expect(parcelsOnly.events).toHaveLength(5);
    expect(JSON.stringify(parcelsOnly)).not.toContain('SAMPLEPARCEL1');
  });

  it('reads an unknown waybill as not found, the tracker’s failures as inconclusive and a waybill without scans as no history', () => {
    expect(() => parseTws(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const state of [{ stato: 'WARN', errors: ['Errore generico'] }, { stato: 'KO', errors: null }, { stato: 'ERR', errors: null }]) {
      expect(() => parseTws({ ...state, response: null }, UNKNOWN), state.stato).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseTws(changed('in-transit', (legs) => { legs[0]!.stati_tracking = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts the legs only when they name the waybill asked, in any case', () => {
    expect(() => parseTws(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TWS answered for another waybill' }));
    expect(() => parseTws(changed('in-transit', (legs) => { legs[0]!.ldv = `${IN_TRANSIT}0`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'TWS answered for another waybill' }));
    expect(() => parseTws(changed('in-transit', (legs) => { legs[0]!.ldv = `${IN_TRANSIT}/A`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'TWS answered for another waybill' }));
    expect(parseTws(changed('in-transit', (legs) => { legs[0]!.ldv = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_legs: Leg[], body: Reply) => { delete (body as Row).stato; },
      (_legs: Leg[], body: Reply) => { body.stato = 'DONE'; },
      (_legs: Leg[], body: Reply) => { body.response = 'legs' as never; },
      (_legs: Leg[], body: Reply) => { body.response = []; },
      (legs: Leg[]) => { legs.splice(0, 1); },
      (legs: Leg[]) => { legs[0] = 'leg' as never; },
      (legs: Leg[]) => { delete (legs[0] as Row).ldv; },
      (legs: Leg[]) => { legs[0]!.stati_tracking = 'scans' as never; },
      (legs: Leg[]) => { legs[0]!.stati_tracking = Array.from({ length: 501 }, () => legs[0]!.stati_tracking[0]!); },
      (legs: Leg[]) => { legs[0]!.stati_tracking[0] = 'scan' as never; },
      (legs: Leg[]) => { legs[0]!.stati_tracking[0]!.data = '2026-05-18'; },
      (legs: Leg[]) => { legs[0]!.stati_tracking[0]!.data = '30-02-2026'; },
      (legs: Leg[]) => { legs[0]!.stati_tracking[0]!.ora = '24:00:00'; },
      (legs: Leg[]) => { legs[0]!.stati_tracking[0]!.ora = ''; },
      (legs: Leg[]) => { legs[0]!.stati_tracking[0]!.stato = ['NUOVA']; },
      (legs: Leg[]) => { legs[0]!.stati_tracking[0]!.stato = ''; },
      (legs: Leg[]) => { legs[0]!.eta = 21; },
    ]) {
      expect(() => parseTws(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTws('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown waybill, a moved route, a refusal, a bot check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers an unknown waybill itself: a 404 or a redirect is a moved route.
    await expect(lookup({ status: 404, error: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.mytws.it/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>403</title></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    // A bot check is never a missing parcel, even with HTTP 200.
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>TSM Shipper Manager</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ stato: 'KO', errors: null, response: null })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for a number TWS does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-11T14:48:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // Poste Delivery Business waybills stay with Poste Italiane's recognition.
    await expect(carrier(fetcher).recognize!('1UW0S00000001')).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('28-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tracks a Poste Delivery Business waybill filed under TWS through the same lookup', async () => {
    const number = '1UW0S00000001';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(changed('in-transit', (legs) => { legs[0]!.ldv = number; })));
    await expect(carrier(fetcher).track({ number })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: number });
  });

  it('rejects numbers TWS does not follow and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['290000A000001', '280000AA00001', '28000A000001', '1UW000', 'SAMPLETRACKING', `28${'0'.repeat(63)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTwsNumber('280000 a000-001')).toBe(DELIVERED);
    expect(normalizeTwsNumber('2800000000001')).toBe('2800000000001');
  });

  it('tries a read that hangs once more within the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: 10, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 200 });
    await vi.advanceTimersByTimeAsync(110);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry within the rest.
    expect(ended).toEqual([100, 110]);
  });

  it('routes a waybill filed under TWS to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tws-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tws-express', source: 'tws-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === TWS_API)).toBe(true);
  });
});

describe('TWS Express numbers', () => {
  it('suggests TWS at low confidence for its lettered waybills, which SDA also prints', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ confidence: 'low' });
    expect(detectCarrierMatch(DELIVERED).candidates).toEqual(expect.arrayContaining(['tws-express', 'poste-italiane']));
    expect(detectCarrierMatch('1UW0S00000001')).toMatchObject({ carrier: 'poste-italiane' });
  });
});

describe('TWS Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? '';
      if (entry.unmapped) {
        expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(twsStage(code, entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'tws-express', providerCode: code, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(twsStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'tws-express', providerCode: '008', description: 'DESTINATARIO ASSENTE' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'tws-express', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know takes its wording's stage, else the shared wording rules.
    expect(twsStage('ZZZ', 'CONSEGNATA')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(twsStage('ZZZ', 'Synthetic note')).toBeNull();
    // The scan after a fruitless round does not fall to the shared rules.
    expect(twsStage('029', 'CONSEGNE PARTICOLARI')).toBeNull();
    expect(twsStage('', 'In partenza')).toEqual({ stage: 'accepted', source: 'carrier_map' });
  });
});
