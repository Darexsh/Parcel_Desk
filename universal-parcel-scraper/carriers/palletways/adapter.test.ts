import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PalletwaysTracker, palletwaysStatusUrl } from './adapter.js';
import { parsePalletways } from './parser.js';
import { palletwaysMappedStage, palletwaysStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '90000000001';
const IN_TRANSIT = '90000000002';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BADGE = "<span class='badge badge-success'>JOB COMPLETE</span>";

describe('Palletways HTTP adapter', () => {
  it('asks the tracking page’s status lookup once, as its page script does, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PalletwaysTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000 0000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://track2.palletways.com/tt_basic.php?dc_syscon=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'X-Requested-With': 'XMLHttpRequest', Referer: 'https://track2.palletways.com/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'palletways', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a completed delivery job as a delivered summary with the consignment’s weight, without the due day or the shipper’s reference', () => {
    const result = parsePalletways(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'JOB COMPLETE', last_update: null, expected_delivery: null, weight_kg: 1500, summary_only: true, events: [] });
    expect(JSON.stringify(result)).not.toMatch(/SYN-REF|2026-03-14/);
    expect(normalizeCarrierResult(result)).toMatchObject({ status: 'delivered', weight_kg: 1500 });
  });

  it('keeps the day an open job is currently due as its expected delivery', () => {
    expect(parsePalletways(fixture('in-transit'), IN_TRANSIT)).toEqual({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'AT HUB', last_update: null, expected_delivery: '2026-03-19',
      weight_kg: 320.5, summary_only: true, events: [] });
    const undated = fixture('in-transit').replace('19/03/2026', '-').replace('1 @ 320.50kg', '1');
    expect(parsePalletways(undated, IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    expect(parsePalletways(undated, IN_TRANSIT).weight_kg).toBeUndefined();
    expect(parsePalletways(fixture('in-transit').replace('19/03/2026', '31/02/2026'), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('stages another badge by the shared wording rules and leaves other kinds of job without a stage', () => {
    const badge = (wording: string, job = 'Delivery') => parsePalletways(fixture('delivered')
      .replace(BADGE, `<span class='badge badge-warning'>${wording}</span>`).replace('(Delivery)', `(${job})`), DELIVERED);
    expect(badge('DELIVERED')).toMatchObject({ status: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = badge('SYNTHETIC STATUS');
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'SYNTHETIC STATUS', expected_delivery: '2026-03-14', summary_only: true });
    expect(unknown.current_stage).toBeUndefined();
    const collection = badge('JOB COMPLETE', 'Collection');
    expect(collection).toMatchObject({ status: 'unknown', last_status_text: 'JOB COMPLETE', expected_delivery: null });
    expect(collection.current_stage).toBeUndefined();
  });

  it('binds the table to the whole tracking ID and keeps another or several consignments inconclusive', () => {
    expect(() => parsePalletways(fixture('delivered'), '90000000009')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const row = /<tr>\s*<td>9[\s\S]*?<\/tr>/.exec(fixture('delivered'))![0];
    const several = fixture('delivered').replace(row, `${row}${row.replace(DELIVERED, '90000000003')}`);
    expect(() => parsePalletways(several, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = fixture('delivered').replace(row, `${row}${row}`);
    expect(() => parsePalletways(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the tracker’s notice as not found and keeps refusals and changed pages apart', () => {
    expect(() => parsePalletways(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePalletways(fixture('not-found').replace('Consignment not found', 'Service unavailable'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePalletways(fixture('refused'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const changed of [
      fixture('delivered').replace('Currently Due', 'Due'),
      fixture('delivered').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>'),
      fixture('delivered').replace(/<td>SYN-REF-0001<\/td>\s*/, ''),
      fixture('delivered').replace(BADGE, ''),
      fixture('delivered').replace(" <span class='text-muted text12'>(Delivery)</span>", ''),
      fixture('delivered').replace(`${DELIVERED} `, ''),
      '<html><body>Track and Trace</body></html>',
      '',
    ]) {
      expect(() => parsePalletways(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([
    ['the not-found notice', page(fixture('not-found')), 'not_found'],
    ['a refusal of the request', page(fixture('refused')), 'challenge'],
    ['a challenge page', page('<html><title>Just a moment...</title></html>'), 'challenge'],
    ['HTTP 403', page('<html>Forbidden</html>', { status: 403 }), 'challenge'],
    ['HTTP 429', page('', { status: 429, headers: { 'Retry-After': '60' } }), 'rate_limited'],
    ['a server error', page('<html>Error</html>', { status: 500 }), 'indeterminate'],
    ['maintenance', page('<html>Down</html>', { status: 503 }), 'maintenance'],
    ['a missing page', page('<html>Not Found</html>', { status: 404 }), 'transport'],
    ['a redirect', page('', { status: 302, headers: { Location: 'https://track2.palletways.com/' } }), 'transport'],
    ['another page', page('<html><body>Track and Trace</body></html>'), 'schema'],
  ] as const)('keeps %s apart from a found consignment', async (_name, response, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response.clone());
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('rejects anything but eleven digits and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['9000000000', '900000000012', '9000000000A', 'PW900000000', '9'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a consignment filed under Palletways to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('in-transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'palletways' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'palletways', source: 'palletways', result: { current_stage: 'in_transit', summary_only: true } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === palletwaysStatusUrl(IN_TRANSIT))).toBe(true);
  });
});

describe('Palletways status vocabulary', () => {
  it('records every badge the map stages, with the stage the map gives it', () => {
    const recorded = statuses.entries.map(entry => normalizeStatusWording(entry.wording));
    expect(new Set(recorded).size).toBe(recorded.length);
    for (const entry of statuses.entries) {
      expect(palletwaysMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(palletwaysStage(entry.wording.toUpperCase())).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
    }
    expect(recorded).toContain('job complete');
    expect(statusMapAnswer({ carrier: 'palletways', providerCode: null, description: 'JOB COMPLETE' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
