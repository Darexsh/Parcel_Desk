import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHADOWFAX_LOOKUP_API, SHADOWFAX_TRACK_API, ShadowfaxTracker } from './adapter.js';
import { normalizeShadowfaxNumber, parseShadowfax, shadowfaxUnknown, shadowfaxWording } from './parser.js';
import { shadowfaxCodeStage, shadowfaxHeadingStage, shadowfaxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SF1000000001SMP';
const IN_TRANSIT = 'SF1000000002SMP';
const FAILED = 'SF1000000003SMP';
const NO_HISTORY = 'R1000000004SMP';
const UNKNOWN = 'SF1000000009SMP';

type Row = Record<string, unknown>;
type Milestone = Row & { sub_status: unknown[]; time: unknown[] };
type Reply = Row & { order_details: Row; data: Milestone[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The milestones before the current one, as a reply that kept them would list them.
const EARLIER: Milestone[] = [
  { main_status: 'Order Received', sub_status: ['Order is received'], time: ['2026-05-14T10:02:11'], main_status_id: 1 },
  { main_status: 'Shipment has been picked', sub_status: ['Shipment is picked up from the seller'], time: ['2026-05-15T17:40:05'] },
];

describe('Shadowfax HTTP adapter', () => {
  it('asks the delivery service once for the whole AWB in capitals, with the tracker’s token, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ShadowfaxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' sf 1000-0000-02smp ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHADOWFAX_TRACK_API}${IN_TRANSIT}/`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Authorization: expect.stringMatching(/^Token \w{64}$/), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shadowfax', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads India’s wall clocks as instants and each facility as the location, newest first', () => {
    const result = parseShadowfax(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit: Shipment is received at Shadowfax\'s Sample City DC facility', last_update: '2026-05-18T19:46:37+05:30',
      expected_delivery: '2026-05-20', history_truncated: true });
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.provider_code, event.stage])).toEqual([
      ['2026-05-18T19:46:37+05:30', 'Sample City DC', '2', 'in_transit'],
      // A clock with a fraction keeps its second.
      ['2026-05-17T08:16:48+05:30', 'Sample Hub', '2', 'in_transit'],
      ['2026-05-16T21:14:14+05:30', 'Sample Hub', '2', 'in_transit'],
      ['2026-05-16T08:33:26+05:30', 'Sample Hub', '2', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps the delivery without the phone number or the delivery remark', () => {
    const result = parseShadowfax(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered: Shipment has been delivered', last_update: '2026-03-24T11:38:31+05:30', expected_delivery: null,
      delivered_at: '2026-03-24T11:38:31+05:30', history_truncated: true,
      events: [{ time: '2026-03-24T11:38:31+05:30', description: 'Delivered: Shipment has been delivered', provider_code: '7',
        stage: 'delivered', stage_source: 'carrier_map' }] });
    expect(JSON.stringify(result)).not.toMatch(/XXXXXX|0000|11:38 AM|Sample Recipient/);
  });

  it('reads a delivery Shadowfax gave up as an exception, while the parcel goes back to the seller', () => {
    expect(parseShadowfax(fixture('delivery-failed'), FAILED)).toMatchObject({ status: 'exception', current_stage: 'exception',
      current_stage_source: 'carrier_map', last_status_text: 'Delivery failed: The shipment is getting returned to origin',
      last_update: '2026-04-14T21:25:37+05:30', expected_delivery: null, history_truncated: true });
  });

  it('reads a whole history from the first milestone, whatever order the milestones come in', () => {
    const result = parseShadowfax(changed('in-transit', (body) => { body.data.unshift(...structuredClone(EARLIER)); }), IN_TRANSIT);
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events).toHaveLength(6);
    expect(result.events!.slice(-2)).toEqual([
      { time: '2026-05-15T17:40:05+05:30', description: 'Shipment has been picked: Shipment is picked up from the seller',
        stage: 'accepted', stage_source: 'carrier_map' },
      // A milestone number the map does not know falls to its heading.
      { time: '2026-05-14T10:02:11+05:30', description: 'Order Received: Order is received', provider_code: '1',
        stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // The same scan listed twice is kept once.
    const repeated = parseShadowfax(changed('in-transit', (body) => {
      body.data.push(structuredClone(body.data[0]!));
    }), IN_TRANSIT);
    expect(repeated.events).toHaveLength(4);
  });

  it('leaves new wording to the shared rules and to the summary, and an unknown stage when neither knows it', () => {
    const worded = parseShadowfax(changed('in-transit', (body) => {
      Object.assign(body.data[0]!, { main_status: 'Sample Step', main_status_id: 99 });
      body.data[0]!.sub_status[0] = 'Shipment is out for delivery';
    }), IN_TRANSIT);
    expect(worded).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'wording:language' });
    const summarized = parseShadowfax(changed('in-transit', (body) => {
      Object.assign(body.data[0]!, { main_status: 'Sample Step', main_status_id: 99 });
      body.data[0]!.sub_status[0] = 'Sample note';
    }), IN_TRANSIT);
    expect(summarized).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(summarized.events![0]).not.toHaveProperty('stage');
    const unknown = parseShadowfax(changed('in-transit', (body) => {
      Object.assign(body.data[0]!, { main_status: 'Sample Step', main_status_id: 99 });
      body.data[0]!.sub_status[0] = 'Sample note';
      body.order_details.status_id = 'sample';
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample Step: Sample note' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('drops an estimate it cannot read, and the estimate of a delivered parcel', () => {
    for (const estimate of [null, '', 'N/A', '2026-05-20', '31 February 2026, Tuesday']) {
      expect(parseShadowfax(changed('in-transit', (body) => { body.order_details.exp_delivery_date = estimate; }), IN_TRANSIT).expected_delivery)
        .toBeNull();
    }
  });

  it('takes phone numbers and one-time codes out of the wording', () => {
    expect(shadowfaxWording('Out For Delivery', 'Rider is on the way, call +91 98765 43210 for help. Share OTP 1234 with the rider'))
      .toBe('Out For Delivery: Rider is on the way, call for help. Share OTP with the rider');
    // A line that repeats its heading is not doubled, and an empty one leaves the heading.
    expect(shadowfaxWording('Delivered', 'Delivered')).toBe('Delivered');
    expect(shadowfaxWording('Order Received.', 'Order received. Waiting for pickup')).toBe('Order received. Waiting for pickup');
    expect(shadowfaxWording('In Transit', '')).toBe('In Transit');
  });

  it('reads a record without scans as no history, and recognizes it as known', async () => {
    expect(() => parseShadowfax(fixture('no-history'), NO_HISTORY))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseShadowfax(changed('in-transit', (body) => { delete (body as Row).data; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('no-history')));
    await expect(carrier(fetcher).track({ number: NO_HISTORY })).rejects.toMatchObject({ name: 'NoHistoryError' });
    await expect(carrier(fetcher).recognize!(NO_HISTORY)).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('counts a reply only when it names the number asked', () => {
    expect(() => parseShadowfax(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shadowfax answered for another shipment' }));
    expect(parseShadowfax(changed('in-transit', (body) => { body.order_details.awb_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(4);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).order_details; },
      (body: Reply) => { body.order_details = 'order' as never; },
      (body: Reply) => { delete body.order_details.awb_number; },
      (body: Reply) => { body.order_details.awb_number = 7; },
      (body: Reply) => { body.data = 'milestones' as never; },
      (body: Reply) => { body.data = Array.from({ length: 51 }, () => body.data[0]!); },
      (body: Reply) => { body.data[0]!.sub_status = Array.from({ length: 301 }, (_, index) => `Scan ${index}`);
        body.data[0]!.time = Array.from({ length: 301 }, () => '2026-05-18T19:46:37'); },
      (body: Reply) => { body.data[0] = 'milestone' as never; },
      (body: Reply) => { delete body.data[0]!.main_status; },
      (body: Reply) => { body.data[0]!.main_status = ' '; },
      (body: Reply) => { body.data[0]!.main_status_id = '2'; },
      (body: Reply) => { body.data[0]!.main_status_id = -1; },
      (body: Reply) => { body.data[0]!.time.pop(); },
      (body: Reply) => { body.data[0]!.sub_status = 'scan' as never; },
      (body: Reply) => { body.data[0]!.sub_status[0] = 7; },
      (body: Reply) => { body.data[0]!.time[0] = '18/05/2026 19:46'; },
      (body: Reply) => { body.data[0]!.time[0] = '2026-05-18T19:46:37Z'; },
      (body: Reply) => { body.data[0]!.time[0] = '2026-02-30T10:00:00'; },
      (body: Reply) => { body.data[0]!.time[0] = '2026-05-18T24:00:00'; },
      (body: Reply) => { body.data[0]!.time[0] = 1_779_113_797; },
    ]) {
      expect(() => parseShadowfax(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks the tracker’s own lookup about a number the delivery service does not know, and only its answer is a missing parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('not-found'), 400))
      .mockResolvedValueOnce(reply(fixture('lookup-not-found'), 400));
    await expect(carrier(fetcher).track({ number: UNKNOWN.toLowerCase() })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${SHADOWFAX_TRACK_API}${UNKNOWN}/`, `${SHADOWFAX_LOOKUP_API}?order_id=${UNKNOWN}`]);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'GET', headers: { Authorization: expect.stringMatching(/^Token /) } });

    const answers = async (track: Response, lookup?: Response) => {
      const asked = vi.fn<typeof fetch>().mockResolvedValueOnce(track);
      if (lookup) asked.mockResolvedValueOnce(lookup);
      return carrier(asked).track({ number: UNKNOWN });
    };
    // A Shadowfax Connect order, or a number the lookup knows that the delivery service does not answer for.
    await expect(answers(reply(fixture('not-found'), 400), reply(fixture('lookup-connect'))))
      .rejects.toMatchObject({ kind: 'indeterminate', message: expect.stringContaining('Shadowfax Connect') });
    await expect(answers(reply(fixture('not-found'), 400), reply({ message: 'Success', data: { unique_code: 'SAMPLE', type: 'Fwd', awb_number: UNKNOWN } })))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'Shadowfax knows the number but its delivery service did not answer for it' });
    await expect(answers(reply(fixture('not-found'), 400), reply({ message: 'Success', data: { type: 'Fwd', awb_number: DELIVERED } })))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'Shadowfax answered for another shipment' });
    await expect(answers(reply(fixture('not-found'), 400), reply({ message: 'Something went wrong' }, 400)))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(answers(reply(fixture('not-found'), 400), reply('', 500))).rejects.toMatchObject({ kind: 'indeterminate' });
    // Another refusal of the delivery service is not an unknown number.
    await expect(answers(reply({ message: 'Something went wrong' }, 400))).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => shadowfaxUnknown(200, fixture('lookup-not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a browser check, a moved service and a broken reply apart from missing parcels', async () => {
    const lookup = (body: string, status = 200, headers: Record<string, string> = {}) =>
      carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status, headers))).track({ number: UNKNOWN });
    await expect(lookup(CHALLENGE, 200, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, 400, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Shadowfax</title></html>', 200, { 'Content-Type': 'text/html' })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', 200)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', 301, { Location: 'https://www.shadowfax.in/' })).rejects.toMatchObject({ kind: 'indeterminate' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ detail: 'Sample' }, status));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known number and the tracker’s unknown-number answer, and asks nothing for a number Shadowfax does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), 400)).mockResolvedValueOnce(reply(fixture('lookup-not-found'), 400));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-24T06:08:31.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('SF-1')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Shadowfax does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SF00001', 'SAMPLETRACKING', `SF${'0'.repeat(40)}`, 'SF000000001/SMP']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShadowfaxNumber('sf 1000-0000-01 smp')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number detection claims, or one filed under Shadowfax, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shadowfax', source: 'shadowfax', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED, carrier: 'shadowfax' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shadowfax', source: 'shadowfax' });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${SHADOWFAX_TRACK_API}${DELIVERED}/`)).toBe(true);
  });
});

