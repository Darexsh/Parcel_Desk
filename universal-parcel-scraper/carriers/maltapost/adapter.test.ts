import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MALTAPOST_ENDPOINT, MaltaPostTracker } from './adapter.js';
import { parseMaltaPost } from './parser.js';
import { maltaPostCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const SENDON = 'ZZ000000014MT';
const SENDON_FOREIGN = 'ZZ000000028GB';
const RETURNED = 'ZZ000000014CN';
const CHARGES = 'ZZ000000028JP';
const ABSENT = 'ZZ000000028MT';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { code?: unknown; description?: string; location?: string; date?: unknown; actionCode?: unknown; isForeignMovement?: boolean }
interface Reply { localBarcode?: unknown; foreignBarcode?: unknown; movements?: Row[]; isUntrackable?: boolean }
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = JSON.parse(text(name)) as Reply;
  change(payload);
  return payload;
};
const MALTA_CLOCK = { time_zone: 'Europe/Malta', time_zone_basis: 'carrier' };
const rows = (result: ReturnType<typeof parseMaltaPost>) =>
  result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);

describe('MaltaPost tracking adapter', () => {
  it('asks the tracking service for the whole number once, as JSON, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('sendon')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MaltaPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 mt ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.maltapost.com/TrackAndTraceApi/v1/trackedItems?barcode=${SENDON}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'maltapost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a SendOn item under either barcode, on Malta’s clock, with the recipient’s steps and holds keeping the stage', () => {
    const result = parseMaltaPost(JSON.parse(text('sendon')), SENDON);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item delivered/collected by recipient', last_update: '2026-03-13T11:42:07+01:00', last_update_local: '2026-03-13T11:42:07',
      expected_delivery: null });
    expect(result.events![0]).toMatchObject({ time: '2026-03-13T11:42:07+01:00', time_zone: 'Europe/Malta', time_zone_basis: 'carrier' });
    // Brought to the door: no pickup point.
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-03-13T11:42:07', 'EMI', 'delivered', null],
      ['2026-03-13T08:05:31', 'EDG', 'out_for_delivery', null],
      ['2026-03-12T18:22:50', 'EMG', 'in_transit', null],
      ['2026-03-12T17:48:16', 'EMF', 'in_transit', null],
      ['2026-03-12T16:37:00', 'Payment', 'in_transit', null],
      ['2026-03-12T15:52:00', 'PRD', 'in_transit', null],
      ['2026-03-12T15:20:44', 'EDA/C', 'in_transit', null],
      ['2026-03-12T15:20:00', 'EMD', 'in_transit', null],
      ['2026-03-10T21:04:39', 'EME', 'customs', null],
      ['2026-03-10T21:04:38', 'EDB', 'customs', null],
      ['2026-03-10T21:03:52', 'EDB', 'customs', null],
      ['2026-03-10T18:27:05', 'EMD', 'in_transit', null],
      ['2026-03-04T20:12:18', 'Declaration', 'accepted', null],
      ['2026-03-04T16:58:00', 'EMA', 'accepted', null],
    ]);
    expect(result.events!.every(event => event.time_zone === 'Europe/Malta' && event.time_zone_basis === 'carrier')).toBe(true);
    expect(result.events!.filter(event => event.stage_source === 'none').map(event => event.provider_code)).toEqual(['Payment', 'PRD', 'EDA/C', 'Declaration']);
    // The reason and the action follow the scan's wording, as on the tracking page.
    expect(result.events![6]!.description).toBe('Item held at inbound mail sorting centre. Awaiting payment of charges. Unsuccessful attempt-Recipient notified');
    expect(result.events![8]!.description).toBe('Item undergoing border agency clearance. Awaiting presentation to border security');
    // The masked recipient and the locality are never read.
    expect(JSON.stringify(result)).not.toMatch(/Example Town|A\*\*\*e|E\*\*\*\*\*e/);
    expect(parseMaltaPost(JSON.parse(text('sendon')), SENDON_FOREIGN)).toEqual(result);
    // A notice newest of all leaves the stage and the text to the movement before it.
    const declared = edited('sendon', payload => { payload.movements!.splice(0, 12); });
    expect(parseMaltaPost(declared, SENDON)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Item created', last_update_local: '2026-03-04T20:12:18' });
  });

  it('reads an item from abroad that waited at a post office and went back to its sender', () => {
    const result = parseMaltaPost(JSON.parse(text('returned')), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Forwarded to the next processing centre', last_update_local: '2026-04-08T09:41:36' });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-04-08T09:41:36', 'FWD', 'returned', null],
      ['2026-04-07T14:26:51', 'FWD', 'returned', null],
      ['2026-04-07T08:33:19', 'EMH/E', 'returned', null],
      ['2026-03-17T10:07:45', 'EDH', 'ready_for_pickup', 'Example Post Office'],
      ['2026-03-16T15:48:12', 'FWD', 'failed_attempt', null],
      ['2026-03-16T12:51:03', 'EMH/C', 'failed_attempt', null],
      ['2026-03-16T07:36:40', 'EDG', 'out_for_delivery', null],
      ['2026-03-13T17:22:14', 'EMG', 'in_transit', null],
      ['2026-03-13T17:22:13', 'EMF', 'in_transit', null],
      ['2026-03-13T14:10:28', 'EMD', 'in_transit', null],
      // The foreign post's posting names its country.
      ['2026-03-02T05:44:09', 'EMA', 'accepted', 'EXAMPLELAND'],
    ]);
    expect(result.events![2]!.description).toBe('Item could not be processed further. Item not collected. Item returned to sender');
    // A reason that only points at the action is left out.
    expect(result.events![5]!.description).toBe('Item could not be processed further. Unsuccessful attempt-Recipient notified');
    // A delivery after the return reaches the sender.
    const back = edited('returned', payload => {
      payload.movements!.unshift({ ...payload.movements![0]!, code: 'EMI', description: 'Item delivered/collected by recipient', date: '2026-04-20T10:00:00' });
    });
    expect(parseMaltaPost(back, RETURNED)).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Item delivered/collected by recipient' });
  });

  it('names the post office an item waits at, and the one it was collected from', () => {
    const waiting = edited('returned', payload => { payload.movements!.splice(0, 3); });
    expect(parseMaltaPost(waiting, RETURNED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Item arrived at collection point', pickup_point: 'Example Post Office' });
    const collected = edited('returned', payload => {
      payload.movements!.splice(0, 3, { code: 'EMI', description: 'Item delivered/collected by recipient', location: 'MaltaPost',
        date: '2026-03-20T11:00:00', isForeignMovement: false });
    });
    expect(parseMaltaPost(collected, RETURNED)).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: 'Example Post Office' });
    // A post office abroad is no MaltaPost pickup point.
    const abroad = edited('returned', payload => { payload.movements!.splice(0, 3); payload.movements![0]!.isForeignMovement = true; });
    expect(parseMaltaPost(abroad, RETURNED).pickup_point).toBeUndefined();
  });

  it('keeps an item held for its charges at the stage customs left it, and drops a foreign office number', () => {
    const result = parseMaltaPost(JSON.parse(text('charges')), CHARGES);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Item held at inbound mail sorting centre. Awaiting payment of charges. Unsuccessful attempt-Recipient notified' });
    expect(rows(result)).toEqual([
      ['2026-02-20T15:12:37', 'EDA/C', 'in_transit', null],
      ['2026-02-20T15:12:36', 'EDC', 'in_transit', null],
      ['2026-02-20T14:25:02', 'EME', 'customs', null],
      ['2026-02-20T14:24:02', 'EDB', 'customs', null],
      ['2026-02-20T14:17:55', 'EMD', 'in_transit', null],
      ['2026-02-11T09:00:00', 'EMC', 'in_transit', 'EXAMPLELAND (ZZ)'],
      ['2026-02-09T21:00:00', 'EMB', 'in_transit', null],
      ['2026-02-09T13:00:00', 'EMA', 'accepted', null],
    ]);
    // Out of order in the reply, newest first in the result; a repeated scan counts once.
    const shuffled = edited('charges', payload => { payload.movements!.reverse(); payload.movements!.push({ ...payload.movements![3]! }); });
    expect(rows(parseMaltaPost(shuffled, CHARGES))).toEqual(rows(result));
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const oldestFirst = edited('charges', payload => {
      payload.movements!.find(row => row.code === 'EME')!.date = '2026-02-20T14:24:02.61';
      payload.movements!.reverse();
    });
    expect(parseMaltaPost(oldestFirst, CHARGES).events!.slice(0, 4).map(event => event.provider_code)).toEqual(['EDA/C', 'EDC', 'EME', 'EDB']);
  });

  it('stages new codes through the shared wording rules and keeps the rest visible', () => {
    const relayed = edited('charges', payload => {
      payload.movements!.unshift({ code: 'EXZ', description: 'Item returned to sender', location: 'MaltaPost', date: '2026-02-23T08:00:00' });
    });
    expect(parseMaltaPost(relayed, CHARGES)).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:language' });
    const unknown = edited('charges', payload => {
      payload.movements!.unshift({ code: 'XYZ', description: 'Item weighed at counter', location: 'Example Post Office', date: '2026-02-23T08:00:00' },
        { code: 'FWD', description: 'Forwarded to the next processing centre', location: 'MaltaPost', date: '2026-02-23T09:00:00' });
    });
    const result = parseMaltaPost(unknown, CHARGES);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Forwarded to the next processing centre' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events!.slice(0, 2)).toEqual([
      { ...MALTA_CLOCK, local_time: '2026-02-23T09:00:00', time: '2026-02-23T09:00:00+01:00', description: 'Forwarded to the next processing centre', provider_code: 'FWD' },
      { ...MALTA_CLOCK, local_time: '2026-02-23T08:00:00', time: '2026-02-23T08:00:00+01:00', description: 'Item weighed at counter', provider_code: 'XYZ', location: 'Example Post Office' },
    ]);
    // A failed delivery with an action the map does not know is still a failed delivery.
    const action = edited('charges', payload => {
      payload.movements!.unshift({ code: 'EMH', description: 'Item could not be processed further', date: '2026-02-23T08:00:00', actionCode: 'Q' });
    });
    expect(parseMaltaPost(action, CHARGES)).toMatchObject({ current_stage: 'failed_attempt', events: expect.arrayContaining([expect.objectContaining({ provider_code: 'EMH/Q' })]) });
  });

  it('reads only the reply without a barcode as a missing item', () => {
    expect(() => parseMaltaPost(JSON.parse(text('not-found')), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMaltaPost(edited('sendon', payload => { payload.isUntrackable = true; }), SENDON))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'tracking_withheld' }));
    expect(() => parseMaltaPost(edited('sendon', payload => { payload.movements = []; }), SENDON))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
  });

  it('answers only for the requested number and rejects malformed replies', () => {
    expect(() => parseMaltaPost(JSON.parse(text('sendon')), 'ZZ000000014CN')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, [], {}, { movements: {} }, { movements: 'none' },
      edited('sendon', reply => { reply.localBarcode = 7; reply.foreignBarcode = null; }),
      edited('sendon', reply => { delete reply.localBarcode; delete reply.foreignBarcode; }),
      edited('sendon', reply => { reply.movements![2]!.date = '2026-03-12 18:22:50'; }),
      edited('sendon', reply => { reply.movements![2]!.date = '2026-02-30T18:22:50'; }),
      edited('sendon', reply => { reply.movements![2]!.date = undefined; }),
      edited('sendon', reply => { reply.movements![2]!.code = 'E M G'; }),
      edited('sendon', reply => { reply.movements![2]!.code = { code: 'EMG' }; }),
      edited('sendon', reply => { (reply.movements as unknown[])[2] = 'scan'; })]) {
      expect(() => parseMaltaPost(payload, SENDON), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('recognizes a known item and the reply without a barcode, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('sendon'))).mockResolvedValueOnce(reply(text('not-found')));
    // Malta's clock dates the last activity.
    await expect(carrier(fetcher).recognize!(SENDON)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-13T10:42:07.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes letters and digits the tracker accepts, but no MaltaPost S10 code with a wrong check digit, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found')));
    for (const number of ['ZZ000000015MT', 'ABCDEFGH', '12345', 'Z'.repeat(40) + '1', 'ZZ00000001/MT']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    // A foreign barcode of any shape is sent as it is.
    for (const number of ['ZZXYZ000000001MT', '999999999999999999', 'ZZ000000015CN']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"message":"An error has occurred."}', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>', 'challenge'],
      ['<html><head><title>Just a moment...</title></head><body></body></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['', 'schema'], ['{"items":[]}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(SENDON), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: SENDON })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('sendon')));
    await expect(carrier(flaky).track({ number: SENDON })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('sendon')));
    await expect(carrier(immediate).track({ number: SENDON }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: SENDON }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: SENDON }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an item filed under MaltaPost to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('sendon')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: SENDON, carrier: 'maltapost' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'maltapost', source: 'maltapost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${MALTAPOST_ENDPOINT}?`))).toBe(true);
  });

  it('keeps its own scans on Malta’s clock after a posting abroad, whose wall clock takes its place’s zone', async () => {
    const posted = edited('returned', payload => { payload.movements!.at(-1)!.location = 'CHINA'; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(JSON.stringify(posted)));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNED, carrier: 'maltapost' }, { budgetMs: 3000 });
    const events = answer.result.events;
    expect(events.at(-1)).toMatchObject({ local_time: '2026-03-02T05:44:09', time_zone: 'Asia/Shanghai', time_zone_basis: 'place' });
    expect(events.slice(0, -1).every(event => event.time_zone === 'Europe/Malta' && event.time_zone_basis === 'carrier')).toBe(true);
    expect(events.at(-2)).toMatchObject({ local_time: '2026-03-13T14:10:28', time: '2026-03-13T14:10:28+01:00' });
  });

  it('is asked about Maltese S10 codes, which detection leaves with the postal fallback, and keeps its links', () => {
    expect(detectCarrierMatch(SENDON)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(SENDON)[0]).toBe('maltapost');
    expect(recognitionAskedCarriers('ZZ000000015MT')).not.toContain('maltapost');
    expect(recognitionAskedCarriers(RETURNED)).not.toContain('maltapost');
    expect(parseTrackingInput(`https://www.maltapost.com/tracking#/tracking?barcode=${SENDON}`))
      .toMatchObject({ trackingNumber: SENDON, carrier: 'maltapost', source: 'link' });
  });
});

describe('MaltaPost status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the ones it leaves out on purpose', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(maltaPostCodeStage(entry.code), entry.code).toBe(stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(stage);
      if (!stage) {
        expect(statusMapAnswer({ carrier: 'maltapost', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
      }
    }
    for (const code of ['constructor', 'toString', 'XYZ', '', 'EMZ/E']) expect(maltaPostCodeStage(code), code).toBeUndefined();
    expect(statusMap.stage(null, 'item delivered/collected by recipient')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'maltapost', providerCode: 'EMH/E', description: 'Item could not be processed further. Item returned to sender' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'maltapost', providerCode: 'EDC', description: 'Item returned from local Customs office' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
