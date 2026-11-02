import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, UniuniTracker } from './adapter.js';
import { estimateKey, estimateScripts, parseUniuniEstimate } from './estimate.js';

const NUMBER = 'UUS0000000000000001';
const estimate = () => JSON.parse(readFileSync(new URL('./fixtures/estimate.json', import.meta.url), 'utf8'));
const active = () => {
  const value = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
  const scans = value.data.valid_tno[0].spath_list;
  scans.splice(scans.length - 1);
  return value;
};
const PAGE = 'https://www.uniuni.com/tracking/';
const BUNDLE = 'https://www.uniuni.com/_next/static/chunks/tracking.js';
const ENDPOINT = 'https://sj.uniexpress.ca/version2/orders/edd_information';
// Synthetic runtime configuration; no carrier credential is present in fixtures.
const KEY = 'SYNTHETICPUBLICCONFIGURATION';
const page = '<script src="/_next/static/chunks/tracking.js"></script>';
const bundle = `client.post("${ENDPOINT}",{key:"${KEY}",tnos:references})`;

describe('UniUni estimate projection', () => {
  it('preserves a full window using its own explicit zone, without changing scan clocks', () => {
    expect(parseUniuniEstimate(estimate(), NUMBER)).toEqual({ expected_delivery_from: '2026-01-06T09:00:00-05:00', expected_delivery: '2026-01-06T21:00:00-05:00' });
    const value = estimate(); delete value.data[0].delivery_estimate.timezone;
    expect(parseUniuniEstimate(value, NUMBER)).toEqual({ expected_delivery_from: '2026-01-06T09:00:00', expected_delivery: '2026-01-06T21:00:00' });
  });

  it.each(['', undefined, '25:00:00', '09:00', 'bad'])('keeps date precision when a complete valid window is absent (%s)', clock => {
    const value = estimate(); value.data[0].delivery_estimate.estimated_delivery_time_start = clock;
    expect(parseUniuniEstimate(value, NUMBER)).toEqual({ expected_delivery: '2026-01-06' });
  });

  it('retains unresolved DST clocks instead of choosing an offset or shifting their digits', () => {
    const value = estimate(); const item = value.data[0].delivery_estimate;
    Object.assign(item, { estimated_delivery_date: '2026-11-01', estimated_delivery_time_start: '01:00:00', estimated_delivery_time_end: '01:30:00' });
    expect(parseUniuniEstimate(value, NUMBER)).toEqual({ expected_delivery_from: '2026-11-01T01:00:00', expected_delivery: '2026-11-01T01:30:00' });
    Object.assign(item, { estimated_delivery_date: '2026-03-08', estimated_delivery_time_start: '02:00:00', estimated_delivery_time_end: '02:30:00' });
    expect(parseUniuniEstimate(value, NUMBER)).toEqual({ expected_delivery_from: '2026-03-08T02:00:00', expected_delivery: '2026-03-08T02:30:00' });
  });

  it('excludes disabled, empty and invalid estimates and rejects different or duplicate identities', () => {
    for (const enabled of [false, 'true', 1]) {
      const value = estimate(); value.data[0].edd_enabled = enabled;
      expect(parseUniuniEstimate(value, NUMBER)).toEqual({});
    }
    const empty = estimate(); empty.data[0].delivery_estimate = null;
    expect(parseUniuniEstimate(empty, NUMBER)).toEqual({});
    for (const day of ['2026-02-30', '0000-00-00', '2026-01-06T00:00:00Z', { day: '2026-01-06' }]) {
      const value = estimate(); value.data[0].delivery_estimate.estimated_delivery_date = day;
      expect(parseUniuniEstimate(value, NUMBER)).toEqual({});
    }
    const backwards = estimate(); backwards.data[0].delivery_estimate.estimated_delivery_time_start = '22:00:00';
    expect(parseUniuniEstimate(backwards, NUMBER)).toEqual({ expected_delivery: '2026-01-06' });
    for (const mutate of [
      (value: ReturnType<typeof estimate>) => { value.data[0].tno = `${NUMBER}OTHER`; },
      (value: ReturnType<typeof estimate>) => { value.data.push(value.data[0]); },
      (value: ReturnType<typeof estimate>) => { value.data = []; },
    ]) {
      const value = estimate(); mutate(value);
      expect(() => parseUniuniEstimate(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('UniUni optional estimate retrieval', () => {
  const responses = (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    return url === PAGE ? new Response(page) : url === BUNDLE ? new Response(bundle)
      : url === ENDPOINT ? Response.json(estimate()) : Response.json(active());
  };

  it('discovers public configuration cold, caches it warm and binds the estimate to history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => responses(input));
    const tracker = new UniuniTracker({ fetcher, userAgent: 'Synthetic host' });
    const result = await tracker.fetch(NUMBER);
    expect(result).toMatchObject({ expected_delivery_from: '2026-01-06T09:00:00-05:00', expected_delivery: '2026-01-06T21:00:00-05:00' });
    expect(result.events).toEqual((await tracker.fetch(NUMBER, {}, false)).events);
    await tracker.fetch(NUMBER);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === PAGE)).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === ENDPOINT)).toHaveLength(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('User-Agent')).toBe('Synthetic host');
      if (String(url) === ENDPOINT) expect(JSON.parse(String(init?.body))).toEqual({ key: KEY, tnos: [NUMBER] });
    }
    expect(estimateKey(bundle)).toBe(KEY);
    expect(estimateKey(bundle + bundle)).toBeNull();
    expect(estimateScripts(page + '<script src="https://outside.example/private.js"></script>')).toEqual([BUNDLE]);
  });

  it.each([401, 403])('rediscovers configuration after HTTP %s rejects the key', async status => {
    let rejected = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      if (String(input) === ENDPOINT && !rejected) { rejected = true; return new Response('Rejected', { status }); }
      return responses(input);
    });
    const tracker = new UniuniTracker({ fetcher });
    expect((await tracker.fetch(NUMBER)).expected_delivery).toBeNull();
    expect((await tracker.fetch(NUMBER)).expected_delivery).toBeTruthy();
    expect(fetcher.mock.calls.filter(([url]) => String(url) === PAGE)).toHaveLength(2);
  });

  it('skips enrichment for recognition, delivered and returned histories', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(active()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(instance.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const terminal = active(); terminal.data.valid_tno[0].spath_list.at(-1).state = 230;
    fetcher.mockResolvedValue(Response.json(terminal));
    expect((await instance.track({ number: NUMBER })).current_stage).toBe('returned');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([404, 429, 503])('preserves history after optional service HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => String(input) === ENDPOINT ? new Response('Unavailable', { status }) : responses(input));
    const tracker = new UniuniTracker({ fetcher });
    const result = await tracker.fetch(NUMBER);
    expect(result).toEqual(await tracker.fetch(NUMBER, {}, false));
  });

  it.each(['{}', '<html>Unavailable</html>', JSON.stringify({ status: 'SUCCESS', data: [{ tno: 'UUS0000000000000002', edd_enabled: true }] })])(
    'preserves history after an unusable estimate response', async body => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => String(input) === ENDPOINT ? new Response(body) : responses(input));
      const tracker = new UniuniTracker({ fetcher });
      expect(await tracker.fetch(NUMBER)).toEqual(await tracker.fetch(NUMBER, {}, false));
    },
  );

  it('preserves history when enrichment stalls and propagates caller cancellation', async () => {
    const stalled = (init: RequestInit | undefined) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => String(input) === PAGE ? stalled(init) : responses(input));
    const tracker = new UniuniTracker({ fetcher });
    await expect(tracker.fetch(NUMBER, { budgetMs: 800 })).resolves.toMatchObject({ expected_delivery: null });
    const controller = new AbortController();
    const task = tracker.fetch(NUMBER, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    controller.abort(new Error('Synthetic cancellation'));
    await expect(task).rejects.toThrow('Synthetic cancellation');
  });
});
