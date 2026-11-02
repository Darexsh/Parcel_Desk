import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, LINEAR_API, LinearTracker } from './adapter.js';
import { LINEAR_MAX_BYTES, linearWording, normalizeLinearNumber, parseLinear } from './parser.js';
import { linearStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '7086402195';
const OTHER = '7086402196';
type Row = Record<string, unknown>;
type Reply = Row & { data: Row[] };
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (change: (body: Reply) => void) => {
  const body = fixture();
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Linear Logistics HTTP adapter', () => {
  it('asks the current public lookup for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new LinearTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(' 7086-402 195 ', { budgetMs: 1000.5 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([`${LINEAR_API}?q=${NUMBER}`, expect.objectContaining({
      method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), cache: 'no-store',
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' },
    })]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'linear-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('keeps the complete dated timeline, with the original local clocks and explicit stages', () => {
    const result = parseLinear(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item has been delivered as requested', last_update: null, last_update_local: '2026-03-05T14:32:00',
      expected_delivery: null });
    expect(result.events).toHaveLength(10);
    expect(result.events!.map((event) => event.stage ?? null)).toEqual([
      'delivered', 'out_for_delivery', 'in_transit', null, 'failed_attempt', 'out_for_delivery', 'in_transit',
      'in_transit', 'in_transit', 'registered',
    ]);
    expect(result.events![8]).toMatchObject({ local_time: '2026-03-03T18:07:00', location: 'Sample Hub' });
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC RECIPIENT|received by (?!DX\b)|ETA:|Due for delivery|lpn|"carrier"/i);
  });

  it('does not let the booking of a later delivery undo the failed attempt', () => {
    const result = parseLinear(changed((body) => { body.data = body.data.slice(3); }), NUMBER);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Redelivery has been booked',
      last_update_local: '2026-03-04T19:35:00' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(statusMap.gaps).toContainEqual(expect.objectContaining({ wording: 'redelivery has been booked' }));
    expect(linearStage('Redelivery has been booked')).toBeNull();
  });

  it('removes recipient, delivery place, contacts and capability links before retaining text', () => {
    expect(linearWording('Item has been delivered as requested and received by SYNTHETIC RECEIVER')).toBe('Item has been delivered as requested');
    expect(linearWording('Item delivered to Sample Recipient, 12 Example Street')).toBe('Item delivered');
    expect(linearWording('Item left at 12 Example Street')).toBe('Item left');
    expect(linearWording('Arrived at Hub https://example.invalid/private?token=synthetic')).toBe('Arrived at Hub');
    expect(linearWording('Delivery delayed, call +44 0000 000000')).toBe('Delivery delayed, call');
    expect(linearWording('Delivery delayed, synthetic@example.invalid')).toBe('Delivery delayed');
    expect(linearWording('Item received by DX and awaiting route scan')).toBe('Item received by DX and awaiting route scan');
    const result = parseLinear(changed((body) => {
      body.data[0]!.location = 'https://example.invalid/private';
      body.data[0]!.receiver = 'SYNTHETIC RECEIVER';
      body.data[0]!.postcode = 'AA1 1AA';
      body.data[0]!.photo = 'https://example.invalid/photo';
    }), NUMBER);
    expect(JSON.stringify(result)).not.toMatch(/example\.invalid|SYNTHETIC|AA1 1AA/);
    expect(result.events![0]).not.toHaveProperty('location');
  });

  it('binds every whole identity and never combines another shipment or an unverified feed', () => {
    expect(() => parseLinear(changed((body) => { body.data[1]!.lpn = OTHER; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const lpn of [undefined, {}, [NUMBER], Number(NUMBER), `${NUMBER}${' '.repeat(600)}1`]) {
      expect(() => parseLinear(changed((body) => { body.data[0]!.lpn = lpn; }), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLinear(changed((body) => { body.data[0]!.carrier = 'Another network'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const result = parseLinear(changed((body) => { for (const row of body.data) row.lpn = '7086-402-195'; }), NUMBER);
    expect(result.events).toHaveLength(10);
  });

  it('deduplicates scans, orders an oldest-first history and marks the retained event limit', () => {
    expect(parseLinear(changed((body) => { body.data.reverse(); body.data.push({ ...body.data[0]! }); }), NUMBER).events)
      .toEqual(parseLinear(fixture(), NUMBER).events);
    const result = parseLinear(changed((body) => {
      body.data = Array.from({ length: 101 }, (_, i) => ({ ...body.data[0], description: `Arrived at synthetic hub ${i}` }));
    }), NUMBER);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('rejects changed envelopes, rows, fields and invalid local clocks', () => {
    for (const change of [
      (body: Reply) => { body.success = 'true'; },
      (body: Reply) => { body.error = {}; },
      (body: Reply) => { (body as Row).data = null; },
      (body: Reply) => { body.data = Array.from({ length: 501 }, () => body.data[0]!); },
      (body: Reply) => { body.data[0] = [] as never; },
      (body: Reply) => { body.data[0]!.description = {}; },
      (body: Reply) => { body.data[0]!.description = ''; },
      (body: Reply) => { body.data[0]!.location = 4; },
      (body: Reply) => { body.data[0]!.carrier = undefined; },
      (body: Reply) => { body.data[0]!.date = '30/02/2026'; },
      (body: Reply) => { body.data[0]!.date = '01/01/0001'; },
      (body: Reply) => { body.data[0]!.time = '24:00'; },
      (body: Reply) => { body.data[0]!.time = '14:32+01:00'; },
      (body: Reply) => { body.data[0]!.time = ''; },
    ]) {
      expect(() => parseLinear(changed(change), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLinear({ success: true, data: [] }, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseLinear([], NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires the provider’s exact unknown signature and preserves other refusals', () => {
    expect(() => parseLinear(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const refusal = (message: unknown, status_code = 200) => ({ success: false, error: { message, status_code } });
    expect(() => parseLinear(refusal(['Lookup temporarily unavailable']), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLinear(refusal(['Too many requests'], 429), NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseLinear(refusal(['Verification needed'], 403), NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseLinear(refusal('That tracking code was not found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLinear({ ...fixture('not-found'), data: fixture().data }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance'], [404, 'transport'], [302, 'transport']] as const)(
    'preserves HTTP %s as %s without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('SYNTHETIC RECEIVER private response', { status,
        headers: { 'Retry-After': '17', 'Set-Cookie': 'private=synthetic', Location: 'https://example.invalid/private' } }));
      const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
      const error = await new LinearTracker({ fetcher, recorder }).fetch(NUMBER).catch((error: unknown) => error);
      expect(error).toMatchObject({ kind });
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 17_000 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(inspect({ error, steps: recorder.step.mock.calls, lookup: recorder.lookup.mock.calls }, { depth: 10 }))
        .not.toMatch(new RegExp(`${NUMBER}|SYNTHETIC RECEIVER|private=|example\\.invalid|tracking/lookup`));
    });

  it('keeps HTTP 200 challenges and malformed replies out of not-found and telemetry excerpts', async () => {
    for (const [body, kind] of [
      ['<html><title>Just a moment</title><script src="/cdn-cgi/challenge-platform/"></script></html>', 'challenge'],
      ['{"success":true,"data": SYNTHETIC RECEIVER https://example.invalid/private', 'schema'],
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
      const error = await new LinearTracker({ fetcher, recorder }).fetch(NUMBER).catch((error: unknown) => error);
      expect(error).toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(inspect({ error, steps: recorder.step.mock.calls }, { depth: 10 })).not.toMatch(/SYNTHETIC RECEIVER|example\.invalid/);
    }
  });

  it('retries only a network failure and retains safe recovery provenance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(`private ${NUMBER} https://example.invalid/private`))
      .mockResolvedValueOnce(reply(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LinearTracker({ fetcher, recorder }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok',
      fallbackFrom: 'direct', fallbackReason: 'transport', fallbackErrorType: 'UpstreamNetworkError' }));
    expect(inspect(recorder.step.mock.calls, { depth: 10 })).not.toMatch(new RegExp(`${NUMBER}|example\\.invalid|private ${NUMBER}`));
  });

  it('bounds the response body and does not retry a response that is too large', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('x'.repeat(LINEAR_MAX_BYTES + 1)));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid input and pre-aborted or spent lookups before sending a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['7186402195', '708640219', `${NUMBER}1`, `70${' '.repeat(200)}86402195`, 'EXAMPLE']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLinearNumber('7086.402-195')).toBe(NUMBER);
  });

  it('spends one shared budget and aborts both hanging attempts', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const start = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 80 })).rejects.toThrow());
    expect(Date.now() - start).toBe(80);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('Linear Logistics status vocabulary', () => {
  it('records the mapped wordings and the deliberate booking gap', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe('stage' in entry ? entry.stage : undefined);
      expect(linearStage(entry.wording)?.stage, entry.wording).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(linearStage('Synthetic activity')).toBeNull();
    expect(linearStage('Sorted in regional hub')).toMatchObject({ stage: 'in_transit', source: 'wording:language' });
    expect(statusMap.stage('UNVERIFIED', 'Label Created')).toBeUndefined();
  });
});
