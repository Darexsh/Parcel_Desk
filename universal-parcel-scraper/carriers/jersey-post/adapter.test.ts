import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JERSEY_POST_API, JerseyPostTracker } from './adapter.js';
import { normalizeJerseyPostNumber, parseJerseyPost } from './parser.js';
import { jerseyPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'LX000000014JE';
const IN_TRANSIT = 'UM000000028JE';
const UNKNOWN = 'LX000000005JE';

type Row = Record<string, unknown>;
type Item = Row & { events: Row[]; carrier: Row };
type Reply = Row & { data: Item[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (item: Item, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jersey Post HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JerseyPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' um 000 000 028 je ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(JERSEY_POST_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ query: IN_TRANSIT, sentFromJsy: '' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jersey-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the delivered history with its places and wall clocks, without the proof of delivery or the repeated scan', () => {
    const result = parseJerseyPost(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item delivered to customer', last_update: null, last_update_local: '2026-03-12T10:41:00' });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-12T10:41:00', 'delivered', 'Sampleland'],
      ['2026-03-11T09:05:00', 'ready_for_pickup', 'Sampleland'],
      ['2026-03-11T07:30:00', 'failed_attempt', 'Sampleland'],
      ['2026-03-10T16:12:00', 'in_transit', 'Sampleland'],
      // The office of exchange abroad is no acceptance, and its repeated scan is kept once.
      ['2026-03-10T08:47:00', 'in_transit', 'Sampleland'],
      ['2026-03-08T21:03:00', 'in_transit', 'Sampleland'],
      ['2026-03-05T15:20:00', 'in_transit', 'Jersey'],
      ['2026-03-05T11:58:00', 'in_transit', 'United Kingdom of Great Britain and Northern Ireland'],
      // Jersey Post's own scans have no place and keep their seconds.
      ['2026-03-04T17:26:33', 'in_transit', null],
      ['2026-03-04T12:09:51', 'registered', null],
      ['2026-03-02T19:44:07', 'registered', null],
    ]);
    expect(result.events![2]).toMatchObject({ description: 'Unsuccessful Delivery Attempt - Incorrect/illegible/incomplete address' });
    // The reply names no zone, so no clock becomes an instant.
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE SIGNER|pod|carrierLogo|base64/i);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('keeps a history relayed for an untracked-service number held by customs abroad', () => {
    const result = parseJerseyPost(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Item Held By Customs',
      last_update_local: '2026-05-19T06:14:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['Item Held By Customs', 'Item Received', 'Item being sent to customer']);
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseJerseyPost(changed('delivered', (item) => { item.events.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-03-12T10:41:00', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Awaiting Item from sender' });
  });

  it('leaves wording neither the map nor the shared rules know without a stage', () => {
    const result = parseJerseyPost(changed('in-transit', (item) => {
      item.events.unshift({ eventDate: '2026-05-20', eventTime: '08:00:00', eventLocation: '', eventDesc: 'Synthetic note', eventStatusCode: 1 });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_status_text: 'Synthetic note', current_stage: 'customs' });
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('reads the tracker’s answers that are not a history', () => {
    expect(() => parseJerseyPost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const answer = (result: number, carrierID = 10) => changed('not-found', (item) => { item.result = result; item.carrier.carrierID = carrierID; });
    expect(() => parseJerseyPost(answer(2), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseJerseyPost(answer(4), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // Another carrier's entry sends the visitor to that carrier's site, with no history.
    for (const [result, carrierID] of [[1, 82], [3, 82], [5, 82]] as const) {
      expect(() => parseJerseyPost(answer(result, carrierID), UNKNOWN))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jersey Post sent the number to another carrier' }));
    }
    expect(() => parseJerseyPost(answer(6), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJerseyPost(answer(-1), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJerseyPost({ success: false, errors: 'No tracking numbers supplied, or bad request format.', data: [] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJerseyPost(changed('delivered', (item) => { item.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts an item only when it names the number asked', () => {
    expect(() => parseJerseyPost(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jersey Post answered for another item' }));
    expect(parseJerseyPost(changed('in-transit', (item) => { item.trackingNumber = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_item: Item, body: Reply) => { delete (body as Row).success; },
      (_item: Item, body: Reply) => { body.data = 'items' as never; },
      (_item: Item, body: Reply) => { body.data = []; },
      (item: Item, body: Reply) => { body.data = [item, item]; },
      (_item: Item, body: Reply) => { body.data = ['item' as never]; },
      (item: Item) => { delete item.trackingNumber; },
      (item: Item) => { item.result = 7; },
      (item: Item) => { item.result = '1'; },
      (item: Item) => { item.events = 'events' as never; },
      (item: Item) => { item.events = Array.from({ length: 501 }, () => item.events[0]!); },
      (item: Item) => { item.events[0] = 'scan' as never; },
      (item: Item) => { item.events[0]!.eventDate = '19/05/2026'; },
      (item: Item) => { item.events[0]!.eventTime = '06:14'; },
      (item: Item) => { item.events[0]!.eventTime = '24:00:00'; },
      (item: Item) => { item.events[0]!.eventDate = '2026-02-30'; },
      (item: Item) => { delete item.events[0]!.eventTime; },
      (item: Item) => { item.events[0]!.eventDesc = ['Item Received']; },
      (item: Item) => { item.events[0]!.eventDesc = ' '; },
      (item: Item) => { item.events[0]!.eventLocation = 7; },
    ]) {
      expect(() => parseJerseyPost(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing item from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>Runtime Error</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.jerseypost.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Web Page Blocked</title></head><body>FortiWeb</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Jersey Post</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Jersey Post does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T10:41:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('LX000000014GB')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Jersey Post does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // Another post's code, a wrong check digit, a short serial and a reference that is not S10.
    for (const number of ['LX000000014GB', 'LX000000010JE', 'LX00000014JE', 'SAMPLETRACKING', `LX${'0'.repeat(60)}JE`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJerseyPostNumber('lx 000-000-014 je')).toBe(DELIVERED);
  });

  it('sends a read that fails to reach the site once more within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Jersey Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'jersey-post' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jersey-post', source: 'jersey-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === JERSEY_POST_API)).toBe(true);
  });
});

describe('Jersey Post numbers', () => {
  it('leaves S10 numbers ending JE with postal detection and asks Jersey Post about them first', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
      expect(recognitionAskedCarriers(number)[0], number).toBe('jersey-post');
    }
    // A wrong check digit or another post's code is not asked.
    for (const number of ['LX000000010JE', 'LX000000014GB']) expect(recognitionAskedCarriers(number), number).not.toContain('jersey-post');
  });
});

describe('Jersey Post status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(jerseyPostStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'jersey-post', description: 'Unsuccessful Delivery Attempt - Addressee absent' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'jersey-post', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared wording rules.
    expect(jerseyPostStage('Item out for delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(jerseyPostStage('Synthetic note')).toBeNull();
  });
});
