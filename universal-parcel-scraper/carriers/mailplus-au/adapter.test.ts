import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MAILPLUS_API, MailplusTracker, mailplusTrackUrl } from './adapter.js';
import { normalizeMailplusNumber, parseMailplus } from './parser.js';
import { mailplusMappedStage, mailplusStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const LODGED = 'MPX123456789';
const PARTNER = 'ZZZZ00000000FPP00000';
const COLLECTED = 'MPXL000001';
const UNKNOWN = 'MPX000000000';

type Row = Record<string, unknown>;
type Reply = Record<string, unknown> & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('MailPlus HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MailplusTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' mpx 123-456-789 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MAILPLUS_API}${LODGED}`);
    expect(mailplusTrackUrl(LODGED)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mailplus-au', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel lodged with Australia Post under its barcode, with offsets across the end of daylight saving', () => {
    const result = parseMailplus(fixture('delivered'), LODGED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Freight item has been delivered.',
      last_update: '2026-04-06T15:30:00+10:00', delivered_at: '2026-04-06T15:30:00+10:00',
      delivery_carrier: 'australia-post', delivery_tracking_number: PARTNER,
      events: [
        { time: '2026-04-06T15:30:00+10:00', location: 'SYNTHETIC BAY NSW, Australia', description: 'Freight item has been delivered.',
          provider_code: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-04-06T09:20:00+10:00', location: 'SYNTHETIC BAY NSW, Australia', description: 'Onboard for delivery',
          provider_code: 'Onboard for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-04-06T09:20:00+10:00', location: 'SYNTHETIC BAY NSW, Australia', description: 'Intransit',
          provider_code: 'Intransit', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-06T00:10:00+10:00', location: 'DEMO HUB NSW, Australia', description: 'Item processed at sorting facility',
          provider_code: 'Item processed at sorting facility', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-06T00:10:00+10:00', location: 'DEMO HUB NSW, Australia', description: 'Intransit',
          provider_code: 'Intransit', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-03T18:00:00+11:00', location: 'SAMPLEVILLE NSW, Australia', description: 'Picked up from Sender',
          provider_code: 'Picked up from Sender', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-04-03T18:00:00+11:00', location: 'SAMPLEVILLE NSW, Australia', description: 'Intransit',
          provider_code: 'Intransit', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-02T16:41:00+11:00', location: 'Australia', description: 'Initiated',
          provider_code: 'Initiated', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2026-04-02T16:41:00+11:00', location: 'Australia', description: 'Shipping information received by Australia Post',
          provider_code: 'Shipping information received by Australia Post', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2026-04-02T16:40:05.480+11:00', location: 'Exampleton, Australia', description: 'Parcel processing at depot',
          provider_code: 'lodged', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-02T10:15:30.120+11:00', location: 'Exampleton, Australia', description: 'Parcel picked up',
          provider_code: 'Picked up', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a parcel in transit with MailPlus’s estimate, and a partner’s pre-advice does not move it back', () => {
    const result = parseMailplus(fixture('in-transit'), COLLECTED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Depot Scan', last_update: '2026-05-06T16:50:00+10:00',
      expected_delivery: '2026-05-08', expected_delivery_from: '2026-05-07' });
    for (const field of ['delivered_at', 'delivery_carrier', 'delivery_tracking_number', 'history_truncated']) expect(result).not.toHaveProperty(field);
    expect(result.events!.at(-1)).toEqual({ time: '2026-05-04T13:40:00.250+10:00', description: 'Ready For Collection',
      provider_code: 'Ready For Collection', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events![1]).toEqual({ time: '2026-05-05T12:45:00+10:00', location: 'Australia', description: 'Freight Processed',
      provider_code: 'Pickup And In Transit', stage: 'in_transit', stage_source: 'carrier_map' });
    const advised = parseMailplus(changed('in-transit', (body) => { body.events = body.events.slice(0, 4); }), COLLECTED);
    expect(advised).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Electronic Billing Transfer' });
    expect(advised.events![0]).toMatchObject({ provider_code: 'Shipment Created', stage: 'registered' });
    // A booking alone is registered, and a day estimate alone is the expected day.
    const booked = parseMailplus(changed('in-transit', (body) => {
      body.events = body.events.slice(0, 1);
      body.estimated_delivery_date_maximum = null;
    }), COLLECTED);
    expect(booked).toMatchObject({ status: 'pending', current_stage: 'registered', expected_delivery: '2026-05-07' });
    expect(booked).not.toHaveProperty('expected_delivery_from');
  });

  it('stages unknown names by their note or name, and keeps an unread one without a stage', () => {
    const newest = (row: Row) => parseMailplus(changed('in-transit', (body) => { body.events.push({ datetime: '2026-05-07T09:00:00.000+10:00', ...row }); }), COLLECTED);
    expect(newest({ name: 'Synthetic Step', note: 'Your parcel has been returned to the sender.' }))
      .toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(newest({ name: 'Courier Please', note: 'Delivered' }).events![0]).toMatchObject({ provider_code: 'Courier Please', stage: 'delivered' });
    const unread = newest({ name: 'Synthetic Step', note: null, city: 'Sampleton', country: null });
    expect(unread.events![0]).toEqual({ time: '2026-05-07T09:00:00+10:00', location: 'Sampleton', description: 'Synthetic Step', provider_code: 'Synthetic Step' });
    expect(unread).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic Step' });
    // An undated row is one the page cannot place, and a repeated row counts once.
    const rows = parseMailplus(changed('in-transit', (body) => {
      body.events.push({ name: 'Delivered', datetime: null, note: null }, { ...body.events.at(-1)! });
    }), COLLECTED).events!;
    expect(rows).toHaveLength(6);
    expect(rows[0]!.provider_code).toBe('Pickup And In Transit');
  });

  it('marks the history cut while the tracker shows only collection and lodgement scans, or past its newest events', () => {
    expect(parseMailplus({ ...fixture('in-transit'), uptime: 'false' }, COLLECTED).history_truncated).toBe(true);
    expect(parseMailplus({ ...fixture('in-transit'), uptime: null }, COLLECTED)).not.toHaveProperty('history_truncated');
    const long = parseMailplus(changed('in-transit', (body) => {
      body.events = Array.from({ length: 101 }, (_, index) => ({ ...body.events[5]!,
        datetime: `2026-05-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00.000+10:00` }));
    }), COLLECTED);
    expect(long.events).toHaveLength(100);
    expect(long.history_truncated).toBe(true);
  });

  it('names a partner only for a parcel it follows under another barcode, from its own name or its pre-advice', () => {
    const named = (carrierName: unknown, number = LODGED, change: (body: Reply) => void = () => {}) =>
      parseMailplus(changed('delivered', (body) => { body.carrier = carrierName; change(body); }), number);
    expect(named('Australia Post')).toMatchObject({ delivery_carrier: 'australia-post', delivery_tracking_number: PARTNER });
    expect(named('Team Global Express')).toMatchObject({ delivery_carrier: 'team-global-express', delivery_tracking_number: PARTNER });
    // A name the catalog does not hold, or MailPlus's own, names nobody, whatever the scans say.
    for (const name of ['Synthetic Couriers', 'MailPlus']) {
      const result = named(name);
      expect(result, name).not.toHaveProperty('delivery_carrier');
      expect(result.delivery_tracking_number, name).toBe(PARTNER);
    }
    // Without a name or Australia Post's pre-advice, only the barcode is kept.
    const plain = named(undefined, LODGED, (body) => { body.events = body.events.filter((row) => !/Australia Post/.test(String(row.name))); });
    expect(plain).not.toHaveProperty('delivery_carrier');
    expect(plain.delivery_tracking_number).toBe(PARTNER);
    // Asked by the partner's barcode, the parcel is already under it.
    const direct = named('Australia Post', PARTNER);
    expect(direct).toMatchObject({ current_stage: 'delivered' });
    for (const field of ['delivery_carrier', 'delivery_tracking_number']) expect(direct).not.toHaveProperty(field);
  });

  it('counts a parcel only when the reply names the number asked, or answers a MailPlus number with a partner’s barcode', () => {
    // Another MailPlus number, and a partner's barcode asked that the reply does not repeat.
    expect(() => parseMailplus(fixture('in-transit'), 'MPXL123456')).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'MailPlus answered for another parcel' }));
    expect(() => parseMailplus({ ...fixture('delivered'), tracked_barcode: 'MPX000000000' }, LODGED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMailplus(fixture('delivered'), 'ZZZZ00000000FPP00001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMailplus(fixture('in-transit'), PARTNER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseMailplus({ ...fixture('in-transit'), tracked_barcode: 'mpxl000001' }, COLLECTED)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads a parcel without dated events as no history', () => {
    for (const events of [[], [{ name: 'Picked up', datetime: null, note: 'Parcel picked up' }]]) {
      expect(() => parseMailplus({ ...fixture('in-transit'), events }, COLLECTED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.tracked_barcode; },
      (body: Reply) => { body.tracked_barcode = 5; },
      (body: Reply) => { body.tracked_barcode = ''; },
      (body: Reply) => { body.events = 'events' as never; },
      (body: Reply) => { delete (body as Partial<Reply>).events; },
      (body: Reply) => { body.events = Array.from({ length: 501 }, () => body.events[0]!); },
      (body: Reply) => { body.events[0] = 'row' as never; },
      (body: Reply) => { body.events[0]!.name = ['Delivered']; },
      (body: Reply) => { body.events[0]!.name = ''; body.events[0]!.note = null; },
      (body: Reply) => { body.events[0]!.city = { name: 'Example' }; },
      (body: Reply) => { body.events[0]!.datetime = 1_775_000_000; },
      (body: Reply) => { body.events[0]!.datetime = '2026-05-04 13:40:00'; },
      (body: Reply) => { body.events[0]!.datetime = '2026-05-04T13:40:00.250'; },
      (body: Reply) => { body.events[0]!.datetime = '2026-02-30T13:40:00.000+10:00'; },
      (body: Reply) => { body.estimated_delivery_date_minimum = '7 May'; },
    ]) {
      expect(() => parseMailplus(changed('in-transit', change), COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseMailplus({ ...fixture('delivered'), carrier: { name: 'Australia Post' } }, LODGED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of ['reply', [], null]) {
      expect(() => parseMailplus(payload, COLLECTED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a layout the tracker refuses, a moved route, a browser check, a quota and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 409 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('invalid'), { status: 400 })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup({ errors: ['Synthetic failure'] }, { status: 409 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ errors: [] }, { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Page not found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://track.mailplus.com.au/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '120' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    await expect(lookup('', { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html><title>Mail Plus - Tracking</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('in-transit'), { status: 202 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ uptime: 'true' })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks a parcel the tracker can refresh once more, as the page does, and keeps the first answer when that fails', async () => {
    const first = { ...fixture('in-transit'), syncable: true };
    const fresher = changed('in-transit', (body) => {
      body.events.push({ name: 'Out For Delivery', datetime: '2026-05-07T08:00:00.000+10:00', city: 'Sampleton', country: 'Australia', note: 'On For Delivery' });
    });
    const refreshed = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply(fresher));
    await expect(carrier(refreshed).track({ number: COLLECTED })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(refreshed.mock.calls.map(([url]) => String(url))).toEqual([mailplusTrackUrl(COLLECTED), `${MAILPLUS_API}${COLLECTED}?syncable=true`]);
    expect(refreshed.mock.calls[1]![1]!.signal).toBeInstanceOf(AbortSignal);
    for (const failure of [reply('', { status: 502 }), reply(fixture('not-found'), { status: 409 }), reply('broken')]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(failure);
      await expect(carrier(fetcher).track({ number: COLLECTED })).resolves.toMatchObject({ current_stage: 'in_transit', last_status_text: 'Depot Scan' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    // Recognition only needs the first answer.
    const recognized = vi.fn<typeof fetch>().mockResolvedValue(reply(first));
    await expect(carrier(recognized).recognize!(COLLECTED)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-05-06T06:50:00.000Z' });
    expect(recognized).toHaveBeenCalledTimes(1);
  });

  it('recognizes a parcel it holds and an unknown or refused number as unknown', async () => {
    const recognize = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).recognize!(UNKNOWN);
    await expect(recognize(fixture('not-found'), { status: 409 })).resolves.toEqual({ known: false });
    await expect(recognize(fixture('invalid'), { status: 400 })).resolves.toEqual({ known: false });
    await expect(recognize('', { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('MPX%')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers MailPlus does not track and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345', 'MPXABCDEF', 'MPX12345%', '0'.repeat(41), '0'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: LODGED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMailplusNumber('mpxl 000-001')).toBe(COLLECTED);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('delivered')) }]);
    const answered = carrier(recovered.fetcher).track({ number: LODGED }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'delivered' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: LODGED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number filed under MailPlus to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === mailplusTrackUrl(COLLECTED)
      ? reply(fixture('in-transit')) : reply(fixture('not-found'), { status: 409 }));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: COLLECTED, carrier: 'mailplus-au' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'mailplus-au', source: 'mailplus-au', result: { current_stage: 'in_transit' } });
  });
});

describe('MailPlus numbers', () => {
  it('offers MailPlus for MPX and nine digits only; partners’ barcodes stay with their own rules', () => {
    expect(detectCarrierMatch(LODGED).candidates).toContain('mailplus-au');
    for (const number of [PARTNER, COLLECTED, 'MPX12345678']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('mailplus-au');
    }
  });
});

describe('MailPlus status vocabulary', () => {
  it('records every name the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(mailplusStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'mailplus-au', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('maps a name whatever its case, and leaves other names to the shared rules', () => {
    expect(mailplusMappedStage('READY FOR  collection')).toBe('registered');
    expect(mailplusMappedStage('Synthetic Step')).toBeUndefined();
    expect(mailplusMappedStage('constructor')).toBeUndefined();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'mailplus-au', providerCode: 'Synthetic Step', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(mailplusStage('Synthetic Step', '')).toBeNull();
  });
});
