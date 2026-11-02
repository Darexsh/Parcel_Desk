import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BELPOST_API, BelpostTracker } from './adapter.js';
import { normalizeBelpostNumber, parseBelpost } from './parser.js';
import { belpostEventStage, belpostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014BY';
const IN_TRANSIT = 'ZZ000000028BY';
const UNKNOWN = 'ZZ000000031BY';
const INBOUND = 'ZZ000000045CN';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Step = Record<string, unknown>;
type Reply = { data: { number: unknown; steps: Step[] }[]; uuid: unknown; barcode: unknown };
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const steps = (payload: Reply) => payload.data[0]!.steps;
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Belpost tracking adapter', () => {
  it('asks the tracker for the whole code once, as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BelpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 by ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BELPOST_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify({ number: DELIVERED }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', hl: 'ru', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'belpost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery newest first, with each scan’s wall clock, office and code', () => {
    const result = parseBelpost(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Вручено', last_update: null, last_update_local: '2026-04-09T16:12:40', expected_delivery: null });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-04-09T16:12:40', 'ОПС №5 г.Образцово', 'Вручено', '21', 'delivered'],
      ['2026-04-07T09:41:03', 'ОПС №5 г.Образцово', 'Поступило в учреждение доставки', '70', 'ready_for_pickup'],
      ['2026-04-07T07:02:18', 'ОПС №5 г.Образцово', 'Поступило в обработку', '6', 'in_transit'],
      ['2026-04-07T03:55:31', 'Образцово Общий', 'Отправлено', '15', 'in_transit'],
      ['2026-04-06T12:20:47', 'Образцово Общий', 'Поступило в обработку', '6', 'in_transit'],
      ['2026-04-06T07:14:09', 'ОПС №7 г.Примерск', 'Отправлено', '15', 'in_transit'],
      ['2026-04-05T14:33:26', 'ОПС №7 г.Примерск', 'Принято от отправителя', '4', 'accepted'],
    ]);
    // The reply's epoch reads every clock as Minsk time, so no scan gets an instant.
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/000005|uuid|base64/);
    expect(result).not.toHaveProperty('pickup_point');
  });

  it('reads an item between offices as in transit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Отправлено', last_update_local: '2026-05-11T19:24:52', events: [{ location: 'Примерск ОЦПС' }, {}, {}, { stage: 'accepted' }] });
  });

  it('reads mail from abroad with the sending post’s scans by their own wall clocks, and scans at the same second in the reply’s order', () => {
    const result = parseBelpost(fixture('inbound'), INBOUND);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_update_local: '2026-02-19T09:12:44' });
    expect(result.events!.map(event => [event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-02-19T09:12:44', 'ОПС №37 г.Образцово', '70', 'ready_for_pickup'],
      ['2026-02-19T08:40:02', 'ОПС №37 г.Образцово', '6', 'in_transit'],
      ['2026-02-19T04:15:00', 'Образцово Общий', '15', 'in_transit'],
      ['2026-02-18T13:02:51', 'SAMPLE PI 2', '38', 'in_transit'],
      ['2026-02-18T10:47:19', 'SAMPLE PI 2', '31', 'customs'],
      ['2026-02-18T10:31:07', 'SAMPLE PI 2', '30', 'in_transit'],
      ['2026-01-30T17:26:00', 'SAMPLEEXP*', '7', 'in_transit'],
      ['2026-01-30T17:26:00', 'SAMPLE CITY EMS', '8', 'in_transit'],
      ['2026-01-28T09:48:00', 'SAMPLE CITY', '3', 'in_transit'],
      ['2026-01-27T14:05:00', '000000*', '1', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
  });

  it('keeps scans of one instant in the reply’s order, whichever way it lists them', () => {
    const codes = (payload: Reply) => parseBelpost(payload, INBOUND).events!.map(event => event.provider_code);
    expect(codes(edited('inbound', payload => { payload.data[0]!.steps = steps(payload).reverse(); }))).toEqual(codes(fixture('inbound')));
  });

  it('turns an oldest-first history round, keeps a repeated scan once and keeps the newest stage under an unknown wording', () => {
    const reversed = parseBelpost(edited('delivered', payload => { payload.data[0]!.steps = steps(payload).reverse(); }), DELIVERED);
    expect(reversed.events!.map(event => event.local_time)).toEqual(parseBelpost(fixture('delivered'), DELIVERED).events!.map(event => event.local_time));
    const repeated = parseBelpost(edited('delivered', payload => { steps(payload).splice(1, 0, { ...steps(payload)[1]!, timestamp: 0 }); }), DELIVERED);
    expect(repeated.events).toHaveLength(7);
    const unknown = parseBelpost(edited('in-transit', payload => {
      steps(payload).unshift({ ...steps(payload)[0]!, code: 99, created_at: '2026-05-12 08:00:00', event: 'Образец события', place: null });
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Образец события',
      last_update_local: '2026-05-12T08:00:00' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-05-12T08:00:00', description: 'Образец события', provider_code: '99' });
    const alone = parseBelpost(edited('in-transit', payload => { payload.data[0]!.steps = [{ ...steps(payload)[0]!, event: 'Образец события' }]; }), IN_TRANSIT);
    expect(alone).toMatchObject({ status: 'unknown', last_status_text: 'Образец события' });
    expect(alone.current_stage).toBeUndefined();
    const returned = parseBelpost(edited('in-transit', payload => { steps(payload)[0]!.event = 'Вручено отправителю'; }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it('reads the tracker’s entry without scans as missing, and a reply without the entry as inconclusive', async () => {
    expect(() => parseBelpost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBelpost({ data: [], uuid: null, barcode: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('delivered').replaceAll(DELIVERED, UNKNOWN)}`)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('reads the tracker’s format refusal as invalid input, and another refusal as a changed request', async () => {
    const lookup = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, 422))).track({ number: UNKNOWN });
    await expect(lookup(text('invalid'))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('{"message":"Sample","errors":{"token":["Sample"]}}')).rejects.toMatchObject({ kind: 'schema', status: 422 });
    await expect(lookup('<html></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parseBelpost(fixture('delivered'), 'ZZ000000045BY'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Belpost answered for a different item' }));
    expect(parseBelpost(edited('delivered', payload => { payload.data[0]!.number = DELIVERED.toLowerCase(); }), DELIVERED).events).toHaveLength(7);
    for (const payload of [[], null, { data: {} }, { data: null },
      edited('delivered', reply => { reply.data.push(reply.data[0]!); }),
      edited('delivered', reply => { delete reply.data[0]!.number; }),
      edited('delivered', reply => { reply.data[0]!.number = 7; }),
      edited('delivered', reply => { (reply.data[0] as Record<string, unknown>).steps = null; }),
      edited('delivered', reply => { (steps(reply) as unknown[])[1] = 'scan'; }),
      edited('delivered', reply => { steps(reply)[1]!.event = ' '; }),
      edited('delivered', reply => { steps(reply)[1]!.event = ['Вручено']; }),
      edited('delivered', reply => { steps(reply)[1]!.created_at = '07.04.2026 09:41'; }),
      edited('delivered', reply => { steps(reply)[1]!.created_at = '2026-02-30 09:41:03'; }),
      edited('delivered', reply => { steps(reply)[1]!.created_at = '2026-04-07 24:00:00'; }),
      edited('delivered', reply => { steps(reply)[1]!.created_at = null; }),
      edited('delivered', reply => { steps(reply)[1]!.place = 7; }),
      edited('delivered', reply => { steps(reply)[1]!.code = 'A1'; }),
      edited('delivered', reply => { steps(reply)[1]!.code = 1.5; }),
      edited('delivered', reply => { reply.data[0]!.steps = Array.from({ length: 501 }, () => steps(reply)[0]!); })]) {
      expect(() => parseBelpost(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015BY', 'ZZ00000001BY', 'ZZ000000014BYX', 'Z0000000014BY', '1234567890123', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBelpostNumber(' zz-000-000-045 cn ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-09T16:12:40' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"message":"Too Many Attempts."}',
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

  it('routes an item filed under Belpost to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'belpost' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'belpost', source: 'belpost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === BELPOST_API)).toBe(true);
  });

  it('is asked about Belarusian S10 codes, which detection leaves with the postal fallback', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('belpost');
    expect(recognitionAskedCarriers('ZZ000000015BY')).not.toContain('belpost');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('belpost');
    for (const link of [`https://belpost.by/Otsleditotpravleniye?number=${DELIVERED}`, `https://www.belpost.by/Otsleditotpravleniye/?number=${DELIVERED}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'belpost', source: 'link' });
    }
  });
});

describe('Belpost status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, whatever the code', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      expect(belpostEventStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'belpost', providerCode: code, description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(belpostStage(' вручено ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Вручено ОПС', 'Образец события']) expect(belpostEventStage(wording), wording).toBeUndefined();
    expect(belpostStage('')).toBeNull();
  });
});
