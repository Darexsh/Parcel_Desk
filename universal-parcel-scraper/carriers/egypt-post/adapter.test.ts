import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EGYPT_POST_ENDPOINT, EGYPT_POST_USER_AGENT, EgyptPostTracker } from './adapter.js';
import { normalizeEgyptPostNumber, parseEgyptPost } from './parser.js';
import { egyptPostScanStage, egyptPostStage, egyptPostSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'EXP00000017EG';
const EXPORTED = 'ZZ000000014EG';
const ABROAD = 'ZZ000000028EG';
const UNKNOWN = 'ZZ000000031EG';
const INBOUND = 'ZZ000000045CN';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const reply = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The firewall's pages: a block for some clients and a browser check for some networks.
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-error-details">Sorry, you have been blocked</div></body></html>';
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

type Step = Record<string, unknown>;
type Reply = { data: { barcode: unknown; case: unknown; data: Step[] } | null; success: unknown; errorMessages: unknown[] };
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const steps = (payload: Reply) => payload.data!.data;

describe('Egypt Post tracking adapter', () => {
  it('asks the tracker for the whole code once, as the app does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EgyptPostTracker({ fetcher, recorder }).fetch(' exp 0000-0017 eg ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${EGYPT_POST_ENDPOINT}?barcode=${DELIVERED}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': EGYPT_POST_USER_AGENT } });
    expect(init!.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'egypt-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery newest first, with each scan’s wall clock and office', () => {
    const result = parseEgyptPost(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delivered', last_update: null, last_update_local: '2026-03-05T13:47:00', expected_delivery: null,
      history_truncated: true });
    expect(result.events).toEqual([
      { local_time: '2026-03-05T13:47:00', location: 'Sample Delivery Office, SAMPLE TOWN, EGYPT', description: 'Shipment Delivered',
        stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-03-04T02:05:00', location: 'Sample Traffic Center, SAMPLE TOWN, EGYPT', description: 'Shipment Arrived at office',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-03T11:20:00', location: 'Sample Main Post Office, SAMPLE CITY, EGYPT', description: 'Shipment is collected from sender',
        stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads an item sent abroad up to its dispatch, and its scans abroad by their own wall clocks', () => {
    expect(parseEgyptPost(fixture('exported'), EXPORTED)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Shipment dispatched to international transporter', last_update_local: '2026-06-11T12:00:00',
      events: [{ location: 'EGYPT' }, { description: 'Shipment is collected from sender', stage: 'accepted' }] });
    const abroad = parseEgyptPost(fixture('abroad'), ABROAD);
    expect(abroad).toMatchObject({ status: 'delivered', last_update_local: '2026-07-16T19:58:00' });
    expect(abroad.events!.map(event => [event.local_time, event.location, event.description])).toEqual([
      ['2026-07-16T19:58:00', 'SAMPLE OFFICE - SAMPLE CITY, SAMPLELAND', 'Shipment Delivered'],
      ['2026-07-14T10:59:00', 'SAMPLELAND', 'Shipment Dispatched from Inward Office Of Exchange'],
      ['2026-07-14T10:35:00', 'SAMPLELAND', 'Shipment Arrived at Office Of Exchange'],
    ]);
    expect(abroad.events!.every(event => event.time === undefined)).toBe(true);
  });

  it('reads mail from abroad from its arrival in Egypt, and a round that brought the item back as a failed attempt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound')));
    const inbound = await carrier(fetcher).track({ number: INBOUND });
    expect(inbound).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Out for Delivery and Return to Office', last_update_local: '2026-08-12T18:10:00', history_truncated: true });
    expect(inbound.events!.map(event => [event.local_time, event.location, event.stage])).toEqual([
      ['2026-08-12T18:10:00', 'Sample Traffic Center, SAMPLE CITY, EGYPT', 'failed_attempt'],
      ['2026-08-11T12:13:00', 'Sample Traffic Center, SAMPLE CITY, EGYPT', 'in_transit'],
      ['2026-08-08T08:55:00', 'SAMPLE SORTING CENTRE, SAMPLE CITY, EGYPT', 'in_transit'],
    ]);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('barcode')).toBe(INBOUND);
    const booked = parseEgyptPost(edited('delivered', payload => {
      Object.assign(steps(payload)[0]!, { date: '02 March 2026', time: '06:54 AM', location: 'Sample Logistics Center', city: 'SAMPLE CITY',
        country: 'EGYPT', itemStatus: 'REQUEST PICKUP CREATED', mainStatus: 'In PICKING' });
      Object.assign(steps(payload)[3]!, { date: '05 March 2026', time: '09:43 AM', location: 'Sample Delivery Office', city: 'SAMPLE TOWN',
        country: 'EGYPT', itemStatus: 'Shipment is Out for Delivery', mainStatus: 'Out for Delivery ' });
    }), DELIVERED);
    expect(booked.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'accepted', 'registered']);
  });

  it('puts the later step first at the same minute, and reads midnight and noon', () => {
    const tied = parseEgyptPost(edited('delivered', payload => {
      Object.assign(steps(payload)[2]!, { date: '05 March 2026', time: '01:47 PM' });
    }), DELIVERED);
    expect(tied.events!.map(event => event.description)).toEqual(['Shipment Delivered', 'Shipment Arrived at office', 'Shipment is collected from sender']);
    const clocks = parseEgyptPost(edited('delivered', payload => {
      Object.assign(steps(payload)[1]!, { time: '12:05 AM' });
      Object.assign(steps(payload)[2]!, { date: '4 March 2026', time: '12:30 pm' });
    }), DELIVERED);
    expect(clocks.events!.map(event => event.local_time)).toEqual(['2026-03-05T13:47:00', '2026-03-04T12:30:00', '2026-03-03T00:05:00']);
  });

  it('stages new wording through the shared rules, then the step summary, and keeps the rest visible without a stage', () => {
    const returned = parseEgyptPost(edited('exported', payload => { steps(payload)[2]!.itemStatus = 'Item returned to sender'; }), EXPORTED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:language' });
    const summarized = parseEgyptPost(edited('exported', payload => { steps(payload)[1]!.itemStatus = 'Sample counter scan'; }), EXPORTED);
    expect(summarized.events![1]).toMatchObject({ description: 'Sample counter scan', stage: 'accepted', stage_source: 'carrier_map' });
    const bare = parseEgyptPost(edited('exported', payload => { steps(payload)[2]!.itemStatus = null; }), EXPORTED);
    expect(bare.events![0]).toMatchObject({ description: 'In international Process', stage: 'in_transit' });
    const unknown = parseEgyptPost(edited('exported', payload => {
      Object.assign(steps(payload)[2]!, { itemStatus: 'Sample counter scan', mainStatus: 'Sample step' });
    }), EXPORTED);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample counter scan' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ local_time: '2026-06-11T12:00:00', location: 'EGYPT', description: 'Sample counter scan' });
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parseEgyptPost(fixture('delivered'), 'EXP00000024EG')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseEgyptPost(edited('delivered', payload => { payload.data!.barcode = DELIVERED.toLowerCase(); }), DELIVERED).events).toHaveLength(3);
    for (const payload of [[], null, { success: 'yes' }, { data: null, success: true },
      edited('delivered', reply => { delete (reply.data as Record<string, unknown>).barcode; }),
      edited('delivered', reply => { reply.data!.barcode = `${DELIVERED},${EXPORTED}`; }),
      edited('delivered', reply => { reply.data!.case = '1'; }),
      edited('delivered', reply => { reply.data!.case = 4; }),
      edited('delivered', reply => { reply.data!.data = steps(reply).slice(0, 4); }),
      edited('delivered', reply => { (reply.data as Record<string, unknown>).data = {}; }),
      edited('delivered', reply => { steps(reply)[1]!.status = 3; }),
      edited('delivered', reply => { (steps(reply) as unknown[])[1] = 'scan'; }),
      edited('delivered', reply => { steps(reply)[1]!.date = '2026-03-03'; }),
      edited('delivered', reply => { steps(reply)[1]!.date = '30 February 2026'; }),
      edited('delivered', reply => { steps(reply)[1]!.time = '13:20 PM'; }),
      edited('delivered', reply => { steps(reply)[1]!.time = '11:20'; }),
      edited('delivered', reply => { steps(reply)[1]!.time = null; }),
      edited('delivered', reply => { Object.assign(steps(reply)[1]!, { itemStatus: ' ', mainStatus: null }); }),
      edited('delivered', reply => { steps(reply)[1]!.itemStatus = ['Collected']; }),
      edited('delivered', reply => { steps(reply)[1]!.location = 7; })]) {
      expect(() => parseEgyptPost(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the tracker’s no-data answer as missing, its incorrect-number answer as invalid, and a failed or empty lookup as inconclusive', () => {
    expect(() => parseEgyptPost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEgyptPost(fixture('incorrect'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseEgyptPost({ data: null, success: false, errorMessages: ['Sample failure'] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = edited('delivered', payload => { payload.data!.data = steps(payload).map(step => ({ ...steps(payload)[0]!, status: step.status })); });
    expect(() => parseEgyptPost(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('takes S10 codes with a valid check digit, from any post, and the domestic layout, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015EG', 'ZZ00000001EG', 'EXP0000001EG', 'EXP00000017EGX', 'EX000000017EG', '1234567890123', 'ABCDEFGHIJKLM', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    // The tracker's answer for an unknown code, naming the code asked.
    const any = vi.fn<typeof fetch>().mockImplementation(async (url) => reply(JSON.stringify(edited('not-found', payload => {
      payload.data!.barcode = new URL(String(url)).searchParams.get('barcode');
    }))));
    for (const number of [INBOUND, 'RR000000014DE', 'eno 0000 0017 eg']) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('barcode'))).toEqual([INBOUND, 'RR000000014DE', 'ENO00000017EG']);
    expect(normalizeEgyptPostNumber(' zz 000 000 045 cn ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T13:47:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
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

  it('keeps the firewall’s pages, empty and malformed replies apart from missing items', async () => {
    for (const [body, status, kind] of [[BLOCKED, 403, 'challenge'], [CHECK, 403, 'challenge'], [CHECK, 200, 'challenge'],
      ['<html><body>Sample maintenance</body></html>', 200, 'schema'], ['', 200, 'indeterminate'], ['  ', 200, 'indeterminate'],
      ['{"items":[]}', 200, 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, 'text/html; charset=UTF-8'));
      await expect(carrier(fetcher).recognize!(DELIVERED), `${status} ${body.slice(0, 40)}`).rejects.toMatchObject({ kind });
    }
    const bom = vi.fn<typeof fetch>().mockResolvedValue(reply(`\uFEFF${text('delivered')}`));
    await expect(carrier(bom).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(70_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
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
  });

  it('routes an item filed under Egypt Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'egypt-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'egypt-post', source: 'egypt-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(EGYPT_POST_ENDPOINT))).toBe(true);
  });

  it('is asked about Egyptian S10 codes, which detection leaves with the postal fallback, and its domestic codes', () => {
    expect(detectCarrierMatch(EXPORTED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(EXPORTED)[0]).toBe('egypt-post');
    expect(recognitionAskedCarriers('ZZ000000015EG')).not.toContain('egypt-post');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('egypt-post');
    expect(recognitionAskedCarriers(DELIVERED)).toContain('egypt-post');
    expect(parseTrackingInput(`https://www.egyptpost.org/track-details?itemReference=${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'egypt-post', source: 'link' });
  });
});

describe('Egypt Post status vocabulary', () => {
  it('maps every wording seen in live replies to the stage recorded for it', () => {
    // The other entries come from the earlier tracker.
    for (const entry of statuses.entries.filter(entry => entry.confirmedBy === 'live')) {
      expect(egyptPostScanStage(entry.wording) ?? egyptPostSummaryStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'egypt-post', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(egyptPostScanStage('Shipment Delivered ')).toBe('delivered');
    for (const wording of ['constructor', 'toString', 'Shipment', 'Shipment Delivered - Sample Office']) {
      expect(egyptPostScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'shipment delivered')).toBeUndefined();
    expect(egyptPostStage('', '')).toBeNull();
  });
});
