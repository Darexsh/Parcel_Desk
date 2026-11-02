import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SAILPOST_API, SailpostTracker } from './adapter.js';
import { normalizeSailpostNumber, parseSailpost } from './parser.js';
import { sailpostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const RETURNED = '9000000000000017';
const IN_TRANSIT = '9000000000000025';
const DELIVERED = '9000000000000033';
const UNKNOWN = '9000000000000041';

type Row = Record<string, unknown>;
type Reply = Row & { Events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// A scan of the in-transit fixture with other fields.
const scan = (fields: Row): Row => ({ ...fixture('in-transit').Events[0]!, ...fields });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Sailpost HTTP adapter', () => {
  it('posts the whole code in capitals to the tracking service once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SailpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 0000 0000 0025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SAILPOST_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ Action: 'TRACKING', Track: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sailpost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(normalizeSailpostNumber('ab-1234 5678')).toBe('AB12345678');
  });

  it('keeps each scan’s instant on Rome’s clock and stages it by its code', () => {
    const result = parseSailpost(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'In Consegna', last_update: '2026-10-14T08:15:00+02:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-10-14T08:15:00+02:00', '20', 'out_for_delivery', 'DS SAMPLE CITY 2'],
      // The repeated arrival is kept once.
      ['2026-10-13T18:40:10+02:00', '931', 'in_transit', 'DS SAMPLE CITY 2'],
      ['2026-10-12T21:05:33+02:00', '911', 'in_transit', 'SAMPLE HUB - CENTRO SERVIZI'],
      // Half past midnight in Rome is the evening before in UTC, on the day the page shows.
      ['2026-10-12T00:30:00+02:00', '15', 'in_transit', 'SAMPLE HUB - CENTRO SERVIZI'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.point === undefined)).toBe(true);
    // The office's phone, email and coordinates, the destination, the item's category and the contacts are not kept.
    expect(JSON.stringify(result)).not.toMatch(/000 0000000|example\.invalid|45\.0001|SAMPLE TOWN|\+39 000|Sample Vettore|100001/);
  });

  it('follows a held item back to its sender, keeping a scan dated by its day alone as that day', () => {
    const result = parseSailpost(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Resa al Mittente', last_update: '2026-09-11T10:05:12+02:00' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-09-11T10:05:12+02:00', '901', 'returned', 'SAMPLE HUB - CENTRO SERVIZI'],
      // The sender is a party, not a place.
      ['2026-09-09T15:30:01+02:00', '912', 'returned', null],
      ['2026-09-09T14:30:01+02:00', '932', 'in_transit', 'SAMPLE HUB - CENTRO SERVIZI'],
      ['2026-09-04T12:00:40+02:00', '910', 'in_transit', 'SAMPLE HUB - CENTRO SERVIZI'],
      ['2026-08-30', '600', 'exception', 'DS SAMPLE CITY 2'],
      // Served at the office while the item stays there: it moves nothing.
      ['2026-03-12T11:00:05+01:00', '204', null, 'DS SAMPLE CITY 2'],
      ['2026-03-02T12:21:00+01:00', '60', 'ready_for_pickup', 'DS SAMPLE CITY 2'],
      ['2026-03-02T12:19:00+01:00', '200', 'failed_attempt', 'DS SAMPLE CITY 2'],
      ['2026-03-01T15:34:46+01:00', '20', 'out_for_delivery', 'DS SAMPLE CITY 2'],
      ['2026-03-01T13:50:16+01:00', '931', 'in_transit', 'DS SAMPLE CITY 2'],
      ['2026-02-26T12:17:33+01:00', '911', 'in_transit', 'DS SAMPLE CITY 2'],
      ['2026-02-23T09:43:47+01:00', '15', 'in_transit', 'SAMPLE HUB - CENTRO SERVIZI'],
    ]);
    expect(result.events![4]).toEqual({ local_time: '2026-08-30', location: 'DS SAMPLE CITY 2', description: 'Compiuta Giacenza',
      provider_code: '600', stage: 'exception', stage_source: 'carrier_map' });
    // The newest scan dated by its day alone gives the day.
    const held = parseSailpost(changed('returned', (body) => { body.Events.splice(0, 4); }), RETURNED);
    expect(held).toMatchObject({ current_stage: 'exception', last_update: null, last_update_local: '2026-08-30' });
    // Without the end of the storage period the item waits at the office for collection.
    expect(parseSailpost(changed('returned', (body) => { body.Events.splice(0, 5); }), RETURNED))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Notificato (Ufficio)' });
  });

  it('stages a scan whose code it does not know by its family, then its wording', () => {
    const result = parseSailpost(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_update: '2026-05-20T11:42:10+02:00' });
    expect(sailpostStage('9001', 2, 'Synthetic note')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(sailpostStage('9001', 8, 'Synthetic note')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(sailpostStage('9001', 99, 'Synthetic note')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(sailpostStage('9001', 99, 'Mancata Consegna')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    // A delivered or held family also holds returns, notices and the end of storage.
    expect(sailpostStage('9001', 1, 'Synthetic note')).toBeNull();
    expect(sailpostStage('9001', 3, 'Synthetic note')).toBeNull();
    expect(sailpostStage('9001', 7, 'Synthetic note')).toBeNull();
    expect(sailpostStage('204', 2, 'Notificato (Ufficio)')).toBeNull();
    expect(sailpostStage('912', 1, 'Inviata a Mittente')).toEqual({ stage: 'returned', source: 'carrier_map' });
  });

  it('keeps the day the page shows when the instant falls on another day, or the reply has none', () => {
    const result = parseSailpost(changed('in-transit', (body) => {
      body.Events.splice(2, 1);
      body.Events[0]!.DataUTC = '/Date(1792015200000)/';
      delete body.Events[1]!.DataUTC;
      body.Events[3]!.DataUTC = '/Date(-62135596800000)/';
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.time ?? event.local_time)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12T21:05:33+02:00', '2026-10-12']);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-10-14' });
  });

  it('reads a history listed oldest first newest first', () => {
    const result = parseSailpost(changed('returned', (body) => { body.Events.reverse(); }), RETURNED);
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Resa al Mittente' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '15' });
  });

  it('names Poste Italiane and its number for an item handed to it', () => {
    const handed = (reference: string) => changed('in-transit', (body) => {
      body.Events.unshift(scan({ IdStato: 903, CodStato: 2, Stato: 'In Transito', Desc: 'Affidata a Poste Italiane', TrackVett: reference }));
    });
    expect(parseSailpost(handed('ra 000 000 000 17'), IN_TRANSIT))
      .toMatchObject({ delivery_carrier: 'poste-italiane', delivery_tracking_number: 'RA00000000017', current_stage: 'in_transit' });
    // A number Poste's detection does not take whole names no partner.
    for (const reference of ['', 'RA0000000001', 'SAMPLE']) {
      const result = parseSailpost(handed(reference), IN_TRANSIT);
      expect(result).not.toHaveProperty('delivery_carrier');
      expect(result).not.toHaveProperty('delivery_tracking_number');
    }
    // Another code's carrier reference is not a hand-off.
    expect(parseSailpost(changed('in-transit', (body) => { body.Events[0]!.TrackVett = 'RA00000000017'; }), IN_TRANSIT))
      .not.toHaveProperty('delivery_carrier');
  });

  it('reads an unknown code as not found, a failed lookup as inconclusive and an item without scans as no history', () => {
    expect(() => parseSailpost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSailpost(changed('not-found', (body) => { body.Errore = ' NESSUN RISULTATO '; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSailpost(changed('not-found', (body) => { body.Risultato = false; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSailpost(changed('not-found', (body) => { body.Errore = 'Errore interno'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // An error beside scans is not a missing item.
    expect(() => parseSailpost(changed('in-transit', (body) => { body.Errore = 'Nessun risultato'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSailpost(changed('in-transit', (body) => { body.Events = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSailpost(changed('in-transit', (body) => { delete (body as Row).Events; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts an item only when the reply and its scans name the code asked', () => {
    expect(() => parseSailpost(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Sailpost answered for another item' }));
    expect(() => parseSailpost(changed('in-transit', (body) => { body.Events[2]!.CodRaccom = DELIVERED; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Sailpost answered for another item' }));
    expect(() => parseSailpost(changed('not-found', (body) => { body.Track = DELIVERED; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseSailpost(changed('in-transit', (body) => {
      body.Track = ` ${IN_TRANSIT} `;
      for (const row of body.Events) delete row.CodRaccom;
    }), IN_TRANSIT).events).toHaveLength(4);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { (body as Row).Risultato = 'true'; },
      (body: Reply) => { delete (body as Row).Track; },
      (body: Reply) => { body.Errore = 0; },
      (body: Reply) => { body.Events = 'events' as never; },
      (body: Reply) => { body.Events = Array.from({ length: 501 }, () => body.Events[0]!); },
      (body: Reply) => { body.Events[0] = 'scan' as never; },
      (body: Reply) => { body.Events[0]!.Data = '2026-10-14'; },
      (body: Reply) => { body.Events[0]!.Data = '/Date(1791928800000)/'; },
      (body: Reply) => { body.Events[0]!.DataUTC = '/Date(1791958500000+0200)/'; },
      (body: Reply) => { body.Events[0]!.DataUTC = 1791958500000; },
      (body: Reply) => { delete body.Events[0]!.Data; },
      (body: Reply) => { body.Events[0]!.IdStato = '20'; },
      (body: Reply) => { body.Events[0]!.CodStato = 4.5; },
      (body: Reply) => { delete body.Events[0]!.IdStato; },
      (body: Reply) => { body.Events[0]!.Desc = ['In Consegna']; },
      (body: Reply) => { body.Events[0]!.Desc = ''; body.Events[0]!.Stato = null; },
      (body: Reply) => { body.Events[0]!.Pos = 7; },
    ]) {
      expect(() => parseSailpost(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSailpost('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown code, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service reads a missing item from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.sailpost.it/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // The service answers a request it cannot read with an empty 200.
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('TRACKING: servizio attivo')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects codes Sailpost does not issue and pre-aborted lookups without a request, and offers no recognition', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['9000000', 'SAMPLETRACKING', `9${'0'.repeat(30)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
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

  it('routes a code filed under Sailpost, or read from its tracking page’s address, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('returned')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: RETURNED, carrier: 'sailpost' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'sailpost', source: 'sailpost', result: { current_stage: 'returned' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SAILPOST_API)).toBe(true);
    expect(parseTrackingInput(`https://www.sailpost.it/traccia-il-pacco/?codice=${UNKNOWN}`))
      .toMatchObject({ trackingNumber: UNKNOWN, carrier: 'sailpost', source: 'link' });
  });
});

describe('Sailpost status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(sailpostStage(entry.code, 1, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'sailpost', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(sailpostStage(entry.code, 0, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'sailpost', providerCode: '60', description: 'In Giacenza' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'sailpost', providerCode: '9001', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
