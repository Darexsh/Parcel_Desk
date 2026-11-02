import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PHLPOST_API, PhlpostTracker } from './adapter.js';
import { normalizePhlpostNumber, parsePhlpost, phlpostWording } from './parser.js';
import { phlpostEventStage, phlpostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INBOUND = 'ZZ000000014JP';
const OUTBOUND = 'ZZ000000028PH';
const IN_TRANSIT = 'ZZ000000031CN';
const UNKNOWN = 'ZZ000000045PH';
type Row = Record<string, unknown>;
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const rows = (name: string): Row[] => JSON.parse(text(name)) as Row[];
const edited = (name: string, change: (payload: Row[]) => void): Row[] => {
  const payload = rows(name);
  change(payload);
  return payload;
};
const domestic = (event: string, clock: string, code = '8'): Row => ({ TrackingNo: OUTBOUND, EventDate: '/Date(1780000000000)/', Event: event,
  Status: null, Location: null, StatusDateStrings: clock, StatusCode: code });
const reply = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('PHLPost tracking adapter', () => {
  it('asks the tracker for the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PhlpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 jp ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PHLPOST_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify({ TrackingNumber: INBOUND }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json;charset=utf-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'phlpost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad delivered in the Philippines, with Manila instants for PHLPost’s scans and wall clocks for the sending post’s', () => {
    const result = parsePhlpost(rows('inbound-delivered'), INBOUND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Item delivered',
      last_update: '2026-09-15T11:00:00+08:00', delivered_at: '2026-09-15T11:00:00+08:00', expected_delivery: null, destination_country: 'PH' });
    // The domestic rows take their place among the IPS rows by clock, and the repeated IPS row is kept once.
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-09-15T11:00:00+08:00', undefined, 'Item delivered', '37', 'delivered'],
      ['2026-09-15T09:02:00+08:00', undefined, 'Item out for delivery', '39', 'out_for_delivery'],
      ['2026-09-15T08:55:00+08:00', undefined, 'Item arrived at delivery office', '30', 'in_transit'],
      ['2026-09-14T08:12:18+08:00', 'PHILIPPINES', 'Receive item at delivery office', '32', 'in_transit'],
      ['2026-09-13T10:43:00+08:00', undefined, 'Item sent to delivery office', '8', 'in_transit'],
      ['2026-09-12T10:25:47+08:00', 'PHILIPPINES', 'Enroute to delivery office', '35', 'in_transit'],
      ['2026-09-12T09:03:02+08:00', 'PHILIPPINES', 'Returned from Customs', '38', 'in_transit'],
      ['2026-09-10T16:21:40+08:00', 'PHILIPPINES', 'Send item to customs', '31', 'customs'],
      ['2026-09-10T15:03:39+08:00', 'PHILIPPINES', 'Receive at country of destination', '30', 'in_transit'],
      ['2026-09-08T09:30:00', 'Japan', 'Dispatch to country of destination', '12', 'in_transit'],
      ['2026-09-08T06:20:00', 'Japan', 'Dispatch item to destination country', '8', 'in_transit'],
      ['2026-09-08T06:19:00', 'Japan', 'Receive item at origin country gateway', '3', 'in_transit'],
      ['2026-09-06T09:14:00', 'Japan', 'Posting of item', '1', 'accepted'],
    ]);
    expect(result.events!.slice(-4).every(event => event.time === undefined)).toBe(true);
    expect(result.events!.every(event => event.stage_source === 'carrier_map')).toBe(true);
    // Whoever received the item is not part of its history.
    expect(JSON.stringify(result)).not.toMatch(/Sample Person|Relative|Received by/i);
  });

  it('reads a PHLPost item delivered abroad, keeping the foreign post’s wall clocks and naming the country it went to', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('outbound-delivered')))).track({ number: OUTBOUND });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Item delivered', last_update: null,
      last_update_local: '2026-06-03T13:52:00', destination_country: 'US' });
    // A wall clock in the United States does not settle one of its zones, so the delivery has no instant.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description])).toEqual([
      ['2026-06-03T13:52:00', 'United States of America', 'Item delivered'],
      ['2026-06-03T04:35:00', 'United States of America', 'Receive item at delivery office'],
      ['2026-06-01T12:23:00', 'United States of America', 'Returned from Customs'],
      ['2026-06-01T01:51:00', 'United States of America', 'Receive at country of destination'],
      ['2026-06-01T01:51:00', 'United States of America', 'Send item to customs'],
      ['2026-05-21T07:04:58+08:00', 'PHILIPPINES', 'Dispatch item to destination country'],
      ['2026-05-21T07:04:42+08:00', 'PHILIPPINES', 'Receive item at origin country gateway'],
      ['2026-05-19T11:37:25+08:00', 'PHILIPPINES', 'Enroute to next office'],
      ['2026-05-19T11:36:29+08:00', 'PHILIPPINES', 'Posting of item'],
      ['2026-05-18T15:09:00+08:00', undefined, 'Item posted at acceptance Post Office'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|RECEIVED BY|\(the\)/);
  });

  it('reads mail from abroad held at customs as in transit to the Philippines', () => {
    const result = parsePhlpost(rows('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Send item to customs',
      last_update: '2026-10-09T10:02:11+08:00', destination_country: 'PH' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-10-01T16:38:00', location: 'China', description: 'Posting of item', provider_code: '1',
      stage: 'accepted', stage_source: 'carrier_map' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads failed deliveries, customs data alone, unknown wordings and countries IPS names past its column', () => {
    const failed = parsePhlpost([domestic('Unsuccessful delivery - REASON: No one to receive', 'Jun 9 2026  2:15PM', '36'),
      ...rows('outbound-delivered').slice(0, 1)], OUTBOUND);
    expect(failed).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_update: '2026-06-09T14:15:00+08:00',
      destination_country: 'PH' });
    const ips = parsePhlpost(edited('in-transit', payload => {
      payload[0]!.Event = 'Unsuccessful delivery (REASON: Addressee not available) ';
    }), IN_TRANSIT);
    expect(ips).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Unsuccessful delivery (REASON: Addressee not available)' });
    const data = parsePhlpost([{ ...rows('in-transit')[5]!, TrackingNo: OUTBOUND, Event: ' Data Import for CN documents ', Location: 'PHILIPPINES',
      StatusCode: '3' }], OUTBOUND);
    expect(data).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: '2026-10-01T16:38:00+08:00' });
    expect(data).not.toHaveProperty('destination_country');
    const unnamed = parsePhlpost(edited('in-transit', payload => { payload[0]!.Event = 'Sample event'; }), IN_TRANSIT);
    expect(unnamed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Sample event' });
    expect(unnamed.events![0]).not.toHaveProperty('stage');
    // IPS cuts country names at 50 characters; a name nobody can read stays a wall clock in no country.
    const cut = parsePhlpost(edited('outbound-delivered', payload => {
      for (const row of payload) if (row.Location === 'United States of America (the)') row.Location = 'United Kingdom of Great Britain and Northern Irela';
    }), OUTBOUND);
    expect(cut.events![0]).toMatchObject({ local_time: '2026-06-03T13:52:00', location: 'United Kingdom of Great Britain and Northern Irela' });
    expect(cut).not.toHaveProperty('destination_country');
    // Accepting an item at a post office says nothing about where it goes.
    expect(parsePhlpost(rows('outbound-delivered').slice(0, 1), OUTBOUND)).not.toHaveProperty('destination_country');
    expect(parsePhlpost([domestic('Item sent to delivery office', 'Jun 9 2026 10:43AM')], OUTBOUND)).toMatchObject({ destination_country: 'PH' });
  });

  it('keeps a delivery and drops whoever received it and phone numbers from wordings', () => {
    expect(phlpostWording('Item delivered - Received by Sample Person (Relative)')).toBe('Item delivered');
    expect(phlpostWording(' Item delivered (RECEIVED BY SAMPLE PERSON)')).toBe('Item delivered');
    expect(phlpostWording('Item delivered')).toBe('Item delivered');
    expect(phlpostWording('Unsuccessful delivery - REASON: Call 0900 000 0000 first')).toBe('Unsuccessful delivery - REASON: Call first');
  });

  it('reads the tracker’s not-found row as missing, and anything else short of a history as no answer', async () => {
    expect(() => parsePhlpost(rows('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePhlpost([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePhlpost([...rows('not-found'), { ...rows('outbound-delivered')[0]!, TrackingNo: UNKNOWN }], UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // A "Not Found" wording with a clock is a scan, not the tracker's answer for an unknown code.
    expect(() => parsePhlpost([{ ...rows('not-found')[0]!, StatusDateStrings: 'Jun 9 2026  2:15PM' }], UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('[]')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    // A route the server does not know is not a missing item.
    await expect(lookup('<!doctype html><title>Not Found</title>', 404, 'text/html')).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('outbound-delivered').replaceAll(OUTBOUND, UNKNOWN)}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('binds every row to the whole requested code and rejects changed replies', () => {
    expect(() => parsePhlpost(rows('outbound-delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PHLPost answered for another item' }));
    // Rows without a code are other people's items.
    expect(() => parsePhlpost(edited('outbound-delivered', payload => { payload[3]!.TrackingNo = ''; }), OUTBOUND))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePhlpost(edited('not-found', payload => { payload[0]!.TrackingNo = 'ZZ000000045P'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePhlpost(edited('outbound-delivered', payload => { payload[0]!.TrackingNo = ` ${OUTBOUND.toLowerCase()} `; }), OUTBOUND).events)
      .toHaveLength(10);
    const changed: unknown[] = [null, 'reply', {}, { d: rows('outbound-delivered') }, ['row'],
      Array.from({ length: 501 }, () => rows('outbound-delivered')[0]),
      edited('outbound-delivered', payload => { delete payload[0]!.TrackingNo; }),
      edited('outbound-delivered', payload => { payload[0]!.TrackingNo = 7; }),
      edited('outbound-delivered', payload => { delete payload[0]!.StatusCode; }),
      edited('outbound-delivered', payload => { payload[0]!.StatusCode = 'A1'; }),
      edited('outbound-delivered', payload => { payload[0]!.StatusCode = { code: 1 }; }),
      edited('outbound-delivered', payload => { payload[0]!.Event = '  '; }),
      edited('outbound-delivered', payload => { payload[0]!.Event = ['Item posted']; }),
      edited('outbound-delivered', payload => { payload[0]!.Location = { name: 'Philippines' }; }),
      edited('outbound-delivered', payload => { payload[0]!.StatusDateStrings = null; }),
      edited('outbound-delivered', payload => { payload[0]!.StatusDateStrings = '2026-05-18T15:09:00'; }),
      edited('outbound-delivered', payload => { payload[0]!.StatusDateStrings = 'Mai 18 2026  3:09PM'; }),
      edited('outbound-delivered', payload => { payload[0]!.StatusDateStrings = 'Feb 30 2026  3:09PM'; }),
      edited('outbound-delivered', payload => { payload[0]!.StatusDateStrings = 'May 18 2026 13:09PM'; }),
      edited('outbound-delivered', payload => { payload[1]!.StatusDateStrings = '31/06/2026 1:52:00 pm'; }),
      edited('outbound-delivered', payload => { payload[1]!.StatusDateStrings = '03/06/2026 0:52:00 pm'; }),
      edited('outbound-delivered', payload => { payload[1]!.StatusDateStrings = '03/06/1970 1:52:00 pm'; }),
      edited('outbound-delivered', payload => { payload[1]!.StatusDateStrings = '03/06/2026 13:52'; })];
    for (const payload of changed) {
      expect(() => parsePhlpost(payload, OUTBOUND), JSON.stringify(payload)?.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ZZ000000015PH', 'ZZ00000001PH', 'ZZ000000014PHX', 'Z0000000014PH', '1234567890123', 'SAMPLETRACKING',
      `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePhlpostNumber(' zz-000-000-028 ph ')).toBe(OUTBOUND);
    expect(() => parsePhlpost(rows('not-found'), 'ZZ000000046PH')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('inbound-delivered'))).mockResolvedValueOnce(reply(text('not-found')))
      .mockResolvedValueOnce(reply(text('outbound-delivered')));
    await expect(carrier(fetcher).recognize!(INBOUND)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-15T03:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(OUTBOUND)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-20T23:04:58.000Z' });
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

  it('routes an item filed under PHLPost to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('inbound-delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'phlpost' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'phlpost', source: 'phlpost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === PHLPOST_API)).toBe(true);
  });

  it('reads the number from a saved lookup on the tracker', () => {
    expect(parseTrackingInput(`https://tracking.phlpost.gov.ph/?TrackingNos=${OUTBOUND}`))
      .toMatchObject({ trackingNumber: OUTBOUND, carrier: 'phlpost', source: 'link' });
  });
});

describe('PHLPost status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, whatever the code', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      const label = `${code ?? ''} ${entry.wording}`;
      expect(phlpostEventStage(entry.wording), label).toBe(entry.stage);
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'phlpost', providerCode: code, description: entry.wording }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Both systems number their events, and the numbers collide: the wording decides.
    expect(statusMap.stage('3', normalizeStatusWording('Data Import for CN documents'))).toBe('registered');
    expect(statusMap.stage('3', normalizeStatusWording('Receive item at origin country gateway'))).toBe('in_transit');
    expect(phlpostStage(' item  DELIVERED ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Sample event', '']) expect(phlpostEventStage(wording), wording).toBeUndefined();
    expect(phlpostStage('')).toBeNull();
  });
});
