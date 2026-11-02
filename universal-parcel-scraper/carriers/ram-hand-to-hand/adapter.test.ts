import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, RAM_API, RamTracker } from './adapter.js';
import { normalizeRamNumber, parseRam, ramLine } from './parser.js';
import { ramMappedStage, ramStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'RAM00000001';
const IN_TRANSIT = 'K0000000';
const UNKNOWN = 'CAT000000';

type Row = Record<string, unknown>;
type Group = Row & { events: Row[] };
type Reply = Row & { groups: Group[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('RAM HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RamTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' k000-0000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${RAM_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ram-hand-to-hand', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock, moves the place to the location and shows a run of the same line once', () => {
    const result = parseRam(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'ARRIVED BY ROAD FROM Exampleville Hub, Sampleton', last_update: null,
      last_update_local: '2026-06-10T09:00:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-06-10T09:00:00', 'ARRIVED BY ROAD FROM Exampleville Hub, Sampleton', 'Testtown Depot, Testtown', 'in_transit'],
      ['2026-06-10T04:00:00', 'DEPARTED BY ROAD TO Testtown Depot, Testtown', 'Exampleville Hub, Sampleton', 'in_transit'],
      ['2026-06-10T02:00:00', 'OUT OF CONTAINER', 'Exampleville Hub, Sampleton', 'in_transit'],
      ['2026-06-09T18:00:00', 'ARRIVED BY ROAD FROM Client Site', 'Exampleville Hub, Sampleton', 'in_transit'],
      // The sender's premises name no place.
      ['2026-06-09T15:00:00', 'DEPARTED BY ROAD TO Exampleville Hub, Sampleton', null, 'in_transit'],
      // One loading line per parcel, shown once at the last parcel's time as the page does.
      ['2026-06-09T12:03:00', 'INTO CONTAINER', null, 'in_transit'],
      ['2026-06-09T10:00:00', 'CONSIGNED', null, 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('keeps the delivery without the receiver, the staff notes or the reference', () => {
    const result = parseRam(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'POD CAPTURED', last_update_local: '2026-03-05T19:30:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage ?? null])).toEqual([
      ['2026-03-05T19:30:00', 'POD CAPTURED', null],
      ['2026-03-05T17:30:00', 'POD RETURNED', null],
      ['2026-03-05T10:30:00', 'DELIVERED', 'delivered'],
      ['2026-03-05T10:30:00', 'RAMMobile Delivered', 'delivered'],
      ['2026-03-05T07:20:00', 'Outgoing SMS - Consignment has been dispatched for delivery attempt', null],
      ['2026-03-05T07:15:00', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-03-04T09:45:00', 'Incoming Call - Arrangements Made', null],
      ['2026-03-04T08:30:00', 'Outgoing Call - Follow up Account Query', null],
      ['2026-03-03T17:00:00', 'UNSUCCESSFULL DELIVERY - Incorrect Address', 'failed_attempt'],
      ['2026-03-03T14:00:00', 'RAMMobile NonDelivery - Incorrect Address', 'failed_attempt'],
      ['2026-03-03T07:05:00', 'Outgoing Email - Consignment has been dispatched for delivery attempt', null],
      ['2026-03-03T07:05:00', 'Outgoing SMS - Consignment has been dispatched for delivery attempt', null],
      ['2026-03-03T07:00:00', 'OUT FOR DELIVERY', 'out_for_delivery'],
      ['2026-03-02T16:50:00', 'OUT OF CONTAINER', 'in_transit'],
      ['2026-03-02T15:40:00', 'ARRIVED BY ROAD FROM Client Site', 'in_transit'],
      ['2026-03-02T13:30:00', 'DEPARTED BY ROAD TO Exampleville Hub, Sampleton', 'in_transit'],
      ['2026-03-02T11:20:00', 'INTO CONTAINER', 'in_transit'],
      ['2026-03-02T09:10:00', 'CONSIGNED', 'accepted'],
    ]);
    expect(result.events![8]).toMatchObject({ location: 'Exampleville Hub, Sampleton' });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:PERSON|NOTE|STREET|FLATS)|SAMPLEREF|RECEIVED|#|address on Waybill/i);
  });

  it('keeps one detail after the wording, in words only', () => {
    expect(ramLine('DELIVERED, RECEIVED BY SAMPLE PERSON.')).toEqual({ description: 'DELIVERED' });
    expect(ramLine('RAMMobile Delivered - Received by Sample Person')).toEqual({ description: 'RAMMobile Delivered' });
    expect(ramLine('Outgoing Call - Sample caller left 000 000 0000')).toEqual({ description: 'Outgoing Call' });
    expect(ramLine('Incoming Call - see address : UNIT #')).toEqual({ description: 'Incoming Call' });
    expect(ramLine('Outgoing Email - sample@example.com')).toEqual({ description: 'Outgoing Email' });
    expect(ramLine('OUT FOR DELIVERY IN SAMPLETON.')).toEqual({ description: 'OUT FOR DELIVERY', location: 'SAMPLETON' });
    expect(ramLine('INTO CONTAINER IN Client Site.')).toEqual({ description: 'INTO CONTAINER' });
    expect(ramLine('Synthetic note')).toEqual({ description: 'Synthetic note' });
  });

  it('reads the not-found line as not found, with or without its clock, and a reply without lines as no history', () => {
    expect(() => parseRam(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A short number's answer comes without a day or a time.
    expect(() => parseRam(changed('not-found', (body) => { Object.assign(body.groups[0]!, { date: '' }); body.groups[0]!.events[0]!.time = ''; }),
      UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRam(changed('delivered', (body) => { body.groups = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseRam(changed('delivered', (body) => { body.groups.forEach((group) => { group.events = []; }); }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A not-found line beside real scans is not the answer.
    expect(parseRam(changed('in-transit', (body) => { body.groups[1]!.events.push({ time: '', description: 'NO TRACKING FOUND' }); }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('counts a reply only when it echoes the number asked', () => {
    expect(() => parseRam(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'RAM answered for another waybill' }));
    expect(() => parseRam(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseRam(changed('in-transit', (body) => { body.waybillNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.waybillNo; },
      (body: Reply) => { body.groups = 'groups' as never; },
      (body: Reply) => { body.groups[0] = 'day' as never; },
      (body: Reply) => { delete (body.groups[0] as Row).events; },
      (body: Reply) => { body.groups[0]!.events[0] = 'scan' as never; },
      (body: Reply) => { body.groups[0]!.date = '2026-06-09'; },
      (body: Reply) => { body.groups[0]!.date = '31 June 2026'; },
      (body: Reply) => { body.groups[0]!.events[0]!.time = '10:00:00'; },
      (body: Reply) => { body.groups[0]!.events[0]!.time = '24:00'; },
      (body: Reply) => { delete body.groups[0]!.events[0]!.time; },
      (body: Reply) => { body.groups[0]!.events[0]!.description = ['CONSIGNED']; },
      (body: Reply) => { body.groups[0]!.events[0]!.description = ''; },
      (body: Reply) => { body.groups[0]!.events = Array.from({ length: 501 }, () => body.groups[0]!.events[0]!); },
    ]) {
      expect(() => parseRam(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup({ error: true, statusCode: 404 }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.ram.co.za/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Web Page Blocked</title><body>Attack ID: 00000000</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>window._cf_chl_opt = {}</script></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Track your Parcel</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number RAM does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(changed('not-found', (body) => {
        body.waybillNo = DELIVERED;
        body.groups[0]!.waybill = DELIVERED;
      })));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T19:30:00' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('RAM-0')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers RAM does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['K0000', 'SAMPLETRACKING', `RAM${'0'.repeat(28)}`, 'RAM/0000000']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRamNumber('ram 0000-0001')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
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

  it('routes a number filed under RAM, or one of its waybills, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ram-hand-to-hand' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ram-hand-to-hand', source: 'ram-hand-to-hand', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${RAM_API}${DELIVERED}`)).toBe(true);
  });
});

describe('RAM numbers', () => {
  it('suggests RAM for its waybills at low confidence only', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown', confidence: 'low',
      candidates: expect.arrayContaining(['ram-hand-to-hand']) });
    for (const number of [IN_TRANSIT, UNKNOWN, 'RAM0000000']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('ram-hand-to-hand');
    }
  });
});

describe('RAM status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(ramStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'ram-hand-to-hand', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(ramStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ram-hand-to-hand', providerCode: null, description: 'UNSUCCESSFULL DELIVERY - Sample Reason' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'ram-hand-to-hand', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Other wording falls to the shared rules; a message or call record moves nothing whatever it says.
    expect(ramStage('Synthetic note')).toBeNull();
    expect(ramStage('Outgoing SMS - Your parcel was delivered')).toBeNull();
    // A road leg needs its other end, and a failed delivery its own word.
    expect(ramMappedStage('DEPARTED BY ROAD TO ')).toBeUndefined();
    expect(ramMappedStage('UNSUCCESSFULL DELIVERYMAN')).toBeUndefined();
  });
});
