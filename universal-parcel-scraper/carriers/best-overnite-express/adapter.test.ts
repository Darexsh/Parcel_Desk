import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BOE_API, BestOverniteTracker } from './adapter.js';
import { normalizeBoeNumber, parseBoe } from './parser.js';
import { boeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '012345670';
const IN_TRANSIT = '087654320';
const UNKNOWN = '011122233';

type Row = Record<string, unknown>;
type Reply = Row & { collHistories: Row[]; objShipper: Row; objConsignee: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const transit = (change: (body: Reply) => void) => changed('in-transit', change);
const delivered = (change: (body: Reply) => void) => changed('delivered', change);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseBoe>) => result.events!.map((event) => [event.time ?? event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);
// A scan in the history's shape, at an invented terminal.
const row = (description: string, date: string, time: string, location = 'HUBTOWN'): Row => ({ date, description, location, time });
// The parties' states of a shipment, the only thing the clocks' zone is read from.
const between = (from: string, to: string) => (body: Reply) => { body.objShipper.state = from; body.objConsignee.state = to; };

describe('Best Overnite Express HTTP adapter', () => {
  it('asks the tracking widget’s lookup for the whole PRO number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BestOverniteTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 8765-4320 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BOE_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    // The number goes padded to the nine digits the service gives it, without the page's captcha token or key.
    expect(JSON.parse(String(init!.body))).toEqual({ trackingType: 'PRO', trackingNumber: IN_TRANSIT });
    expect(Object.keys(init!.headers as Row)).not.toContain('X-Captacha-Token');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'best-overnite-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history within California in Pacific time, without the signer or the parties', () => {
    const result = parseBoe(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'DELIVERED (CLEAR)',
      last_update: '2026-03-04T14:25:00-08:00', delivered_at: '2026-03-04T14:25:00-08:00', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('summary_only');
    // The pickup at midnight is a day without a time; the delivery's place is who signed, so it has none.
    expect(events(result)).toEqual([
      ['2026-03-04T14:25:00-08:00', 'DELIVERED (CLEAR)', 'delivered', null],
      ['2026-03-02', 'PICK UP MADE', 'accepted', 'HUBTOWN'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/DOE|SAMPLE WAY|EXAMPLE|SAMPLEVILLE|FLOORING|909|SAMPLEBOL|PO0|signed/i);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('sender_name');
  });

  it('reads a shipment leaving California as wall clocks, with the day the service estimates', () => {
    const result = parseBoe(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', last_status_text: 'PICK UP MADE',
      last_update: null, last_update_local: '2026-07-13T15:10:00', expected_delivery: '2026-07-15',
    });
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([['2026-07-13T15:10:00', 'PICK UP MADE', 'accepted', 'SAMPLE VALLEY']]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE MESA|HOME STORE|FURNITURE|EXAMPLE ROAD|859|PU0|SAMPLEBOL/i);
  });

  it('reads the clocks in Pacific time only between places that keep it throughout', () => {
    const clock = (change: (body: Reply) => void) => parseBoe(transit(change), IN_TRANSIT).events![0]!;
    expect(clock(between('CA', 'CA'))).toMatchObject({ time: '2026-07-13T15:10:00-07:00' });
    expect(clock(between('WA', 'CA'))).toMatchObject({ time: '2026-07-13T15:10:00-07:00' });
    expect(clock(between('ca', ' ca '))).toMatchObject({ time: '2026-07-13T15:10:00-07:00' });
    // Arizona keeps no summer time, Oregon and Nevada each have a corner on Mountain time.
    for (const [from, to] of [['CA', 'AZ'], ['CA', 'NV'], ['OR', 'CA'], ['CA', ''], ['', ''], ['CA', 'ON']]) {
      expect(clock(between(from!, to!)), `${from} ${to}`).toEqual(expect.objectContaining({ local_time: '2026-07-13T15:10:00' }));
      expect(clock(between(from!, to!))).not.toHaveProperty('time');
    }
    expect(clock((body) => { delete (body as Row).objShipper; })).toMatchObject({ local_time: '2026-07-13T15:10:00' });
    // The hour the clocks repeat in autumn reads as its first occurrence.
    expect(clock((body) => { between('CA', 'CA')(body); body.collHistories[0] = row('PICK UP MADE', 'Nov 01 2026', '01:30'); }))
      .toMatchObject({ time: '2026-11-01T01:30:00-07:00' });
    // A day without a time stays a day, in any zone.
    expect(clock((body) => { between('CA', 'CA')(body); body.collHistories[0]!.time = ''; })).toEqual(expect.objectContaining({ local_time: '2026-07-13' }));
  });

  it('keeps a terminal’s town as the place, and nothing that could name a person', () => {
    const place = (location: string, description = 'PICK UP MADE') =>
      parseBoe(delivered((body) => { body.collHistories[0] = row(description, 'Mar 02 2026', '09:15', location); }), DELIVERED).events![1]!.location ?? null;
    expect(place('HUBTOWN')).toBe('HUBTOWN');
    expect(place('sample valley')).toBe('SAMPLE VALLEY');
    expect(place('  SAMPLE   VALLEY ')).toBe('SAMPLE VALLEY');
    expect(place('')).toBeNull();
    // Who signed, the consignee or the shipper, however written, and any text with punctuation or digits.
    for (const location of ['J DOE', 'JDOE', 'DOE JANE Q', 'SAMPLE FLOORING CO', 'J.DOE', 'DOE,J', '100 SAMPLE WAY', 'DOCK #4']) {
      expect(place(location), location).toBeNull();
    }
    expect(place('SAMPLETON', 'DELIVERED (SHORT)')).toBeNull();
  });

  it('settles a delivery whatever is recorded after it, keeps a repeated scan once and stages other wording by the shared rules', () => {
    const newest = (...rows: Row[]) => parseBoe(transit((body) => { body.collHistories.push(...rows); }), IN_TRANSIT);
    const after = newest(row('DELIVERED (CLEAR)', 'Jul 15 2026', '11:00', 'J.DOE'), row('SAMPLE NOTE', 'Jul 16 2026', '08:00'));
    expect(after).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'SAMPLE NOTE', expected_delivery: null,
      last_update_local: '2026-07-16T08:00:00' });
    // Outside Pacific time the delivery has no instant, so it has no delivery time.
    expect(after).not.toHaveProperty('delivered_at');
    expect(after.events![0]).not.toHaveProperty('stage');
    expect(newest(row('OUT FOR DELIVERY', 'Jul 15 2026', '07:30')).events![0])
      .toMatchObject({ stage: 'out_for_delivery', stage_source: expect.stringMatching(/^wording:/) });
    expect(newest(row('PICK UP MADE', 'Jul 13 2026', '15:10', 'SAMPLE VALLEY')).events).toHaveLength(1);
    expect(newest(row('PICK UP MADE', 'Jul 13 2026', '15:10', 'HUBTOWN')).events).toHaveLength(2);
  });

  it('reads a shipment without scans from its delivery status line, and anything else as no history', () => {
    const summary = parseBoe(delivered((body) => { body.collHistories = []; body.historyCount = 0; }), DELIVERED);
    expect(summary).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-03-04T14:25:00-08:00', expected_delivery: null, delivered_at: '2026-03-04T14:25:00-08:00',
      summary_only: true, events: [],
    });
    expect(parseBoe(transit((body) => { body.collHistories = []; body.status = 'Delivered on 7/15/2026 at 11:00 signed by J.DOE'; }), IN_TRANSIT))
      .toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-07-15T11:00:00', summary_only: true });
    for (const status of ['', 'In Transit', 'Delivered on 2/30/2026 at 11:00', 'Delivered on 7/15/2026 at 25:00']) {
      const empty = transit((body) => { body.collHistories = []; body.status = status; });
      expect(() => parseBoe(empty, IN_TRANSIT), status).toThrow(expect.objectContaining({ kind: status.includes('25:') ? 'schema' : 'indeterminate' }));
    }
    expect(() => parseBoe(transit((body) => { (body as Row).collHistories = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the unknown answer as not found, and a reply only when it names the PRO number asked', () => {
    expect(() => parseBoe(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBoe(fixture('not-found'), '11122233')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The unknown answer for another number, or a shipment under another, says nothing about this one.
    expect(() => parseBoe(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate',
      message: 'Best Overnite answered for another number' }));
    expect(() => parseBoe(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate',
      message: 'Best Overnite answered for another shipment' }));
    expect(() => parseBoe(transit((body) => { body.proNum = '87654320'; }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBoe(transit((body) => { body.proNum = ''; }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The service names no number when it refuses one's form, which a whole PRO number never is.
    expect(() => parseBoe(changed('not-found', (body) => { body.errorCode = 'BadProNbr'; body.proNum = ''; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBoe(changed('not-found', (body) => { body.errorCode = 'SAMPLEERR'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).proNum; },
      (body: Reply) => { (body as Row).proNum = 87654320; },
      (body: Reply) => { delete (body as Row).errorCode; },
      (body: Reply) => { (body as Row).collHistories = 'none'; },
      (body: Reply) => { body.collHistories[0] = 'scan' as never; },
      (body: Reply) => { body.collHistories[0]!.description = ''; },
      (body: Reply) => { body.collHistories[0]!.description = 7; },
      (body: Reply) => { body.collHistories[0]!.location = ['HUBTOWN']; },
      (body: Reply) => { body.collHistories[0]!.date = '2026-07-13'; },
      (body: Reply) => { body.collHistories[0]!.date = 'Feb 30 2026'; },
      (body: Reply) => { body.collHistories[0]!.date = 'Jux 13 2026'; },
      (body: Reply) => { body.collHistories[0]!.date = ''; },
      (body: Reply) => { body.collHistories[0]!.time = '24:00'; },
      (body: Reply) => { body.collHistories[0]!.time = '3:10 PM'; },
      (body: Reply) => { body.estDeliveryDate = 'soon'; },
      (body: Reply) => { body.estDeliveryDate = '13/07/2026'; },
      (body: Reply) => { (body as Row).objShipper = 'CA'; },
      (body: Reply) => { body.objConsignee.state = 6; },
      (body: Reply) => { body.signedBy = { name: 'J.DOE' }; },
      (body: Reply) => { body.collHistories = Array.from({ length: 501 }, () => body.collHistories[0]!); },
    ]) {
      expect(() => parseBoe(transit(change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, [], {}, { errorCode: '' }, { proNum: IN_TRANSIT }]) {
      expect(() => parseBoe(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // The estimate also comes in the scans' spelling.
    expect(parseBoe(transit((body) => { body.estDeliveryDate = 'Jul 15 2026'; }), IN_TRANSIT)).toMatchObject({ expected_delivery: '2026-07-15' });
    expect(parseBoe(transit((body) => { body.estDeliveryDate = ''; }), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
  });

  it('keeps an unknown PRO number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.bestovernite.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The service's validation answer for a request it no longer reads.
    await expect(lookup({ title: 'One or more validation errors occurred.', status: 400 }, { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // A server's error page in place of the reply is a changed route, not a missing shipment.
    await expect(lookup('<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ title: 'Synthetic failure' }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known PRO number and the unknown answer, and asks nothing for another shape', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T22:25:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects what is not a whole PRO number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The service pads a shorter number into another PRO number, so only eight or nine digits are sent.
    for (const number of ['1', '1234567', '1234567890', '1234567A', 'ABCDEFGH', '1234/5678', '1234567%', `${'1'.repeat(65)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [typed, number] of [[' 1234-5670 ', DELIVERED], ['012 345 670', DELIVERED], ['87654320', IN_TRANSIT]]) {
      expect(normalizeBoeNumber(typed!), typed).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'accepted' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a PRO number the caller names Best Overnite’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'best-overnite-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'best-overnite-express', source: 'best-overnite-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === BOE_API)).toBe(true);
  });
});

describe('Best Overnite Express numbers', () => {
  it('leaves bare eight and nine digits out of recognition, and reads classic trace links', () => {
    expect(recognitionAskedCarriers('12345670')).not.toContain('best-overnite-express');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('best-overnite-express');
    expect(parseTrackingInput('https://tgif.bestovernite.com/cgi-bin/wbprotrk?wbfb=12345670&wbscac=&button=Trace'))
      .toMatchObject({ trackingNumber: '12345670', carrier: 'best-overnite-express', source: 'link' });
  });
});

describe('Best Overnite Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(boeStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'best-overnite-express', description: 'PICK UP MADE' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'best-overnite-express', description: 'sample note' })).toEqual({ kind: 'unknown' });
  });
});
