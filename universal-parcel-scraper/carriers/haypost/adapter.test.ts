import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HAYPOST_API, haypostLookupUrl, HaypostTracker } from './adapter.js';
import { normalizeHaypostNumber, parseHaypost } from './parser.js';
import { haypostEventStage, haypostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INBOUND = 'ZZ000000014NL';
const OUTBOUND = 'ZZ000000028AM';
const IN_TRANSIT = 'ZZ000000031CN';
const UNKNOWN = 'ZZ000000045AM';
type Row = Record<string, unknown>;
interface Reply { error: unknown; message: unknown; data?: { result: Row[] } & Row }
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const payload = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (reply: Reply, rows: Row[]) => void): Reply => {
  const reply = payload(name);
  change(reply, reply.data!.result);
  return reply;
};
const reply = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const NOTICE = 'The notification was sent to the customer: Addressee not available; Scheduled for further action/processing today';

describe('HayPost tracking adapter', () => {
  it('asks the tracker for the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HaypostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 nl ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HAYPOST_API}?trackingNumber=${INBOUND}&lng=en`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'haypost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad delivered in Armenia, with Yerevan instants for HayPost’s scans and wall clocks for the sending post’s', () => {
    const result = parseHaypost(payload('inbound-delivered'), INBOUND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item (Inb)', last_update: '2026-08-21T14:30:05+04:00', delivered_at: '2026-08-21T14:30:05+04:00',
      expected_delivery: null, destination_country: 'AM' });
    // Newest first, as the page lists them, and the repeated row is kept once.
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-08-21T14:30:05+04:00', 'GYUMRI 3, Armenia', 'Deliver item (Inb)', 'delivered'],
      ['2026-08-18T10:02:13+04:00', 'GYUMRI 3, Armenia', NOTICE, 'failed_attempt'],
      ['2026-08-18T09:55:40+04:00', 'GYUMRI 3, Armenia', 'Receive item at location (Inb)', 'in_transit'],
      ['2026-08-17T19:48:09+04:00', 'YEREVAN, Armenia', 'Send item to domestic location (Inb)', 'in_transit'],
      ['2026-08-17T15:12:47+04:00', 'YEREVAN, Armenia', 'Return item from customs (Inb)', 'in_transit'],
      ['2026-08-17T11:31:02+04:00', 'YEREVAN, Armenia', 'Send item to customs (Inb)', 'customs'],
      ['2026-08-17T11:20:31+04:00', 'YEREVAN, Armenia', 'Receive item at office of exchange (Inb)', 'in_transit'],
      ['2026-08-11T22:05:00', 'SAMPLE A IMPC, Netherlands', 'Send item abroad (EDI-received)', 'in_transit'],
      ['2026-08-10T07:15:00', 'SAMPLE A IMPC, Netherlands', 'Insert item into bag (Otb)', 'in_transit'],
    ]);
    expect(result.events!.slice(-2).every(event => event.time === undefined)).toBe(true);
    expect(result.events!.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/\(the\)|Measure/);
  });

  it('reads a HayPost item delivered abroad, keeping the foreign post’s wall clocks and naming the country it went to', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('outbound-delivered')))).track({ number: OUTBOUND });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Deliver item (Inb)', last_update: null,
      last_update_local: '2026-06-03T13:52:00', destination_country: 'FR' });
    // A wall clock abroad is not given a zone, so the delivery has no instant.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description])).toEqual([
      ['2026-06-03T13:52:00', 'SAMPLE PPDC, France', 'Deliver item (Inb)'],
      ['2026-06-03T04:35:00', 'SAMPLE PPDC, France', 'Receive item at delivery office (Inb)'],
      ['2026-06-01T01:51:00', 'SAMPLE CTI, France', 'Receive item at office of exchange (Inb)'],
      ['2026-05-21T07:04:58+04:00', 'YEREVAN, Armenia', 'Send item abroad (Otb)'],
      ['2026-05-19T11:37:25+04:00', 'YEREVAN, Armenia', 'Insert item into bag (Otb)'],
      ['2026-05-19T11:36:29+04:00', 'YEREVAN, Armenia', 'Receive item at office of exchange (Otb)'],
      ['2026-05-18T15:09:12+04:00', 'YEREVAN 10, Armenia', 'Receive item from customer (Otb)'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ stage: 'accepted', stage_source: 'carrier_map' });
  });

  it('reads mail from abroad held at customs as in transit to Armenia', () => {
    const result = parseHaypost(payload('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Send item to customs (Inb)',
      last_update: '2026-10-09T10:02:11+04:00', destination_country: 'AM' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-10-01T16:38:00', location: 'SAMPLE ISC, China',
      description: 'Receive item at office of exchange (Otb)', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads a missed delivery, unknown wordings and places, and keeps only the reason from a row’s extra information', () => {
    const missed = parseHaypost(edited('inbound-delivered', (_reply, rows) => { rows.pop(); }), INBOUND);
    expect(missed).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: NOTICE,
      last_update: '2026-08-18T10:02:13+04:00', destination_country: 'AM' });
    expect(missed).not.toHaveProperty('delivered_at');
    const reasonOnly = parseHaypost(edited('inbound-delivered', (_reply, rows) => {
      rows.pop();
      rows.at(-1)!.extraInformation = 'Reason : Refused';
    }), INBOUND);
    expect(reasonOnly.last_status_text).toBe('The notification was sent to the customer: Refused');
    // Any other detail can name the person who took the item: it is not part of the history.
    const detail = parseHaypost(edited('inbound-delivered', (_reply, rows) => {
      rows.at(-1)!.extraInformation = 'Received by Sample Person, 000000';
    }), INBOUND);
    expect(detail.last_status_text).toBe('Deliver item (Inb)');
    expect(JSON.stringify(detail)).not.toMatch(/Sample Person|000000/);
    const unnamed = parseHaypost(edited('in-transit', (_reply, rows) => { rows.at(-1)!.event = 'Sample event'; }), IN_TRANSIT);
    expect(unnamed).toMatchObject({ last_status_text: 'Sample event', current_stage: 'in_transit' });
    expect(unnamed.events![0]).not.toHaveProperty('stage');
    // An office's postcode is dropped; a country named twice is named once.
    const places = parseHaypost(edited('in-transit', (_reply, rows) => {
      rows.at(-1)!.location = 'YEREVAN 0000';
      rows.at(-2)!.location = 'ARMENIA';
    }), IN_TRANSIT);
    expect(places.events!.slice(0, 2).map(event => event.location)).toEqual(['YEREVAN, Armenia', 'Armenia']);
    // A scan in no country, or in one nobody can read, keeps its wall clock and settles no destination.
    const nowhere = parseHaypost(edited('in-transit', (_reply, rows) => {
      rows.at(-1)!.country = '';
      rows.at(-2)!.country = 'Sampleland';
    }), IN_TRANSIT);
    expect(nowhere.events!.slice(0, 2)).toMatchObject([{ local_time: '2026-10-09T10:02:11', location: 'YEREVAN' },
      { local_time: '2026-10-09T09:47:26', location: 'YEREVAN, Sampleland' }]);
    expect(nowhere).toMatchObject({ last_update: null, last_update_local: '2026-10-09T10:02:11' });
    expect(nowhere).not.toHaveProperty('destination_country');
    // An item that has not left its first country names no destination.
    expect(parseHaypost(edited('outbound-delivered', (_reply, rows) => { rows.splice(4); }), OUTBOUND)).not.toHaveProperty('destination_country');
  });

  it('reads the tracker’s answer for an unknown code as missing, and anything else short of a history as no answer', async () => {
    expect(() => parseHaypost(payload('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const changed of [
      edited('not-found', reply => { reply.message = 'Tracking number is required'; }),
      edited('not-found', reply => { reply.message = 'Sample server error'; }),
      edited('not-found', reply => { delete reply.data; }),
      edited('not-found', reply => { reply.data = null as never; }),
      // An error that comes with scans is not the answer for an unknown code.
      { ...payload('in-transit'), error: true, message: 'Not Valid Tracking Number Format' },
      edited('in-transit', (_reply, rows) => { rows.splice(0); }),
    ]) {
      expect(() => parseHaypost(changed, UNKNOWN), JSON.stringify(changed)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    // A route the server does not know is not a missing item.
    await expect(lookup('<!doctype html><title>Not Found</title>', 404, 'text/html')).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('outbound-delivered')}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('rejects changed replies', () => {
    const row = payload('in-transit').data!.result[0]!;
    const changed: unknown[] = [null, 'reply', [], {}, { error: 'false', data: payload('in-transit').data }, { error: false },
      { error: false, data: { result: {} } }, { error: false, data: { result: Array.from({ length: 501 }, () => row) } },
      edited('in-transit', (_reply, rows) => { rows[0] = 'row' as never; }),
      edited('in-transit', (_reply, rows) => { delete rows[0]!.event; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.event = '  '; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.event = ['Deliver item']; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.country = 51; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.location = { name: 'YEREVAN' }; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.extraInformation = 7; }),
      edited('in-transit', (_reply, rows) => { delete rows[0]!.eventDate; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.eventDate = '10/1/2026 16:38:00'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.eventDate = '2026-10-01T16:38'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.eventDate = '2026-10-01T16:38:00Z'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.eventDate = '2026-02-30T16:38:00'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.eventDate = '2026-10-01T24:38:00'; }),
      edited('in-transit', (_reply, rows) => { rows[0]!.eventDate = '0001-01-01T00:00:00'; })];
    for (const changedPayload of changed) {
      expect(() => parseHaypost(changedPayload, IN_TRANSIT), JSON.stringify(changedPayload)?.slice(0, 160))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ZZ000000015AM', 'ZZ00000001AM', 'ZZ000000014AMX', 'Z0000000014AM', 'PAS000000001AM', '1234567890123',
      'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHaypostNumber(' zz-000-000-028 am ')).toBe(OUTBOUND);
    expect(haypostLookupUrl(OUTBOUND)).toBe(`${HAYPOST_API}?trackingNumber=${OUTBOUND}&lng=en`);
    expect(() => parseHaypost(payload('not-found'), 'ZZ000000046AM')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('inbound-delivered'))).mockResolvedValueOnce(reply(text('not-found')))
      .mockResolvedValueOnce(reply(text('outbound-delivered')));
    await expect(carrier(fetcher).recognize!(INBOUND)).resolves.toEqual({ known: true, lastActivityAt: '2026-08-21T10:30:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(OUTBOUND)).resolves.toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too many requests',
      { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(INBOUND)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(INBOUND)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(text('inbound-delivered')));
    await expect(carrier(flaky).track({ number: INBOUND })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound-delivered')));
    await expect(carrier(immediate).track({ number: INBOUND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: INBOUND }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: INBOUND }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: INBOUND })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under HayPost to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('inbound-delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'haypost' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'haypost', source: 'haypost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === haypostLookupUrl(INBOUND))).toBe(true);
  });
});

describe('HayPost status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, with or without its leg or reason', () => {
    for (const entry of statuses.entries) {
      expect(haypostEventStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'haypost', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(haypostStage(' deliver  ITEM ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(haypostStage('Deliver item (Otb)')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(haypostStage('Send item to customs (EDI-received)')).toEqual({ stage: 'customs', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Sample event', '(Inb)', '']) expect(haypostEventStage(wording), wording).toBeUndefined();
    expect(haypostStage('')).toBeNull();
  });
});
