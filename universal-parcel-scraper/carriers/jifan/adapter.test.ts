import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JIFAN_API, JIFAN_PAGE, JifanTracker } from './adapter.js';
import { normalizeJifanNumber, parseJifan } from './parser.js';
import { jifanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = 'JFGJ990000001CN';
const IN_TRANSIT = 'JFGJ990000002CN';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Item[];
const changed = (name: string, change: (item: Item) => void) => {
  const reply = fixture(name);
  change(reply[0]!);
  return reply;
};
// The tracker answers with JSON labelled as an HTML page.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jifan HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JifanTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jfgj 990000-002 cn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${JIFAN_API}?nos=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'Accept-Language': 'zh-CN', Referer: `${JIFAN_PAGE}?nos=${IN_TRANSIT}`, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jifan', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Jifan’s steps in China on Beijing time and stages them by their wording', () => {
    const result = parseJifan(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrival at domestic internationality airport', last_update: '2026-03-19T22:40:05+08:00',
      expected_delivery: null, destination_country: 'MX' });
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-03-19T22:40:05+08:00', 'in_transit'],
      ['2026-03-18T08:15:30+08:00', 'in_transit'],
      ['2026-03-15T21:05:45+08:00', 'accepted'],
      ['2026-03-15T11:30:00+08:00', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/中国|天/);
  });

  it('reads the steps after the flight on Beijing time, with the town and state that open them as their location', () => {
    const place = 'Sample City, Sample State, 00000';
    const result = parseJifan(changed('in-transit', (item) => {
      item.details.unshift(
        { create_time: '2026-03-28 23:43:58', content: `${place} Accepted at logistics carrier Regional Destination Facility` },
        { create_time: '2026-03-25 20:57:51', content: 'Leave the Sample Port processing center' },
        { create_time: '2026-03-24 03:50:50', content: 'Sample Port Import customs clearance' },
      );
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 3).map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-28T23:43:58+08:00', 'Sample City, Sample State', 'Accepted at logistics carrier Regional Destination Facility', 'in_transit'],
      ['2026-03-25T20:57:51+08:00', undefined, 'Leave the Sample Port processing center', 'in_transit'],
      ['2026-03-24T03:50:50+08:00', 'Sample Port', 'Import customs clearance', 'customs'],
    ]);
    expect(JSON.stringify(result)).not.toContain('00000');
  });

  it('reads only the tracker’s unknown-number answer as not found, and binds the reply to the number asked', () => {
    expect(() => parseJifan(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found', provider: 'Jifan' }));
    expect(() => parseJifan(changed('in-transit', (item) => { item.details = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseJifan(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Jifan answered for another shipment' }));
    expect(() => parseJifan(changed('in-transit', (item) => { item.details[0]!.create_time = '2026-03-19 24:00:00'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Jifan returned an invalid scan time' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.szjf56.cn/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>var arg1=\'00\';document.cookie="acw_sc__v2=00"</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>系统发生错误</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    });

  it('rejects numbers Jifan does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JFGJ99000000CN', 'JFGJ9900000012CN', 'JFGJ990000001US', 'SAMPLETRACKING']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJifanNumber('jfgj 990000 002 cn')).toBe(IN_TRANSIT);
  });

  it('sends a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under Jifan, or detected or linked as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'jifan' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jifan', source: 'jifan', result: { current_stage: 'in_transit' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'jifan', source: 'jifan' });
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ carrier: 'jifan', confidence: 'high' });
    expect(parseTrackingInput(`https://www.szjf56.cn/index/tracknumber/track?nos=${IN_TRANSIT}`))
      .toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'jifan', source: 'link' });
    // The page takes any number; the link names Jifan only for one it issues.
    expect(parseTrackingInput('https://www.szjf56.cn/index/tracknumber/track?nos=AB0000000000').carrier).not.toBe('jifan');
  });
});

describe('Jifan status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'jifan', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(jifanStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'jifan', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
