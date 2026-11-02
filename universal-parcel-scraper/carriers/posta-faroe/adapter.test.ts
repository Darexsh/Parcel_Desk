import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTA_FAROE_API, PostaFaroeTracker } from './adapter.js';
import { isPostaFaroeHomeScan, normalizePostaFaroeNumber, parsePostaFaroe } from './parser.js';
import { postaFaroeMappedStage, postaFaroeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const INBOUND = 'CY123456799NL';
const HOME = 'RR000000005FO';
const UNKNOWN = 'RR123456785FO';
const MAIL = '00000000000000000000';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Row = Record<string, unknown>;
const fixture = (name: string): Row[] => JSON.parse(text(name)) as Row[];
const edited = (name: string, change: (rows: Row[]) => void): Row[] => {
  const rows = fixture(name);
  change(rows);
  return rows;
};
const lookupUrl = (number: string) => `${POSTA_FAROE_API}?trackTraceCode=${number}&languageCode=en`;
const reply = (body: string | null, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BLOCKED = '<html><head><title>Web Page Blocked</title></head><body>The page cannot be displayed. FortiWeb</body></html>';

describe('Posta tracking adapter', () => {
  it('asks the tracker for the whole number once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostaFaroeTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cy 123 456 799 nl ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lookupUrl(INBOUND));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posta-faroe', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel from abroad newest first, with Posta’s scans dated in the Faroe Islands and the others’ as wall clocks', () => {
    const result = parsePostaFaroe(fixture('delivered'), INBOUND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Sample delivery', last_update: '2026-01-15T13:05:00+00:00', expected_delivery: null,
      delivered_at: '2026-01-15T13:05:00+00:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-01-15T13:05:00+00:00', 'Dømisbygd - Útbering', '3', 'delivered'],
      ['2026-01-15T08:10:00+00:00', 'Dømisbygd - Útbering', '81', 'in_transit'],
      ['2026-01-14T15:00:00+00:00', 'Dømisstaður', '84', 'in_transit'],
      ['2026-01-14T09:20:00+00:00', 'Dømisstaður', '57', 'in_transit'],
      ['2026-01-13T11:18:00+00:00', 'Dømisstaður', '100', 'customs'],
      ['2026-01-12T14:39:00+00:00', 'Dømisstaður', '108', 'customs'],
      ['2026-01-12T08:26:00+00:00', 'Dømisstaður', '53', 'customs'],
      ['2026-01-12T08:25:00+00:00', 'Dømisstaður', '52', 'in_transit'],
      ['2026-01-10T04:59:00', 'DK - SAMPLE HUB', '44', 'in_transit'],
      ['2026-01-10T04:59:00', 'DK - SAMPLE HUB', '37', 'accepted'],
      ['2026-01-08T11:07:00', 'NL - EXAMPLE CITY B', '44', 'in_transit'],
      ['2026-01-07T18:50:00', 'NL - EXAMPLE CITY', '37', 'accepted'],
    ]);
    expect(result.events!.slice(8).every(event => event.time === undefined)).toBe(true);
    expect(result.events![0]).toEqual({ time: '2026-01-15T13:05:00+00:00', location: 'Dømisbygd - Útbering', description: 'Sample delivery',
      provider_code: '3', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('dates a summer scan an hour ahead of UTC, keeps a scan without a place as a wall clock and a repeated scan once', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')))).track({ number: HOME });
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Sent til næsta útberingarstað', last_update: null, last_update_local: '2026-07-02T16:30:00', expected_delivery: null, events: [
        { local_time: '2026-07-02T16:30:00', description: 'Sent til næsta útberingarstað', provider_code: '84', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { time: '2026-07-02T09:15:00+01:00', location: 'Dømisstaður', description: 'Gjørt klárt at senda', provider_code: '44',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-07-01T14:02:00+01:00', location: 'Dømisbygd', description: 'Móttikið frá kunda', provider_code: '37',
          stage: 'accepted', stage_source: 'carrier_map' },
      ] });
  });

  it('keeps an explicit offset, reads an oldest-first reply the same way and leaves a scan of unknown meaning unstaged', () => {
    const offset = parsePostaFaroe(edited('in-transit', rows => { rows[0]!.eventDateTime = '2026-07-02T16:30:00.5+02:00'; }), HOME);
    expect(offset).toMatchObject({ last_update: '2026-07-02T16:30:00+02:00' });
    expect(offset.events![0]).not.toHaveProperty('local_time');
    const reversed = parsePostaFaroe(edited('delivered', rows => rows.reverse()), INBOUND);
    expect(reversed.events).toEqual(parsePostaFaroe(fixture('delivered'), INBOUND).events);
    const unknown = parsePostaFaroe(edited('delivered', rows => { rows.unshift({ ...rows[0]!, eventTypeId: 999, eventDescription: 'Sample notice',
      eventDateTime: '2026-01-16 09:00', locationName: 'FO - Dømisbygd' }); }), INBOUND);
    expect(unknown.events![0]).toEqual({ time: '2026-01-16T09:00:00+00:00', location: 'FO - Dømisbygd', description: 'Sample notice', provider_code: '999' });
    expect(unknown).toMatchObject({ current_stage: 'delivered', last_status_text: 'Sample notice', last_update: '2026-01-16T09:00:00+00:00' });
    const cancelled = parsePostaFaroe([{ ...fixture('in-transit')[0]!, eventTypeId: 93, eventDescription: 'Sample delivered' }], HOME);
    expect(cancelled).toMatchObject({ status: 'unknown', last_status_text: 'Sample delivered' });
    expect(cancelled).not.toHaveProperty('current_stage');
  });

  it('reads the tracker’s empty answer as missing, and a firewall page as a challenge', async () => {
    const lookup = (body: string | null, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(null, 204)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('[]')).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(lookup(BLOCKED, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCKED, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered')}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('refuses a reply for several parcels and replies of another shape', () => {
    expect(() => parsePostaFaroe(edited('delivered', rows => { rows[0]!.parcelSequenceNo = 2; }), INBOUND))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(parsePostaFaroe(edited('delivered', rows => { for (const row of rows) delete row.parcelSequenceNo; }), INBOUND).events).toHaveLength(12);
    for (const payload of [{}, 'sample', 7, [null], ['scan'],
      edited('delivered', rows => { delete rows[1]!.eventTypeId; }),
      edited('delivered', rows => { rows[1]!.eventTypeId = '81'; }),
      edited('delivered', rows => { rows[1]!.eventTypeId = -1; }),
      edited('delivered', rows => { rows[1]!.eventTypeId = 8.5; }),
      edited('delivered', rows => { rows[1]!.parcelSequenceNo = '1'; }),
      edited('delivered', rows => { rows[1]!.eventDescription = ' '; }),
      edited('delivered', rows => { rows[1]!.eventDescription = ['Móttikið á posthús']; }),
      edited('delivered', rows => { rows[1]!.eventDateTime = '15.01.2026 08:10'; }),
      edited('delivered', rows => { rows[1]!.eventDateTime = '2026-02-30 08:10'; }),
      edited('delivered', rows => { rows[1]!.eventDateTime = '2026-01-15 24:00'; }),
      edited('delivered', rows => { rows[1]!.eventDateTime = null; }),
      edited('delivered', rows => { rows[1]!.eventDateTime = 1768464600; }),
      edited('delivered', rows => { rows[1]!.locationName = { name: 'Dømisstaður' }; }),
      Array.from({ length: 501 }, () => fixture('delivered')[0]!)]) {
      expect(() => parsePostaFaroe(payload, INBOUND), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A scan without a place is read without it.
    const bare = parsePostaFaroe(edited('delivered', rows => { rows[0]!.locationName = ''; }), INBOUND);
    expect(bare.events![0]).not.toHaveProperty('location');
    expect(bare).toMatchObject({ last_update: null, last_update_local: '2026-01-15T13:05:00' });
    expect(bare).not.toHaveProperty('delivered_at');
  });

  it('tells Posta’s own scans by their place', () => {
    for (const place of ['Dømisbygd', 'Dømisbygd - Útbering', 'FO - Dømisbygd', 'Sample office']) expect(isPostaFaroeHomeScan(place), place).toBe(true);
    for (const place of ['', 'DK - SAMPLE HUB', 'NL - EXAMPLE CITY', 'GB-SAMPLE']) expect(isPostaFaroeHomeScan(place), place).toBe(false);
  });

  it('takes S10 codes with a valid check digit, from any post, and 20-digit mail numbers, without a request for anything else', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RR123456784FO', 'RR12345678FO', 'RR123456785FOX', '0000000000000000000', `RR${'0'.repeat(70)}`, 'SAMPLE', '1']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePostaFaroeNumber(' rr-123-456-785 fo ')).toBe(UNKNOWN);
    expect(normalizePostaFaroeNumber(`${MAIL.slice(0, 10)} ${MAIL.slice(10)}`)).toBe(MAIL);
    const mail = vi.fn<typeof fetch>().mockResolvedValue(reply(null, 204));
    await expect(carrier(mail).track({ number: MAIL })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(mail.mock.calls[0]![0])).toBe(lookupUrl(MAIL));
  });

  it('recognizes a known item and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(null, 204));
    await expect(carrier(fetcher).recognize!(INBOUND)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-15T13:05:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(INBOUND)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(INBOUND)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: INBOUND })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: INBOUND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: INBOUND }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: INBOUND }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: INBOUND })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Posta to the adapter, and reads the tracking page’s links', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'posta-faroe' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'posta-faroe', source: 'posta-faroe', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === lookupUrl(INBOUND))).toBe(true);
    for (const link of [`https://www.posta.fo/en/private/send-receive/track-trace/${UNKNOWN}`,
      `https://posta.fo/fo/business/send-receive/track-trace/${UNKNOWN}/`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: UNKNOWN, carrier: 'posta-faroe', source: 'link' });
    }
    // Other posts' numbers stay with them: no detection rule offers Posta for recognition.
    expect(recognitionAskedCarriers(UNKNOWN)).not.toContain('posta-faroe');
  });
});

