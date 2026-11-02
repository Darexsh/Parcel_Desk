import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BULGARIAN_POSTS_API, BulgarianPostsTracker, bulgarianPostsLookupUrl } from './adapter.js';
import { normalizeBulgarianPostsNumber, parseBulgarianPosts } from './parser.js';
import { bulgarianPostsEventStage, bulgarianPostsStage, isBulgarianPostsNotice, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014DE';
const CUSTOMS = 'ZZ000000028CN';
const OUTBOUND = 'ZZ000000031BG';
const UNKNOWN = 'ZZ000000045BG';
const DOMESTIC = 'PS0000000000A';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Row = Record<string, unknown>;
type Reply = { parcels: Row[]; bulpost: Record<string, unknown> };
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const row = (date_reg: string, office_name: string, event_name: string, status_name: string | null = null): Row =>
  ({ date_reg, post_code: null, office_name, event_code: 0, event_name, status_code: 0, status_name, note: null });
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Bulgarian Posts tracking adapter', () => {
  it('asks the tracker for the whole code once, as its English page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BulgarianPostsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 de ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    // The reply does not name the item: the path holds the whole code.
    expect(String(url)).toBe(`${BULGARIAN_POSTS_API}${DELIVERED}?language=EN`);
    expect(bulgarianPostsLookupUrl(DOMESTIC)).toBe(`https://www.bgpost.bg/api/trace/parcel/${DOMESTIC}?language=EN`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bulgarian-posts', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads mail from abroad newest first, dating Bulgarian scans in Sofia and keeping the sending post’s wall clocks', () => {
    const result = parseBulgarianPosts(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item (Inb)', last_update: '2026-10-28T17:39:00+02:00', expected_delivery: null,
      delivered_at: '2026-10-28T17:39:00+02:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-10-28T17:39:00+02:00', 'Bulgaria', 'Deliver item (Inb)', 'delivered'],
      ['2026-10-26T11:05:00+02:00', 'Bulgaria', 'Receive item at collection point for pick-up (Inb)', 'ready_for_pickup'],
      ['2026-10-23T08:15:00+03:00', 'ПРИМЕРНО Митническо оформяне, Bulgaria', 'Send item to domestic location (Inb)', 'in_transit'],
      ['2026-10-22T16:20:00+03:00', 'Sklad in SAMPLE, Bulgaria', 'Return item from customs (Inb)', 'in_transit'],
      ['2026-10-21T11:47:00+03:00', 'Sklad in SAMPLE, Bulgaria',
        'Record item customs information (Inb): Awaiting presentation to customs commissioner', 'customs'],
      ['2026-10-20T14:02:00+03:00', 'SAMPLE LC/AO, Bulgaria', 'Send item to customs (Inb)', 'customs'],
      ['2026-10-20T10:31:00+03:00', 'SAMPLE LC/AO, Bulgaria', 'Receive item at office of exchange (Inb)', 'in_transit'],
      ['2026-10-17T18:05:00', 'SAMPLE/FLUGHAFEN, Germany', 'Send item abroad (EDI-received)', 'in_transit'],
      ['2026-10-16T22:40:00', 'SAMPLE/FLUGHAFEN, Germany', 'Insert item into bag (Otb) and Send item abroad', 'in_transit'],
      ['2026-10-14T09:12:00', 'SAMPLE-IPZ, Germany', 'Receive item from customer (Otb)', 'accepted'],
    ]);
    // Foreign scans keep their wall clock only; Bulgarian ones get Sofia's offset only.
    expect(result.events!.slice(0, 7).every(event => event.time && !event.local_time)).toBe(true);
    expect(result.events!.slice(7).every(event => event.local_time && !event.time)).toBe(true);
    expect(result.events!.every(event => event.stage_source === 'carrier_map')).toBe(true);
    // The office's postcode is dropped.
    expect(JSON.stringify(result)).not.toMatch(/9999|PS \d/);
  });

  it('reads mail held at customs with the status customs recorded, and the later of two scans at one clock first', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('customs')));
    await expect(carrier(fetcher).track({ number: CUSTOMS })).resolves.toMatchObject({ status: 'in_transit', current_stage: 'customs',
      last_status_text: 'Record item customs information (Inb): Awaiting presentation to customs commissioner',
      last_update: '2026-06-11T15:02:00+03:00',
      events: [{ location: 'SAMPLE CP, Bulgaria' }, { description: 'Send item to customs (Inb)' }, {}, { location: 'SAMPLE CITY, China' }, {}, {}] });
  });

  it('reads an item posted in Bulgaria up to the office of exchange as in transit', () => {
    expect(parseBulgarianPosts(fixture('outbound'), OUTBOUND)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Receive item at office of exchange (Otb)', last_update: '2026-07-15T01:00:00+03:00',
      events: [{ location: 'SAMPLE LC/AO, Bulgaria' }, { time: '2026-07-14T13:04:00+03:00', location: 'Bulgaria', stage: 'accepted' }] });
  });

  it('reads the domestic scans, in Bulgarian, with the office’s town and without its postcode', () => {
    const result = parseBulgarianPosts(fixture('domestic'), DOMESTIC);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'За получаване в ПС',
      last_update: '2026-03-04T09:02:00+02:00' });
    expect(result.events!.map(event => [event.time, event.location, event.stage])).toEqual([
      ['2026-03-04T09:02:00+02:00', 'ОБРАЗЕЦ 7, Bulgaria', 'ready_for_pickup'],
      ['2026-03-03T13:25:00+02:00', 'ОБРАЗЕЦ 7, Bulgaria', 'in_transit'],
      ['2026-03-03T06:40:00+02:00', 'ПРИМЕРНО-МО, Bulgaria', 'in_transit'],
      ['2026-03-02T10:14:00+02:00', 'ПРИМЕРНО, Bulgaria', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/999\d/);
  });

  it('dates a repeated autumn hour by its first occurrence and keeps a skipped spring hour as a wall clock', () => {
    const scans = (rows: Row[]) => parseBulgarianPosts({ parcels: rows, bulpost: { is_bulpost: false, html: null } }, DOMESTIC).events!;
    expect(scans([row('2026-10-25T03:30:00', 'БЪЛГАРИЯ, 9999  ПРИМЕРНО', 'Приемане')])[0]).toMatchObject({ time: '2026-10-25T03:30:00+03:00' });
    const skipped = scans([row('2026-03-29T03:30:00', 'БЪЛГАРИЯ, 9999  ПРИМЕРНО', 'Приемане')])[0]!;
    expect(skipped).toMatchObject({ local_time: '2026-03-29T03:30:00' });
    expect(skipped.time).toBeUndefined();
  });

  it('takes a blank country for Bulgaria only beside a Bulgarian post office, and drops a foreign office’s postcode', () => {
    const scans = parseBulgarianPosts({ parcels: [
      row('2026-05-01T08:00:00', 'CANADA, A1B2C3', 'Receive item from customer (Otb)'),
      row('2026-05-02T08:00:00', ', SAMPLE OFFICE', 'Insert item into bag (Otb) and Send item abroad '),
      row('2026-05-03T08:00:00', 'SAMPLE HUB', 'Send item abroad (EDI-received)'),
      row('2026-05-04T08:00:00', 'Bulgaria, PS 9999', 'Receive item at office of exchange (Inb)'),
      row('2026-05-05T08:00:00', '', 'Receive item at location (Inb)'),
      row('2026-05-06T08:00:00', ', PS 9999', 'Unsuccessful item delivery attempt (Inb)'),
    ], bulpost: { is_bulpost: false, html: null } }, DELIVERED).events!;
    expect(scans.map(event => [event.time ?? event.local_time, event.location ?? null])).toEqual([
      ['2026-05-06T08:00:00+03:00', 'Bulgaria'],
      ['2026-05-05T08:00:00', null],
      ['2026-05-04T08:00:00+03:00', 'Bulgaria'],
      ['2026-05-03T08:00:00', 'SAMPLE HUB'],
      ['2026-05-02T08:00:00', 'SAMPLE OFFICE'],
      ['2026-05-01T08:00:00', 'Canada'],
    ]);
    expect(scans[0]).toMatchObject({ stage: 'failed_attempt' });
  });

  it('keeps a newest-first reply as it is, a repeated scan once and the newest stage under an unknown wording', () => {
    const reversed = parseBulgarianPosts(edited('delivered', payload => { payload.parcels.reverse(); }), DELIVERED);
    expect(reversed.events).toEqual(parseBulgarianPosts(fixture('delivered'), DELIVERED).events);
    const repeated = parseBulgarianPosts(edited('delivered', payload => { payload.parcels.splice(1, 0, { ...payload.parcels[1]! }); }), DELIVERED);
    expect(repeated.events).toHaveLength(10);
    const unknown = parseBulgarianPosts(edited('outbound', payload => {
      payload.parcels.push(row('2026-07-16T09:00:00', 'BULGARIA, SAMPLE LC/AO', 'Sample event (Otb)'));
    }), OUTBOUND);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sample event (Otb)',
      last_update: '2026-07-16T09:00:00+03:00' });
    expect(unknown.events![0]).toEqual({ time: '2026-07-16T09:00:00+03:00', location: 'SAMPLE LC/AO, Bulgaria', description: 'Sample event (Otb)' });
    const alone = parseBulgarianPosts({ parcels: [row('2026-07-16T09:00:00', 'GERMANY, SAMPLE', 'Sample event')], bulpost: {} }, DELIVERED);
    expect(alone).toMatchObject({ status: 'unknown', last_status_text: 'Sample event', last_update: null, last_update_local: '2026-07-16T09:00:00' });
    expect(alone.current_stage).toBeUndefined();
    // A delivery the tracker dates abroad has no instant to give.
    const abroad = parseBulgarianPosts({ parcels: [row('2026-07-16T09:00:00', 'GERMANY, SAMPLE', 'Deliver item (Inb)')] }, DELIVERED);
    expect(abroad).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-07-16T09:00:00' });
    expect(abroad).not.toHaveProperty('delivered_at');
  });

  it('keeps the stage of the scan before the record Bulgarian Posts creates, which never decides the parcel’s', () => {
    const created = parseBulgarianPosts({ parcels: [
      row('2026-05-01T08:00:00', 'BULGARIA, SAMPLE IE', 'Receive item at office of exchange (Inb)'),
      row('2026-05-01T08:01:00', 'BULGARIA, SAMPLE IE', 'Създаване'),
    ], bulpost: {} }, DELIVERED);
    expect(created).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Създаване' });
    expect(created.events![0]).toMatchObject({ description: 'Създаване', stage: 'in_transit', stage_source: 'none' });
    const first = parseBulgarianPosts({ parcels: [row('2026-05-01T08:01:00', 'BULGARIA, SAMPLE IE', 'Създаване')], bulpost: {} }, DELIVERED);
    expect(first.events![0]).not.toHaveProperty('stage');
    expect(first.current_stage).toBeUndefined();
  });

  it('reads the tracker’s empty list as missing, its wrong-code answer as invalid input and Bulpost’s items as inconclusive', async () => {
    expect(() => parseBulgarianPosts(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBulgarianPosts(fixture('wrong-code'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseBulgarianPosts(edited('delivered', payload => { payload.bulpost.is_bulpost = true; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('wrong-code'))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('outbound')}`)).resolves.toMatchObject({ status: 'in_transit' });
  });

  it('rejects changed replies', () => {
    for (const payload of [[], null, {}, { parcels: {} }, { parcels: null },
      edited('delivered', reply => { (reply.parcels as unknown[])[1] = 'scan'; }),
      edited('delivered', reply => { reply.parcels[1]!.event_name = ' '; }),
      edited('delivered', reply => { reply.parcels[1]!.event_name = null; }),
      edited('delivered', reply => { reply.parcels[1]!.event_name = ['Deliver item (Inb)']; }),
      edited('delivered', reply => { reply.parcels[1]!.date_reg = '16.10.2026 22:40'; }),
      edited('delivered', reply => { reply.parcels[1]!.date_reg = '2026-02-30T22:40:00'; }),
      edited('delivered', reply => { reply.parcels[1]!.date_reg = '2026-10-16T24:00:00'; }),
      edited('delivered', reply => { reply.parcels[1]!.date_reg = '2026-10-16T22:40:00+02:00'; }),
      edited('delivered', reply => { reply.parcels[1]!.date_reg = '1999-10-16T22:40:00'; }),
      edited('delivered', reply => { reply.parcels[1]!.date_reg = null; }),
      edited('delivered', reply => { reply.parcels[1]!.office_name = 7; }),
      edited('delivered', reply => { reply.parcels[1]!.status_name = { text: 'Sample' }; }),
      edited('wrong-code', reply => { reply.parcels.push(fixture('outbound').parcels[0]!); }),
      edited('delivered', reply => { reply.parcels = Array.from({ length: 501 }, () => reply.parcels[0]!); })]) {
      expect(() => parseBulgarianPosts(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseBulgarianPosts(edited('delivered', reply => { reply.parcels[1]!.date_reg = '2026-10-16T22:40:00.123'; }), DELIVERED)
      .events![8]).toMatchObject({ local_time: '2026-10-16T22:40:00' });
  });

  it('takes S10 codes with a valid check digit, from any post, and thirteen-character PS numbers, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015BG', 'ZZ00000001BG', 'ZZ000000014BGX', 'PS000000000A', 'PS0000000000AB', 'PS000000000-A?',
      '1234567890123', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBulgarianPostsNumber(' zz-000-000-028 cn ')).toBe(CUSTOMS);
    expect(normalizeBulgarianPostsNumber('ps 0000 0000 00a')).toBe(DOMESTIC);
    expect(() => parseBulgarianPosts(fixture('delivered'), 'ZZ000000015DE')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-28T15:39:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"message":"Too Many Requests"}',
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Bulgarian Posts to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'bulgarian-posts' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'bulgarian-posts', source: 'bulgarian-posts', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === bulgarianPostsLookupUrl(DELIVERED))).toBe(true);
  });

  it('owns PS numbers, leaves S10 codes with the postal fallback and reads both page addresses', () => {
    expect(detectCarrierMatch(DOMESTIC)).toMatchObject({ carrier: 'bulgarian-posts', confidence: 'high' });
    expect(detectCarrierMatch(OUTBOUND)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DOMESTIC)).toEqual([]);
    for (const link of [`https://www.bgpost.bg/postal-services/track-package?itemid=${OUTBOUND}`,
      `https://bgpost.bg/en/postal-services/track-package/?itemid=${OUTBOUND}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: OUTBOUND, carrier: 'bulgarian-posts', source: 'link' });
    }
  });
});

describe('Bulgarian Posts status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, with or without the detail beside it', () => {
    for (const entry of statuses.entries) {
      if (!('stage' in entry)) {
        expect(isBulgarianPostsNotice(entry.wording), entry.wording).toBe(true);
        expect(statusMapAnswer({ carrier: 'bulgarian-posts', providerCode: null, description: entry.wording }).kind, entry.wording).toBe('intentional_gap');
        continue;
      }
      expect(bulgarianPostsEventStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'bulgarian-posts', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(statusMapAnswer({ carrier: 'bulgarian-posts', providerCode: null, description: `${entry.wording}: Sample detail` }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(bulgarianPostsStage(' deliver item  (inb) ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Deliver item soon', 'Sample event (Inb)']) {
      expect(bulgarianPostsEventStage(wording), wording).toBeUndefined();
    }
    expect(bulgarianPostsStage('')).toBeNull();
  });
});