describe('Shadowfax numbers', () => {
  it('claims its AWBs, suggests its return pickups and leaves shorter merchant codes alone', () => {
    for (const number of [DELIVERED, UNKNOWN, 'SF100000001SMP', 'SF100000000001SMP']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'shadowfax', confidence: 'high' });
    }
    expect(detectCarrierMatch(NO_HISTORY)).toMatchObject({ confidence: 'low', candidates: ['shadowfax'] });
    // A low-confidence return pickup is asked, a claimed AWB is tracked directly.
    expect(recognitionAskedCarriers(NO_HISTORY)).toContain('shadowfax');
    for (const number of ['SF1000000001S', 'SF1000000001SM', 'SF10000001SMP', 'R100000004SMP']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('shadowfax');
    }
  });
});

describe('Shadowfax status vocabulary', () => {
  it('records every milestone number and heading the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[];
    const checked = entries.filter((entry) => entry.code || shadowfaxHeadingStage(entry.wording));
    expect(entries.filter((entry) => entry.confirmedBy !== 'source').every((entry) => checked.includes(entry))).toBe(true);
    for (const entry of checked) {
      const [heading = entry.wording] = entry.code ? entry.wording.split(': ', 1) : [entry.wording];
      expect(statusMap.stage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(shadowfaxStage(entry.code ?? '', heading, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'shadowfax', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(shadowfaxCodeStage('8')).toBe('exception');
    expect(statusMapAnswer({ carrier: 'shadowfax', providerCode: '99', description: 'Sample Step: Sample note' })).toEqual({ kind: 'unknown' });
    // A number the map does not know falls to the heading, then to the shared wording rules.
    expect(shadowfaxStage('99', 'Out For Delivery', 'Out For Delivery: Sample note')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(shadowfaxStage('99', 'Sample Step', 'Sample Step: Shipment has been delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(shadowfaxStage('99', 'Sample Step', 'Sample Step: Sample note')).toBeNull();
  });
});
