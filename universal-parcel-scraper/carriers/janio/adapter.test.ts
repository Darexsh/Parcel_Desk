import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JANIO_API, JanioTracker } from './adapter.js';
import { normalizeJanioNumber, parseJanio } from './parser.js';
import { janioStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'JNTH000000000001';
const IN_TRANSIT = 'JNSG000000000000';
const RELATED = 'JNHK000000000000';
const UNKNOWN = 'JNMY000000000000';
const PARTNER = 'SPXSG000000000000';

type Row = Record<string, unknown>;
type Entry = Row & { status_updates: Row[]; external_tracking_nos?: Record<string, unknown> };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Entry[];
/** The fixture with a change to the entry of the number asked. */
const changed = (name: string, number: string, change: (entry: Entry, reply: Entry[]) => void) => {
  const reply = fixture(name);
  change(reply.find((entry) => entry.tracking_no === number)!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Janio HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JanioTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jnsg 0000-0000-0000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JANIO_API}?tracking_nos=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'janio', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each update as an instant, stages it by its code and keeps the delivery without the recipient', () => {
    const result = parseJanio(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel has been successfully delivered to the recipient.', last_update: '2026-05-14T06:12:40Z',
      delivered_at: '2026-05-14T06:12:40Z', expected_delivery: null, destination_country: 'TH' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-05-14T06:12:40Z', 'DELIVERY_COMPLETED', 'delivered', null],
      ['2026-05-14T01:30:05Z', 'DELIVERY_IN_PROGRESS', 'out_for_delivery', null],
      ['2026-05-13T23:58:12Z', 'IN_TRANSIT_WITHIN_DESTINATION_COUNTRY', 'in_transit', null],
      // The repeated partner scan is kept once.
      ['2026-05-13T11:20:00Z', 'IN_TRANSIT_WITHIN_DESTINATION_COUNTRY', 'in_transit', null],
      ['2026-05-12T03:45:00Z', 'CROSS_BORDER_TRANSIT', 'in_transit', null],
      ['2026-05-11T14:02:33.512Z', 'IN_TRANSIT_WITHIN_ORIGIN_COUNTRY', 'in_transit', 'Singapore'],
      ['2026-05-10T08:15:09.410Z', 'PENDING_PICKUP', 'registered', 'Singapore'],
      ['2026-05-10T08:15:08.123Z', 'ORDER_CREATED', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // Janio's own number as SCG's reference and its first-mile leg name no delivery partner.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:District|Province)|shortened|ex\*|scg|jtms|DRIVER_ASSIGNED|0{15}|Thailand/);
  });

  it('picks the parcel asked out of its related orders and names a partner whose reference has its shape', () => {
    const result = parseJanio(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel has arrived at a warehouse and is awaiting processing.', last_update: '2026-06-04T09:41:27Z',
      expected_delivery: null, destination_country: 'SG', delivery_carrier: 'spx-sg', delivery_tracking_number: PARTNER });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-06-04T09:41:27Z', 'IN_TRANSIT_WITHIN_DESTINATION_COUNTRY', 'in_transit', 'Singapore'],
      ['2026-06-03T00:00:00Z', 'CROSS_BORDER_TRANSIT', 'in_transit', null],
      ['2026-06-02T06:05:22.009Z', 'IN_TRANSIT_WITHIN_ORIGIN_COUNTRY', 'in_transit', 'Hong Kong'],
      ['2026-06-01T10:00:00Z', 'FAILED_PICKUP', 'registered', null],
      ['2026-06-01T02:55:06.239Z', 'ORDER_CREATED', 'registered', null],
    ]);
    // The related order is its own parcel, with a destination the catalog names no code for.
    expect(parseJanio(fixture('in-transit'), RELATED)).toMatchObject({ current_stage: 'registered', destination_country_name: 'Hong Kong',
      last_update: '2026-06-01T02:00:00Z' });
  });

  it('proposes a named partner with its own adapter and its reference for the hand-off', () => {
    const ninja = changed('in-transit', IN_TRANSIT, (entry) => { entry.external_tracking_nos = { ninjavan: 'NLSGAA00000000' }; });
    expect(deliveryHandoff('janio', IN_TRANSIT, parseJanio(ninja, IN_TRANSIT)))
      .toEqual({ carrier: 'ninja-van', number: 'NLSGAA00000000', basis: 'partner' });
    expect(deliveryHandoff('janio', IN_TRANSIT, parseJanio(fixture('in-transit'), IN_TRANSIT)))
      .toEqual({ carrier: 'spx-sg', number: 'SPXSG000000000000', basis: 'partner' });
    expect(deliveryHandoff('janio', DELIVERED, parseJanio(fixture('delivered'), DELIVERED))).toBeNull();
  });

  it('finds a parcel by its partner’s reference and gives Janio’s own number, as the page does', () => {
    const reply = changed('in-transit', IN_TRANSIT, (entry) => { entry.searched_by = PARTNER; });
    const result = parseJanio(reply, PARTNER.toLowerCase());
    expect(result).toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT, delivery_carrier: 'spx-sg' });
    // The reference asked is no second one.
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('names a partner only when one catalog carrier has the shape of its reference', () => {
    const partner = (references: unknown) => {
      const result = parseJanio(changed('in-transit', IN_TRANSIT, (entry) => { entry.external_tracking_nos = references as never; }), IN_TRANSIT);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    expect(partner({ ninjavan: 'NLSGAA00000000' })).toEqual(['ninja-van', 'NLSGAA00000000']);
    expect(partner({ spx: 'spxsg 0000-0000-0000' })).toEqual(['spx-sg', PARTNER]);
    expect(partner({ jtms_sg_fm_janio: '000000000000000', spx: PARTNER })).toEqual(['spx-sg', PARTNER]);
    // Two partners, a key the catalog does not know, a reference of another shape and a value that is not text name none.
    expect(partner({ spx: PARTNER, ninjavan: 'NLSGAA00000000' })).toEqual([null, null]);
    expect(partner({ samplepost: PARTNER })).toEqual([null, null]);
    expect(partner({ spx: IN_TRANSIT, singpost: IN_TRANSIT })).toEqual([null, null]);
    expect(partner({ spx: 0 })).toEqual([null, null]);
    expect(partner({})).toEqual([null, null]);
    expect(partner(null)).toEqual([null, null]);
  });

  it('words an update without a description by its code and leaves an unknown code to the wording rules', () => {
    const untitled = parseJanio(changed('delivered', DELIVERED, (entry) => { entry.status_updates[0]!.description = null; }), DELIVERED);
    expect(untitled.events![0]).toMatchObject({ description: 'Delivery Completed', stage: 'delivered', stage_source: 'carrier_map' });
    const unknown = parseJanio(changed('delivered', DELIVERED, (entry) => { entry.status_updates[0]!.status = 'SAMPLE_CODE'; }), DELIVERED);
    expect(unknown).toMatchObject({ current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(unknown).not.toHaveProperty('delivered_at');
    const unread = parseJanio(changed('delivered', DELIVERED, (entry) => {
      Object.assign(entry.status_updates[0]!, { status: 'SAMPLE_CODE', description: 'Synthetic note' });
    }), DELIVERED);
    expect(unread).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
    expect(unread.events![0]).not.toHaveProperty('stage');
  });

  it('reads an empty list as not found, an entry without updates as no history and another parcel as inconclusive', () => {
    expect(() => parseJanio(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJanio(changed('delivered', DELIVERED, (entry) => { entry.status_updates = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseJanio(changed('delivered', DELIVERED, (entry) => { delete (entry as Row).status_updates; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseJanio(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Janio answered for another shipment' }));
    // A reference the entry carries elsewhere, or a partial number, binds nothing.
    expect(() => parseJanio(fixture('in-transit'), PARTNER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJanio(fixture('in-transit'), IN_TRANSIT.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_entry: Entry, body: Entry[]) => { body.length = 0; body.push('parcel' as never); },
      (entry: Entry) => { delete entry.tracking_no; },
      (entry: Entry) => { entry.tracking_no = 0; },
      (entry: Entry) => { entry.status_updates = 'updates' as never; },
      (entry: Entry) => { entry.status_updates = Array.from({ length: 501 }, () => entry.status_updates[0]!); },
      (entry: Entry) => { entry.status_updates[0] = 'update' as never; },
      (entry: Entry) => { entry.status_updates[0]!.updated_on = '2026-05-14 06:12:40'; },
      (entry: Entry) => { entry.status_updates[0]!.updated_on = '2026-05-14T06:12:40'; },
      (entry: Entry) => { entry.status_updates[0]!.updated_on = '2026-02-30T06:12:40Z'; },
      (entry: Entry) => { delete entry.status_updates[0]!.updated_on; },
      (entry: Entry) => { entry.status_updates[0]!.status = 7; },
      (entry: Entry) => { entry.status_updates[0]!.status = 'DELIVERED!'; },
      (entry: Entry) => { entry.status_updates[0]!.status = ''; entry.status_updates[0]!.description = ''; },
      (entry: Entry) => { entry.status_updates[0]!.description = ['Delivered']; },
      (entry: Entry) => { entry.status_updates[0]!.country = { name: 'Sampleland' }; },
      (entry: Entry) => { entry.external_tracking_nos = ['SPXSG000000000000'] as never; },
      (entry: Entry) => { entry.consignee_country = 7; },
    ]) {
      expect(() => parseJanio(changed('delivered', DELIVERED, change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseJanio({ message: 'Comma separated string of tracking_nos is required.' }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJanio(Array.from({ length: 51 }, () => fixture('delivered')[0]), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads an unknown number from an empty list: a 404 or a redirect is a moved route.
    await expect(lookup({ detail: 'Not found.' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: `${JANIO_API}?tracking_nos=${UNKNOWN}` } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html><head><title>Janio Tracker</title></head><body><div id="root"></div></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Janio does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-14T06:12:40.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A reply about other parcels is no answer either way.
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('JN-00')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Janio does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JN00000', 'SAMPLETRACKING', `JN${'0'.repeat(39)}`, `JN${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJanioNumber('jnth 0000-0000-0001')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('routes a number filed under Janio, or one only its rule offers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'janio' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'janio', source: 'janio', result: { current_stage: 'delivered' } });
    // Recognition settles on recent parcels only: the fixture's week is the present.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-05-15T12:00:00Z') });
    try {
      await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'janio', source: 'janio', result: { current_stage: 'delivered' } });
    } finally {
      vi.useRealTimers();
    }
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${JANIO_API}?tracking_nos=${DELIVERED}`)).toBe(true);
  });
});

describe('Janio numbers', () => {
  it('suggests Janio for its JN layout, beside AliExpress for the JNCN form', () => {
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['janio'] });
    expect(detectCarrierMatch('JNCN000000000000').candidates).toEqual(expect.arrayContaining(['aliexpress', 'janio']));
    for (const number of ['JNSG00000000000', 'JNSG0000000000000', 'JN0000000000000000']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('janio');
    }
  });
});

describe('Janio status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(janioStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'janio', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'janio', providerCode: 'SAMPLE_CODE', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(janioStage('SAMPLE_CODE', 'The parcel has been successfully delivered to the recipient.')?.stage).toBe('delivered');
    expect(janioStage('SAMPLE_CODE', 'Synthetic note')).toBeNull();
    expect(janioStage('delivery_completed', 'Synthetic note')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
