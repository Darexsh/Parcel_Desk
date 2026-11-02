import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, STAREX_API, StarexTracker } from './adapter.js';
import { normalizeStarexNumber, parseStarex } from './parser.js';
import { starexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'STRAZ123456789000';
const IN_TRANSIT = 'STRAZ000123456789';
const UNKNOWN = 'STRAZ000000000000';
const FORMER = 'STR123456789';

type Scan = Record<string, unknown>;
type Reply = { data: Scan[]; package?: unknown; user?: unknown };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (scans: Scan[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
// The API's answer for a number it does not know, and for any number asked from outside its site.
const absent = () => reply('{\n    "message": ""\n}', { status: 404 });
const refused = () => reply('{\n    "message": "Not found"\n}', { status: 404 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Starex HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, as the site, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new StarexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' straz000-123-456-789 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${STAREX_API}${IN_TRANSIT}/history`);
    expect(String(url)).toBe('https://api.starexglobal.com/api/v1/starex/packages/STRAZ000123456789/history');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Accept-Language': 'en', Referer: 'https://starexglobal.com/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'starex-az', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel collected at a branch as wall clocks, newest first, without the recipient’s details', () => {
    const result = normalizeCarrierResult(parseStarex(fixture('delivered'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered: The package has been successfully delivered', last_update: null,
      last_update_local: '2026-09-18T16:05:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-09-18T16:05:00', 'delivered', 'delivered'],
      ['2026-09-17T11:20:00', 'ready_for_pickup', 'ready_for_pickup'],
      ['2026-09-17T06:40:00', 'in_transit', 'in_transit'],
      // Two scans on one clock keep the reply's order.
      ['2026-09-16T14:10:00', 'sorting', 'in_transit'],
      ['2026-09-16T14:10:00', 'import_customs_released', 'customs'],
      ['2026-09-12T09:30:00', 'import_customs_hold', 'customs'],
      ['2026-09-10T08:15:00', 'accepted_at_terminal', 'customs'],
      ['2026-09-08T11:00:00', 'waiting_for_arrival', 'in_transit'],
      ['2026-09-07T16:20:00', 'export_customs_clearance', 'customs'],
      ['2026-09-05T22:50:00', 'accepted_at_facility', 'accepted'],
      ['2026-09-01T07:45:00', 'waiting_for_delivery', 'registered'],
    ]);
    expect(result.events![1]!.description).toBe('Ready for Pickup: The package is ready for pickup at the branch.');
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map' && !event.location)).toBe(true);
    // The recipient's masked name, phone and code, their branch and the shop's order number stay out.
    expect(JSON.stringify(result)).not.toMatch(/Te\*\*|\*{5}0000|0\*{6}|Sample|0{16}/);
    expect(result).not.toHaveProperty('pickup_point');
  });

  it('reads a parcel held at customs until its declaration came, now on its way to the pickup point', () => {
    const result = parseStarex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-09-24T05:30:00',
      last_status_text: 'In Transit: The package is on its way to the pickup point.' });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['in_transit', 'in_transit'], ['sorting', 'in_transit'], ['import_customs_released', 'customs'], ['import_customs_hold', 'customs'],
      ['waiting_for_declaration', 'customs'], ['import_customs_hold', 'customs'], ['accepted_at_terminal', 'customs'],
      ['waiting_for_arrival', 'in_transit'], ['waiting_for_delivery', 'registered'], ['waiting_for_confirmation', 'registered'],
    ]);
    // One code carries the review, the missing declaration and the hold apart by its wording.
    expect(result.events![3]!.description).toBe('Under Customs Review: The package is currently under customs review.');
    expect(result.events![5]!.description).toBe('Customs Declaration Required: No customs declaration has been submitted for the package.');
  });

  it('sorts the scans newest first as the page does, and drops a repeated scan', () => {
    const shuffled = changed('delivered', (scans) => { scans.reverse(); scans.push({ ...scans[0]! }); });
    const result = parseStarex(shuffled, DELIVERED);
    expect(result.events).toHaveLength(11);
    expect(result.events!.map((event) => event.provider_code).slice(0, 2)).toEqual(['delivered', 'ready_for_pickup']);
    // Scans on one clock keep the carrier's order, whichever way the reply lists them.
    expect(result.events!.map((event) => event.provider_code).slice(3, 5)).toEqual(['sorting', 'import_customs_released']);
  });

  it('reads the courier route, a failed attempt and a return', () => {
    const result = parseStarex(changed('in-transit', (scans) => {
      scans.unshift(
        { status: 'undelivered', name: 'Undelivered', description: null, date: '25-09-2026 15:00' },
        { status: 'out_for_delivery', name: 'Out for Delivery', description: 'The package is on its way to the delivery address.', date: '25-09-2026 10:10' },
        { status: 'picked_up_by_courier', name: 'Picked up by courier', description: 'The package has been picked up by the courier', date: '25-09-2026 10:10' },
        { status: 'handed_over_to_the_courier', name: 'Handed over to courier', description: 'The package has been handed over to the courier', date: '25-09-2026 10:00' },
      );
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Undelivered' });
    expect(result.events!.slice(0, 4).map((event) => event.stage)).toEqual(['failed_attempt', 'out_for_delivery', 'out_for_delivery', 'out_for_delivery']);
    const returned = parseStarex(changed('in-transit', (scans) => {
      scans.unshift({ status: 'delivered_to_return_facility', name: 'Satıcıya geri qaytarıldı.', description: '', date: '30-09-2026 12:00' });
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Satıcıya geri qaytarıldı.' });
  });

  it('leaves the stage to the scan before a delay notice, and reads a code it does not know by its wording', () => {
    const delayed = parseStarex(changed('in-transit', (scans) => {
      scans.unshift({ status: 'delivery_delayed', name: 'Delivery delayed', description: '', date: '25-09-2026 09:00' });
    }), IN_TRANSIT);
    expect(delayed.events![0]).toEqual({ local_time: '2026-09-25T09:00:00', description: 'Delivery delayed', provider_code: 'delivery_delayed' });
    expect(delayed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Delivery delayed' });
    const worded = parseStarex(changed('in-transit', (scans) => {
      scans.unshift({ status: 'synthetic_status', name: 'Delivered', description: 'The package has been delivered to the recipient', date: '25-09-2026 09:00' });
    }), IN_TRANSIT);
    expect(worded.events![0]).toMatchObject({ provider_code: 'synthetic_status', stage: 'delivered', stage_source: expect.stringMatching(/^wording/) });
  });

  it('reads a reply without scans as no history', () => {
    expect(() => parseStarex(changed('in-transit', (_scans, body) => { body.data = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_scans: Scan[], body: Reply) => { delete (body as Partial<Reply>).data; },
      (_scans: Scan[], body: Reply) => { body.data = 'scans' as never; },
      (scans: Scan[]) => { scans.push(...Array.from({ length: 200 }, (_, index) => ({ ...scans[0]!, date: `01-01-2026 ${String(index % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}` }))); },
      (scans: Scan[]) => { scans[0] = 'scan' as never; },
      (scans: Scan[]) => { delete scans[0]!.status; },
      (scans: Scan[]) => { scans[0]!.status = 'In Transit'; },
      (scans: Scan[]) => { scans[0]!.status = 7; },
      (scans: Scan[]) => { delete scans[0]!.date; },
      (scans: Scan[]) => { scans[0]!.date = 1790000000; },
      (scans: Scan[]) => { scans[0]!.date = '2026-09-24 05:30'; },
      (scans: Scan[]) => { scans[0]!.date = '24-09-2026 05:30:00'; },
      (scans: Scan[]) => { scans[0]!.date = '31-09-2026 05:30'; },
      (scans: Scan[]) => { scans[0]!.date = '24-09-2026 25:30'; },
      (scans: Scan[]) => { scans[0]!.name = { en: 'In Transit' }; },
      (scans: Scan[]) => { scans[0]!.description = 'x'.repeat(501); },
      (scans: Scan[]) => { scans[0]!.name = ''; scans[0]!.description = null; },
    ]) {
      expect(() => parseStarex(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the API’s empty message as not found, and recognizes by the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(absent())).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(absent())).track({ number: FORMER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(absent())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A local clock dates the last activity without an instant.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-18T16:05:00' });
  });

  it('keeps an unknown number, a refusal, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    // The API says "Not found" for every number asked without the site's Referer: a refusal, not a missing parcel.
    await expect(lookup(refused())).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(refused())).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply({ message: 'The route api/v1/starex/packages/STRAZ000000000000/history could not be found.' }, { status: 404 })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('<html><body>Not Found</body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply({ message: '' }, { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply({ message: 'Forbidden' }, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A browser check, even with HTTP 200 or 404, is never a missing parcel.
    await expect(lookup(new Response(CHECK, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response(CHECK, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Starex</title></html>', { status: 200 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply({ message: '' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('refuses a redirect, which would answer for another path than the requested number’s', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302,
      headers: { Location: `${STAREX_API}${DELIVERED}/history` } }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${STAREX_API}${IN_TRANSIT}/history`);
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      // An HTTP status is never sent again.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a lookup that does not reach the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new StarexTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses numbers Starex does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['STRAZ00000000000', 'STRAZ0000000000000', 'STRUZ000000000000', 'STR00000000', 'STR0000000000',
      'STRAZ00000000000A', '123456789000', 'STRAZ000000000000/../1', `STRAZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeStarexNumber(' str 123.456.789 ')).toBe(FORMER);
  });

  it('routes a number filed under Starex to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(STAREX_API)
      ? reply(fixture('in-transit')) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'starex-az' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'starex-az', source: 'starex-az', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${STAREX_API}${IN_TRANSIT}/history`)).toBe(true);
  });
});

describe('Starex status vocabulary', () => {
  it('records every status code the map knows with the stage it gives, and the codes it leaves out on purpose', () => {
    const entries = statuses.entries as { code: string; wording: string; stage?: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      if (entry.stage) expect(starexStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      else expect(statusMap.gaps.some((gap) => gap.code === entry.code), entry.code).toBe(true);
    }
    expect(statusMapAnswer({ carrier: 'starex-az', providerCode: 'import_customs_hold', description: 'Customs Hold' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'starex-az', providerCode: 'delivery_delayed', description: 'Delivery delayed' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(statusMapAnswer({ carrier: 'starex-az', providerCode: 'synthetic_status', description: 'Synthetic' })).toEqual({ kind: 'unknown' });
  });
});
