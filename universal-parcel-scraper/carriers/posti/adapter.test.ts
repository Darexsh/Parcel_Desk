import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { PostiTracker, adapter, normalizePostiTrackingNumber, parse } from './adapter.js';
import { postiEventStage, postiStatus } from './status.js';

const NUMBER = 'CW123456785FR';
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const hit = (value: ReturnType<typeof fixture>) => value.data.consumerSearchShipments.hits[0];
const jwt = (expiry = Date.now() / 1000 + 3600) => `fixture.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.unsigned`;
const tokens = () => Response.json({ id_token: jwt(), role_tokens: [{ type: 'anonymous', token: jwt() }] });
afterEach(() => vi.restoreAllMocks());

describe('Posti projection', () => {
  it('binds identity, sorts offset timestamps, and selects only declared fields', () => {
    const data = fixture();
    hit(data).events.reverse();
    const result = parse(data, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', weight_kg: 0.5,
      dimensions_text: '25 × 15 × 10 cm', pickup_point: 'Example pickup point\nExample street 1\n00000 Example city',
      timezone: 'Europe/Helsinki' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'pending', 'ready_for_pickup', 'in_transit', 'in_transit']);
    expect(result.last_update).toBe('2026-01-12T13:00:00Z');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const capabilities = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')).capabilities;
    expect(capabilities).toEqual(['history', 'location', 'weight', 'dimensions', 'pickup_point']);
    expect(result.events?.every((event) => event.description && event.time)).toBe(true);
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const data = fixture();
    const scan = (eventDescription: string, timestamp: string) => ({ eventDescription, city: 'EXAMPLE CITY', timestamp });
    hit(data).events = [scan('Item is in sorting', '2026-01-11T09:00:00Z'), scan('Item has arrived', '2026-01-12T09:00:00Z'),
      scan('Item is in transport', '2026-01-12T09:00:00Z')];
    expect(parse(data, NUMBER).events?.map((event) => event.description)).toEqual(['Item is in transport', 'Item has arrived', 'Item is in sorting']);
  });

  it('ends the status before its explanation', () => {
    const descriptions = parse(fixture(), NUMBER).events?.map((event) => event.description);
    expect(descriptions).toContain('Item is ready for a pick up. Pickup details are available in the arrival notice.');
    expect(descriptions).toContain('We sent the recipient an email about the item.');
    const abroad = parse(fixture('delivered-abroad'), 'CE123456785FI').events?.map((event) => event.description);
    expect(abroad).toContain('Item delivered to the recipient.');
    expect(abroad).toContain('Item has been registered. The item can be registered several times during delivery.');
  });

  it('names a public pickup point with its address only while the parcel waits there', () => {
    const data = fixture('ready-for-pickup');
    const result = parse(data, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup',
      pickup_point: 'Example parcel locker\nExample street 1\n00000 EXAMPLE CITY' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    hit(data).pickupPoint.type = 'POSTI_SERVICE_POINT';
    delete hit(data).pickupPoint.address.postcode;
    expect(parse(data, NUMBER).pickup_point).toBe('Example parcel locker\nExample street 1\nEXAMPLE CITY');
    // A planned point in transit and a point on the way back to the sender are not waiting points.
    for (const main of ['IN_TRANSPORT', 'RETURN_READY_FOR_PICKUP']) {
      expect(parse({ ...data, data: { consumerSearchShipments: { totalHits: 1, hits: [{ ...hit(data), status: { main, subStatus: [] } }] } } }, NUMBER)
        .pickup_point).toBeNull();
    }
  });

  it('lets the scans of an inbound item outrank a main status still at pre-advice', () => {
    const data = fixture();
    const waiting = (main: string, events: object[]) => parse({ data: { consumerSearchShipments: { totalHits: 1, hits: [{
      ...hit(data), status: { main, subStatus: [] }, events,
    }] } } }, NUMBER);
    const advice = { eventDescription: 'We have received information about an upcoming delivery from the sender', city: '', timestamp: '2026-01-10T09:00:00Z' };
    const mailed = { eventDescription: 'Item is in transport in country of origin.', city: '', timestamp: '2026-01-11T09:00:00Z' };
    const departed = { eventDescription: 'Item has departed from country of origin', city: '', timestamp: '2026-01-12T09:00:00Z' };
    const notice = { eventDescription: 'We sent the recipient a text message about the item', city: '', timestamp: '2026-01-13T09:00:00Z' };
    for (const main of ['WAITING', 'ORDER_RECEIVED']) {
      expect(waiting(main, [departed, mailed])).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', provider_status: main });
      expect(waiting(main, [notice, departed])).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
      expect(waiting(main, [advice])).toMatchObject({ status: 'pending', current_stage: 'registered' });
      expect(waiting(main, [])).toMatchObject({ status: 'pending', current_stage: 'registered' });
    }
    // A main status past pre-advice keeps its own stage.
    expect(waiting('READY_FOR_PICKUP', [departed])).toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('reads its copies of a Polish or French post\'s scans in the country of origin on that post\'s clock', () => {
    const data = fixture();
    const times = (number: string, events: object[]) => parse({ data: { consumerSearchShipments: { totalHits: 1, hits: [{
      ...hit(data), displayId: number, packages: [], events,
    }] } } }, number).events?.map((event) => event.time);
    // Poczta Polska's own scans at 11:44 and 15:26 Warsaw time; Posti shows them at 12:44 and 16:26 Helsinki time.
    const departed = { eventDescription: 'Item has departed from country of origin', city: 'ULKOMAILLA', timestamp: '2026-10-23T09:44:00Z' };
    const mailed = { eventDescription: 'Item is in transport in country of origin.', reasonDescription: 'The item has been mailed in the country of origin.',
      city: '', timestamp: '2026-10-22T13:26:00Z' };
    const arrived = { eventDescription: 'Item arrived in the destination country', city: '', timestamp: '2026-10-24T12:02:35Z' };
    const sorted = { eventDescription: 'Item is in sorting', city: 'EXAMPLE CITY', timestamp: '2026-10-25T08:00:00Z' };
    expect(times('CW123456785PL', [departed, mailed, arrived, sorted]))
      .toEqual(['2026-10-25T08:00:00Z', '2026-10-24T12:02:35Z', '2026-10-23T12:44:00+02:00', '2026-10-22T16:26:00+02:00']);
    // In winter too: Helsinki's 11:00 is Paris's.
    expect(times('CW123456785FR', [{ ...departed, timestamp: '2026-01-12T09:00:00Z' }])).toEqual(['2026-01-12T11:00:00+01:00']);
    // Another post's item, Posti's own number, and a scan naming a place keep Posti's time.
    expect(times('CW123456785DE', [departed])).toEqual(['2026-10-23T09:44:00Z']);
    expect(times('JJFI12345678901234567', [departed])).toEqual(['2026-10-23T09:44:00Z']);
    expect(times('CW123456785PL', [{ ...departed, city: 'EXAMPLE CITY' }])).toEqual(['2026-10-23T09:44:00Z']);
  });

  it('keeps the pickup point a delivered parcel was collected from, and no other', () => {
    const data = fixture('ready-for-pickup');
    const delivered = (events: object[]) => parse({ data: { consumerSearchShipments: { totalHits: 1, hits: [{
      ...hit(data), status: { main: 'DELIVERED', subStatus: [] }, events: [...events, ...hit(data).events],
    }] } } }, NUMBER).pickup_point;
    const collected = { eventDescription: 'The item has been delivered', city: 'EXAMPLE CITY', timestamp: '2026-01-13T09:00:00Z' };
    const notice = { eventDescription: 'We sent the recipient an email about the item.', city: '', timestamp: '2026-01-12T10:00:00Z' };
    expect(delivered([collected, notice])).toBe('Example parcel locker\nExample street 1\n00000 EXAMPLE CITY');
    // Taken back out for delivery after waiting: delivered to the door, not collected.
    expect(delivered([collected, { eventDescription: 'Item is out for delivery', city: 'EXAMPLE CITY', timestamp: '2026-01-13T07:00:00Z' }]))
      .toBeNull();
    expect(parse(fixture('delivered-abroad'), 'CE123456785FI').pickup_point).toBeNull();
  });

  it.each([
    ['a private locker', { type: 'LOCKER_PRIVATE' }, 'Example parcel locker\nEXAMPLE CITY'],
    ['an unknown type', { type: 'UNKNOWN' }, 'Example parcel locker\nEXAMPLE CITY'],
    ['no type', { type: null }, 'Example parcel locker\nEXAMPLE CITY'],
    ['no street', { address: { publicName: 'Example parcel locker', postcode: '00000', city: 'EXAMPLE CITY' } }, 'Example parcel locker\nEXAMPLE CITY'],
    ['no town', { address: { publicName: 'Example parcel locker', streetAddress: 'Example street 1' } }, 'Example parcel locker'],
    ['no name', { address: { streetAddress: 'Example street 1', postcode: '00000', city: 'EXAMPLE CITY' } }, null],
    ['no point', null, null],
  ])('keeps the street out of a pickup point with %s', (_case, change, expected) => {
    const data = fixture('ready-for-pickup');
    hit(data).pickupPoint = change && { ...hit(data).pickupPoint, ...change };
    expect(parse(data, NUMBER).pickup_point).toBe(expected);
  });

  it('gives scans abroad no location rather than Posti\'s "abroad" label', () => {
    const result = parse(fixture('delivered-abroad'), 'CE123456785FI');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: null });
    expect(result.events?.map((event) => [event.location, event.stage])).toEqual([
      ['', 'delivered'], ['', 'in_transit'], ['', 'in_transit'], ['', 'in_transit'],
      ['EXAMPLE AIRPORT', 'in_transit'], ['Example post office', 'accepted'],
    ]);
    const data = fixture('delivered-abroad');
    hit(data).events = [{ eventDescription: 'Item has been registered', city: ' ulkomailla ', timestamp: '2026-01-13T16:00:00Z' }];
    expect(parse(data, 'CE123456785FI').events?.[0]?.location).toBe('');
    // Nor is "Posti kuljetus" ("Posti transport"), on a scan between two sites, a place.
    hit(data).events = [{ eventDescription: 'The item is in transport', city: 'Posti kuljetus', timestamp: '2026-01-13T16:00:00Z' }];
    expect(parse(data, 'CE123456785FI').events?.[0]?.location).toBe('');
  });

  it('rejects wrong, duplicate and multi-parcel identities', () => {
    expect(() => parse(fixture(), 'CW000000005FR')).toThrow('different or ambiguous');
    const duplicate = fixture();
    duplicate.data.consumerSearchShipments.hits.push(structuredClone(hit(duplicate)));
    expect(() => parse(duplicate, NUMBER)).toThrow('ambiguous');
    const group = fixture();
    hit(group).packages = [{ trackingNumber: 'CW000000005FR', events: [] }];
    expect(() => parse(group, NUMBER)).toThrow('multi-parcel');
  });

  it.each([null, {}, { data: null }, { data: { consumerSearchShipments: { totalHits: 1, hits: [] } } }])(
    'does not classify malformed/partial responses as not found', (data) => {
      expect(() => parse(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    },
  );

  it('recognizes only a complete zero-hit response as not found', () => {
    expect(() => parse({ data: { consumerSearchShipments: { totalHits: 0, hits: [] } } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    const data = fixture(); data.errors = [{ message: 'Resolver unavailable' }];
    expect(() => parse(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps pre-advice and unknown codes from inventing progress', () => {
    const data = fixture(); hit(data).events = [];
    hit(data).status = { main: 'ORDER_RECEIVED', subStatus: [] };
    expect(parse(data, NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null });
    hit(data).status.main = 'NEW_UNKNOWN_CODE';
    expect(parse(data, NUMBER)).toMatchObject({ status: 'unknown', provider_status: 'NEW_UNKNOWN_CODE' });
    expect(parse(data, NUMBER).current_stage).toBeUndefined();
  });

  it('preserves unknown event time and rejects invalid measurements without fabricating values', () => {
    const data = fixture(); hit(data).events = [{ eventDescription: 'New wording', timestamp: '2026-01-12T12:00:00' }];
    hit(data).measurements = { weight: { value: '-1', unit: 'kg' }, length: { value: '20', unit: 'unknown' } };
    const result = parse(data, NUMBER);
    expect(result).toMatchObject({ weight_kg: null, dimensions_text: null, last_update: null });
    expect(result.events?.[0]).toMatchObject({ time: '', stage: 'pending' });
  });

  it('does not confuse collection, customs release and return movement with delivery', () => {
    expect(postiStatus('READY_FOR_PICKUP', [])?.stage).toBe('ready_for_pickup');
    expect(postiStatus('IN_TRANSPORT', ['UNDECLARED'])?.stage).toBe('customs');
    expect(postiStatus('RETURN_IN_TRANSPORT', [])?.stage).toBe('in_transit');
    expect(postiStatus('RETURN_DELIVERED', [])?.stage).toBe('returned');
    expect(postiEventStage('Item has been released for delivery.')).toBe('in_transit');
    expect(postiEventStage('We sent the recipient an email about the item.')).toBe('pending');
  });

  it.each([
    ['Item delivered to the recipient.', 'delivered'],
    ['Item has been registered', 'in_transit'],
    ['Item has arrived to destination country', 'in_transit'],
    ['Item is on the way to the recipient', 'in_transit'],
    ['Item is ready for delivery in destination country', 'in_transit'],
    ['Item in process in office of exchange.', 'in_transit'],
    ['The item is on its way to the destination country.', 'in_transit'],
    ['Item received for transport', 'accepted'],
  ])('maps %s independently of the final state and explanatory reason', (description, stage) => {
    const data = fixture();
    hit(data).events = [{ eventDescription: description,
      reasonDescription: 'If customs clearance is needed, the recipient is notified. Otherwise it is delivered.',
      timestamp: '2026-01-01T12:00:00Z' }];
    expect(parse(data, NUMBER).events?.[0]?.stage).toBe(stage);
  });
});

describe('Posti anonymous transport', () => {
  it('uses two cold requests, then one warm request, with no browser or supplied credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(Response.json(fixture()))
      .mockResolvedValueOnce(Response.json(fixture()));
    const tracker = new PostiTracker({ fetcher });
    await tracker.fetch(NUMBER); await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]![0]).toBe('https://auth-service.posti.fi/api/v1/anonymous_token');
    const request = fetcher.mock.calls[1]![1]!;
    const body = JSON.parse(String(request.body));
    expect(body.variables).toEqual({ searchTerms: [NUMBER], locale: 'en' });
    expect(body.query).toContain('type: PUBLIC_SHIPMENTS');
    expect(body.query).toContain('pickupPoint { type address { publicName streetAddress postcode city } }');
    expect(body.query).not.toMatch(/destination|pinCode|payments|userRole/);
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('error');
    expect(new Headers(request.headers).get('X-Posti-Token')).toMatch(/^Bearer fixture\./);
  });

  it.each(['http', 'graphql'])('refreshes an expired %s session once inside the same lookup', async (mode) => {
    const expired = () => mode === 'http' ? new Response('', { status: 401 })
      : Response.json({ errors: [{ errorType: 'Unauthorized' }] });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(tokens()).mockResolvedValueOnce(Response.json(fixture()));
    await expect(new PostiTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(tokens()).mockResolvedValueOnce(expired());
    await expect(new PostiTracker({ fetcher: failed }).fetch(NUMBER)).rejects.toThrow('session expired');
    expect(failed).toHaveBeenCalledTimes(4);
  });

  it('does not retry throttling, malformed sessions, or ordinary GraphQL failures', async () => {
    for (const response of [new Response('', { status: 429 }), Response.json({ errors: [{ message: 'Unavailable' }] })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(response);
      await expect(new PostiTracker({ fetcher }).fetch(NUMBER)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id_token: 'fixture', role_tokens: [{ type: 'account', token: 'fixture' }] }));
    await expect(new PostiTracker({ fetcher }).fetch(NUMBER)).rejects.toThrow('anonymous session');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation and shares the deadline with token bootstrap', async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      abort.abort();
      expect(init?.signal?.aborted).toBe(true);
      return tokens();
    });
    await expect(new PostiTracker({ fetcher }).fetch(NUMBER, { signal: abort.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>((resolve) => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted();
      return tokens();
    });
    await expect(new PostiTracker({ fetcher: slow, timeoutMs: 20 }).fetch(NUMBER)).rejects.toThrow();
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('normalizes safe identifiers and rejects invalid input before requesting a token', async () => {
    expect(normalizePostiTrackingNumber('cw 123.456-785 fr')).toBe(NUMBER);
    const fetcher = vi.fn<typeof fetch>();
    await expect(new PostiTracker({ fetcher }).fetch('TRACK&admin=1')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Posti recognition', () => {
  const makeAdapter = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null, env: {} });

  it('recognizes identity-bound public history through the ordinary anonymous flow', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(Response.json(fixture()));
    const signal = new AbortController().signal;
    await expect(makeAdapter(fetcher).recognize!(NUMBER, { signal, budgetMs: 1_000 }))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-01-12T13:00:00.000Z' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('keeps clean not-found, wrong identity, and query failure distinct', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens())
      .mockResolvedValueOnce(Response.json({ data: { consumerSearchShipments: { totalHits: 0, hits: [] } } }));
    await expect(makeAdapter(missing).recognize!(NUMBER)).resolves.toEqual({ known: false });
    const wrong = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(Response.json(fixture()));
    await expect(makeAdapter(wrong).recognize!('CW000000005FR')).rejects.toMatchObject({ kind: 'schema' });
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(tokens())
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'Resolver unavailable' }] }));
    await expect(makeAdapter(failed).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    const invalid = vi.fn<typeof fetch>();
    await expect(makeAdapter(invalid).recognize!('TRACK&admin=1')).resolves.toEqual({ known: false });
    expect(invalid).not.toHaveBeenCalled();
  });
});