type Entry = { code?: string; wording: string; stage?: string; note: string };

describe('Posta status vocabulary', () => {
  it('maps every scan code its tracking API was seen with to the stage recorded for it', () => {
    const seen = (statuses.entries as Entry[]).filter(entry => entry.code && entry.note.includes('tracking API'));
    expect(seen.length).toBeGreaterThanOrEqual(10);
    for (const entry of seen) {
      expect(postaFaroeStage(entry.code!, entry.wording)?.stage, entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code!, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'posta-faroe', providerCode: entry.code!, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('stages the codes the tracking page heads, leaves its cancellation out on purpose and reads other wording', () => {
    expect([3, 4, 5, 121].map(code => postaFaroeMappedStage(String(code)))).toEqual(Array(4).fill('delivered'));
    expect(postaFaroeMappedStage('27')).toBe('ready_for_pickup');
    expect(postaFaroeMappedStage('10')).toBe('returned');
    expect(postaFaroeMappedStage('35')).toBe('failed_attempt');
    expect(postaFaroeMappedStage('98')).toBe('exception');
    // The page's "Delayed" headings mix customs holds with notices.
    expect(postaFaroeMappedStage('30')).toBeUndefined();
    expect(postaFaroeMappedStage('constructor')).toBeUndefined();
    for (const code of ['2', '93']) {
      expect(postaFaroeStage(code, 'Delivered'), code).toBeNull();
      expect(statusMapAnswer({ carrier: 'posta-faroe', providerCode: code, description: 'Sample' })).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(postaFaroeStage('999', 'Delivered')).toEqual({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
    expect(postaFaroeStage('999', 'Sample notice')).toBeNull();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
  });
});
