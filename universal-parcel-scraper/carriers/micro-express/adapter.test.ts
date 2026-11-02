import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MICRO_EXPRESS_API, MicroExpressTracker } from './adapter.js';
import { microExpressWording, normalizeMicroExpressNumber, parseMicroExpress } from './parser.js';
import { microExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ME1234560890124ABC';
const IN_TRANSIT = 'ME0000000000000ABC';
const UNKNOWN = 'ME0000000000000AAA';

type Row = Record<string, unknown>;
type Data = Row & { tracking_log: Row[] };
type Reply = Row & { data: Data };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Data, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
// The service sends its JSON as text/html.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseMicroExpress>) => result.events!.map((event) =>
  [event.time, event.provider_code, event.stage, event.location, event.description]);

describe('Micro Express HTTP adapter', () => {
  it('posts the whole number in capitals to the Track Item page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MicroExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' me 1234560890124 abc ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(MICRO_EXPRESS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json;UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ tracking_number: DELIVERED, bloclose: 'true' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'micro-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s instant in the zone the reply names, newest first, with the depot’s suburb', () => {
    const result = parseMicroExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered-Left at safe place', last_update: '2025-12-13T16:05:57.648+11:00', expected_delivery: null,
      delivered_at: '2025-12-13T16:05:57.648+11:00' });
    expect(rows(result)).toEqual([
      ['2025-12-13T16:05:57.648+11:00', 'DOWN', 'delivered', undefined, 'Delivered-Left at safe place'],
      ['2025-12-12T20:09:29.663+11:00', 'OUT', 'out_for_delivery', 'Sampleville(SA)', 'Item onboard ready for delivery'],
      ['2025-12-12T17:52:48.603+11:00', 'COLLECT', 'in_transit', 'Sampleville(SA)', 'Item has been received by local delivery depot'],
      // Entered later, the sorting scan sits after the delivery in the reply; its instant puts it back in place.
      ['2025-12-12T06:30:00+11:00', 'IN', 'in_transit', 'Exampleton(VIC)', 'Item processed by local courier at sorting facility'],
      ['2025-12-04T11:45:10.780+11:00', 'INIT', 'registered', undefined, 'Order Creation, order submitted, pending to receive.'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads a winter history at Melbourne’s standard offset and keeps scans of one second in their order', () => {
    const result = parseMicroExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Item onboard ready for delivery', last_update: '2026-07-15T07:10:11.939+10:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows(result)).toEqual([
      ['2026-07-15T07:10:11.939+10:00', 'OUT', 'out_for_delivery', 'Testford(VIC)', 'Item onboard ready for delivery'],
      ['2026-07-14T18:20:30.420+10:00', 'COLLECT', 'in_transit', 'Testford(VIC)', 'Item has been received by local delivery depot'],
      ['2026-07-14T18:20:30.401+10:00', 'IN', 'in_transit', 'Testford(VIC)', 'Item processed by local courier at sorting facility'],
      ['2026-07-10T09:00:05.811+10:00', 'INIT', 'registered', undefined, 'Order Creation, order submitted, pending to receive.'],
    ]);
  });

  it('reads the instant, not the text clocks, and keeps a repeated scan once', () => {
    const result = parseMicroExpress(changed('in-transit', (data) => {
      data.tracking_log[0]!.local_time = '2026/07/15 08:10:11';
      data.tracking_log[0]!.time_zone = 'Mars/Olympus';
      data.tracking_log.push({ ...data.tracking_log[1]! });
    }), IN_TRANSIT);
    expect(result.events).toHaveLength(4);
    expect(result.events![0]).toMatchObject({ time: '2026-07-15T07:10:11.939+10:00' });
  });

  it('keeps a collection shop’s delivery without the shop’s details, and its handover as the delivery', () => {
    const shop = (data: Data) => {
      data.tracking_log.unshift({ ...data.tracking_log[0]!, timestamp: 1784080000000, event_code: 'DOWN', location: '',
        description: 'Delivered by STORE(Sample Shop. address:1 Example Street, Testford VIC 3999. phone:0400 000 000)' });
    };
    const left = parseMicroExpress(changed('in-transit', shop), IN_TRANSIT);
    expect(left).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered by STORE' });
    expect(left).not.toHaveProperty('delivered_at');
    const collected = parseMicroExpress(changed('in-transit', (data) => {
      shop(data);
      data.tracking_log.unshift({ ...data.tracking_log[0]!, timestamp: 1784090000000, event_code: 'SELF-PICK', description: '' });
    }), IN_TRANSIT);
    expect(collected).toMatchObject({ current_stage: 'delivered', last_status_text: 'SELF-PICK', delivered_at: '2026-07-15T14:33:20+10:00' });
    expect(JSON.stringify([left, collected])).not.toMatch(/Sample Shop|Example Street|3999|0400/);
    expect(microExpressWording('Delivered-Left at safe place, call 0400 000 000')).toBe('Delivered-Left at safe place, call');
  });

  it('keeps a place only when it holds no digit', () => {
    const result = parseMicroExpress(changed('in-transit', (data) => { data.tracking_log[0]!.location = '1 Sample Street, Testford(VIC)'; }), IN_TRANSIT);
    expect(result.events![0]).not.toHaveProperty('location');
  });

  it('reads an empty history as not found and a refused lookup as inconclusive', () => {
    expect(() => parseMicroExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMicroExpress(changed('not-found', (data) => { (data as Row).tracking_log = null; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMicroExpress({ code: 110, msg: 'params err:{"tracking_number":' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a reply only when it names the number asked', () => {
    expect(() => parseMicroExpress(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Micro Express answered for another shipment' }));
    expect(() => parseMicroExpress(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The reply repeats the number as it was sent.
    expect(parseMicroExpress(changed('delivered', (data) => { data.tracking_number = ` ${DELIVERED.toLowerCase()} `; }), DELIVERED).events)
      .toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Data, body: Reply) => { delete (body as Row).code; },
      (_data: Data, body: Reply) => { body.code = '200'; },
      (_data: Data, body: Reply) => { delete (body as Row).data; },
      (_data: Data, body: Reply) => { body.data = 'shipment' as never; },
      (data: Data) => { delete data.tracking_number; },
      (data: Data) => { data.tracking_number = ['ME1234560890124ABC']; },
      (data: Data) => { data.tracking_log = 'scans' as never; },
      (data: Data) => { data.tracking_log = Array.from({ length: 501 }, () => data.tracking_log[0]!); },
      (data: Data) => { data.tracking_log[0] = 'scan' as never; },
      (data: Data) => { delete data.tracking_log[0]!.timestamp; },
      (data: Data) => { data.tracking_log[0]!.timestamp = '1765602357648'; },
      (data: Data) => { data.tracking_log[0]!.timestamp = 1765602357; },
      (data: Data) => { data.tracking_log[0]!.timestamp = 1765602357648.5; },
      (data: Data) => { data.tracking_log[0]!.event_code = { code: 'DOWN' }; },
      (data: Data) => { data.tracking_log[0]!.description = ['Delivered']; },
      (data: Data) => { data.tracking_log[0]!.description = ''; data.tracking_log[0]!.event_code = ''; },
      (data: Data) => { data.tracking_log[1]!.location = 7; },
      (data: Data) => { data.tracking_log[1]!.time_zone = 11; },
    ]) {
      expect(() => parseMicroExpress(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(reply(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply('Sorry, can\'t find that!', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('', { status: 301, headers: { Location: 'https://microexpress.com.au/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<!DOCTYPE html><html><head><title>Micro Express</title></head><body><div id=app></div></body></html>')))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends a read that failed to reach Micro Express once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A reply is never sent again.
    const answered = vi.fn<typeof fetch>().mockImplementation(async () => reply({ code: 110, msg: 'params err' }));
    await expect(carrier(answered).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it('recognizes a known number with its last activity, and asks nothing for a number Micro Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2025-12-13T05:05:57.648Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ME000000000000AAA')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Micro Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ME000000000000AAA', 'ME00000000000000AAA', 'ME0000000000000AA', 'MX0000000000000AAA', 'ME000000000000AAAA',
      'ME0000000000000AAA,ME0000000000000AAA']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMicroExpressNumber('me 12345 60890 124-abc')).toBe(DELIVERED);
    // A letter or digit can end the number.
    expect(normalizeMicroExpressNumber('ME00000000000000AB')).toBe('ME00000000000000AB');
  });

  it('routes a number Micro Express’s rule claims to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'micro-express', source: 'micro-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === MICRO_EXPRESS_API)).toBe(true);
  });
});

describe('Micro Express status vocabulary', () => {
  it('records every event code and wording with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(microExpressStage(entry.code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
      const mapped = statusMap.stage(entry.code ?? null, entry.wording.toLowerCase());
      if (mapped) expect(mapped, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'micro-express', providerCode: 'OUT', description: 'Item onboard ready for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'micro-express', providerCode: 'DOWN', description: 'Delivered by STORE' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'micro-express', providerCode: 'SYNTH', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know is staged by the shared wording rules.
    expect(microExpressStage('SYNTH', 'Delivery attempted, nobody home')).toMatchObject({ stage: 'failed_attempt' });
    expect(microExpressStage('SYNTH', 'Synthetic note')).toBeNull();
  });
});
