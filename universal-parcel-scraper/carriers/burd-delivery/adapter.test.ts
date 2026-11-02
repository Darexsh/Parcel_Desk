import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BURD_API, BurdTracker } from './adapter.js';
import { normalizeBurdNumber, parseBurd } from './parser.js';
import { burdMappedStage, burdWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '012345600000000012';
const IN_TRANSIT = '012345600000000029';
const UNKNOWN = '012345600000000036';

type Row = Record<string, unknown>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Row[];
const changed = (name: string, change: (rows: Row[]) => void) => {
  const rows = fixture(name);
  change(rows);
  return rows;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
// The service's answer for a number it does not know.
const unknownReply = () => new Response(null, { status: 400 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Burd Delivery HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BurdTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0123 4560 0000 0000 29 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BURD_API}?number=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'burd-delivery', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history at Denmark’s offset, newest first, with the page’s wording', () => {
    const result = parseBurd(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Pakken er leveret.', last_update: '2026-03-31T19:48:09+02:00', delivered_at: '2026-03-31T19:48:09+02:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-03-31T19:48:09+02:00', 'delivered', 'delivered'],
      ['2026-03-31T18:05:41+02:00', 'deliveryOnTheWay', 'out_for_delivery'],
      ['2026-03-30T21:31:17+02:00', 'deliveryFailed', 'failed_attempt'],
      ['2026-03-30T18:12:03+02:00', 'deliveryOnTheWay', 'out_for_delivery'],
      ['2026-03-30T16:02:58+02:00', 'received', 'accepted'],
      // Registered before the clocks went forward.
      ['2026-03-28T23:10:05+01:00', 'registered', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time && !event.location)).toBe(true);
    expect(result.events![2]!.description).toBe('Vi kunne desværre ikke levere din pakke. Vi forsøger at levere igen indenfor 2 hverdage, før den sendes retur.');
    // Neither the webshop's order number nor its name is kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-1001|samplewebshop|00000000-0000|home/);
  });

  it('reads a parcel moved to another day, after one the sender handed over late', () => {
    const result = parseBurd(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Leveringen er planlagt til en anden dag.',
      last_update: '2026-06-02T17:20:44+02:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.provider_code)).toEqual(['receivedFlex', 'received', 'notReceived', 'registered']);
    expect(result.events![2]).toMatchObject({ stage: 'exception' });
  });

  it('sorts a history listed oldest first, keeps a repeated status once and shows an unknown status type as it is', () => {
    const result = parseBurd(changed('in-transit', (rows) => {
      rows.reverse();
      rows.push({ ...rows.at(-1)! });
      rows.push({ ...rows[0]!, statusType: 'sampleStatus', created: '2026-06-02T16:00:00Z' });
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['sampleStatus', 'receivedFlex', 'received', 'notReceived', 'registered']);
    expect(result.events![0]).toEqual({ time: '2026-06-02T18:00:00+02:00', description: 'sampleStatus', provider_code: 'sampleStatus' });
    // The newest status without a stage is the last text; the stage is the newest staged one's.
    expect(result).toMatchObject({ last_status_text: 'sampleStatus', current_stage: 'in_transit' });
  });

  it('keeps statuses of one second in the reply’s order, whichever way it lists them', () => {
    for (const reversed of [false, true]) {
      const result = parseBurd(changed('in-transit', (rows) => {
        const status = (statusType: string) => ({ ...rows[0]!, statusType, created: '2026-06-03T08:00:00Z' });
        rows.unshift(status('deliveryOnTheWay'), status('sampleStatus'));
        if (reversed) rows.reverse();
      }), IN_TRANSIT);
      expect(result.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['deliveryOnTheWay', 'sampleStatus']);
    }
  });

  it('counts a history only when every status names the number asked', () => {
    expect(() => parseBurd(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Burd answered for another parcel' }));
    expect(() => parseBurd(changed('delivered', (rows) => { rows[3]!.barcode = IN_TRANSIT; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads an empty list as no history, not as an unknown number', () => {
    expect(() => parseBurd([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (rows: Row[]) => { rows.length = 0; rows.push('status' as never); },
      (rows: Row[]) => { delete rows[0]!.barcode; },
      (rows: Row[]) => { rows[0]!.barcode = 12345600000000012; },
      (rows: Row[]) => { delete rows[0]!.statusType; },
      (rows: Row[]) => { rows[0]!.statusType = ['delivered']; },
      (rows: Row[]) => { rows[0]!.statusType = 'delivered now'; },
      (rows: Row[]) => { delete rows[0]!.created; },
      (rows: Row[]) => { rows[0]!.created = '2026-03-31T17:48:09'; },
      (rows: Row[]) => { rows[0]!.created = '2026-03-31T17:48:09+02:00'; },
      (rows: Row[]) => { rows[0]!.created = '2026-02-30T17:48:09Z'; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 200 }, () => rows[0]!)); },
    ]) {
      expect(() => parseBurd(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBurd({ events: fixture('delivered') }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(unknownReply())).rejects.toMatchObject({ kind: 'not_found' });
    // A 400 with something in it is not the page's unknown number.
    await expect(lookup(reply({ title: 'One or more validation errors occurred.' }, { status: 400 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply('<html><title>Just a moment...</title></html>', { status: 400 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('', { status: 302, headers: { Location: 'https://burd.dk/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply('<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply('<html><title>Burd Delivery</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      // A rate limit is not asked again.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Burd does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(unknownReply());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-31T17:48:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('012345600000000013')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Burd does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // A failed check digit, seventeen and nineteen digits, letters, and a twenty-digit number not behind `00`.
    for (const number of ['012345600000000013', '01234560000000001', '0123456000000000127', 'SAMPLE000000000012', '10012345600000000012']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    // The tracker takes the SSCC without the GS1 identifier a label prints before it.
    expect(normalizeBurdNumber('(00) 0 1234560 000000001 2')).toBe(DELIVERED);
    expect(normalizeBurdNumber('00012345600000000012')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Burd to the adapter, and claims no SSCC by its shape', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'burd-delivery' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'burd-delivery', source: 'burd-delivery', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(BURD_API))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('burd-delivery');
  });
});

describe('Burd Delivery status vocabulary', () => {
  it('records every status type with the stage and wording the map gives it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(burdWording(entry.code), entry.code).toBe(entry.wording);
      expect(statusMapAnswer({ carrier: 'burd-delivery', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The descriptions API writes the same types in Pascal case.
    expect(burdMappedStage('DeliveryOnTheWay')).toBe('out_for_delivery');
    expect(statusMapAnswer({ carrier: 'burd-delivery', providerCode: 'sampleStatus', description: 'sampleStatus' })).toEqual({ kind: 'unknown' });
  });
});
