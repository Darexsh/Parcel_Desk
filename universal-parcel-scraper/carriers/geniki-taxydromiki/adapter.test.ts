import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GenikiTracker } from './adapter.js';
import { parseGeniki } from './parser.js';
import { genikiStage, statusMap } from './status.js';

const NUMBER = '8000000017';
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const checkpoints = (value: ReturnType<typeof fixture>) => value[NUMBER].TrackAndTraceResult.Checkpoints.Checkpoint as Record<string, unknown>[];
const reply = (value: ReturnType<typeof fixture>) => value[NUMBER].TrackAndTraceResult as Record<string, unknown>;

describe('Geniki Taxydromiki checkpoints', () => {
  it('reads coded checkpoints newest first on local clocks, without private detail', () => {
    const result = normalizeCarrierResult(parseGeniki(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Shipment Delivered',
      last_update: null, last_update_local: '2026-01-07T11:05:51' });
    expect(result.events).toHaveLength(9);
    expect(result.events?.[0]).toEqual({ description: 'Shipment Delivered', provider_code: 'C_W2', local_time: '2026-01-07T11:05:51',
      location: 'ΔΕΙΓΜΑΤΟΥΠΟΛΗ', stage: 'delivered' });
    expect(result.events?.[1]).toMatchObject({ provider_code: 'C_A3', stage: 'out_for_delivery' });
    expect(result.events?.[3]).toMatchObject({ provider_code: 'C_L1', stage: 'in_transit', location: 'ΠΑΡΑΔΕΙΓΜΑ' });
    // The label scan names the sender, not a place, and its clock loses its fraction of a second.
    expect(result.events?.at(-1)).toEqual({ description: 'Shipment label created/printed', provider_code: 'C_NW',
      local_time: '2026-01-05T10:15:42', stage: 'registered' });
    expect(result.events?.every(event => !('time' in event) && !('point' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|8000000099|RECIPIENT|38\.12345|DeliveryDate|delivered_at/);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.capabilities).toEqual(['history', 'location', 'provider_code']);
    expect(metadata.tracking).toMatchObject({ adapter: 'geniki-taxydromiki', steps: ['direct'], localClocks: true });
  });

  it('reads a collected parcel and a service point registration as accepted', () => {
    const result = parseGeniki(fixture('collected'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Registration of shipment details' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['C_KK', 'accepted'], ['C_K8', 'in_transit'], ['C_W3', 'accepted']]);
  });

  it('hides the last scan of each kind with the scan that cancels it, as the page does', () => {
    const value = fixture();
    const rows = checkpoints(value);
    const routing = rows[5]!;
    rows.splice(6, 0, { ...routing, Status: 'Routing cancelled', StatusCode: 'C_L2', StatusDate: '2026-01-06T09:30:00' });
    rows.splice(3, 0, { ...rows[1], StatusDate: '2026-01-05T18:00:00' }, { ...rows[1], Status: 'Departure cancelled', StatusCode: 'C_K9' });
    const codes = parseGeniki(value, NUMBER).events?.map(event => event.provider_code);
    expect(codes).toEqual(['C_W2', 'C_A3', 'C_A1', 'C_A1', 'C_H2', 'C_H1', 'C_K8', 'C_NW']);
    expect(parseGeniki(value, NUMBER).events?.find(event => event.provider_code === 'C_K8')).toMatchObject({ local_time: '2026-01-05T17:20:11' });
    // A cancellation without the scan it cancels stays, without a stage.
    const unpaired = fixture();
    checkpoints(unpaired).push({ ...routing, Status: 'Routing cancelled', StatusCode: 'C_E2', StatusDate: '2026-01-08T09:00:00' });
    const result = parseGeniki(unpaired, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Routing cancelled' });
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events?.[0]).not.toHaveProperty('stage');
    const cancelledOnly = fixture();
    reply(cancelledOnly).Checkpoints = { Checkpoint: [{ ...routing }, { ...routing, StatusCode: 'C_L2' }] };
    expect(() => parseGeniki(cancelledOnly, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a single checkpoint the web service sends as an object', () => {
    const value = fixture();
    reply(value).Checkpoints = { Checkpoint: checkpoints(value)[0] };
    expect(parseGeniki(value, NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered', events: [{ provider_code: 'C_NW' }] });
  });

  it('keeps an unreadable clock as text, drops placeholder dates and repeated rows', () => {
    const value = fixture();
    const rows = checkpoints(value);
    rows.push({ ...rows.at(-1)! });
    rows.at(-1)!.StatusDate = '2026-02-30T11:05:51';
    const result = parseGeniki(value, NUMBER);
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-02-30T11:05:51' });
    expect(result.events?.[0]).not.toHaveProperty('local_time');
    expect(result.last_update_local).toBeNull();
    expect(result.events).toHaveLength(10);
    rows.at(-1)!.StatusDate = rows.at(-2)!.StatusDate;
    expect(parseGeniki(value, NUMBER).events).toHaveLength(9);
    rows.at(-1)!.StatusDate = '1900-01-01T00:00:00';
    expect(parseGeniki(value, NUMBER).events?.[0]).not.toHaveProperty('provider_time_text');
    expect(parseGeniki(value, NUMBER).events?.[0]).not.toHaveProperty('local_time');
    rows.at(-1)!.StatusDate = 1767780351;
    expect(() => parseGeniki(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('knows an unknown voucher only from the not-found result for the requested number', () => {
    expect(() => parseGeniki(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = { success: true, 8000000025: fixture('not-found')[NUMBER] };
    expect(() => parseGeniki(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const result of [10, 11, 1]) {
      const value = fixture('not-found');
      reply(value).Result = result;
      expect(() => parseGeniki(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const value of [{ success: false, error: 'Missing voucherNo' }, { ...fixture(), invalid_token: true }]) {
      expect(() => parseGeniki(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // A voucher the service found without checkpoints proves neither a parcel nor absence.
    const empty = fixture();
    reply(empty).Checkpoints = {};
    expect(() => parseGeniki(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the reply to the whole voucher and validates its checkpoints', () => {
    for (const value of [{ ...fixture(), 8000000025: fixture()[NUMBER] }, { success: true }, { [NUMBER]: fixture()[NUMBER] },
      { success: 'true', [NUMBER]: fixture()[NUMBER] }, { success: true, [NUMBER]: {} }, null, [], 'voucher']) {
      expect(() => parseGeniki(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const result of [undefined, '0', 0.5]) {
      const value = fixture();
      reply(value).Result = result;
      expect(() => parseGeniki(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const row = checkpoints(fixture())[0]!;
    for (const listed of [null, [], 'C_W2', Array(501).fill(row), [null], [{ ...row, StatusCode: '' }], [{ ...row, StatusCode: 'Delivered' }],
      [{ ...row, StatusCode: ['C_W2'] }], [{ ...row, Status: '' }], [{ ...row, Shop: { name: 'ΔΕΙΓΜΑ' } }]]) {
      const value = fixture();
      reply(value).Checkpoints = listed === null ? null : { Checkpoint: listed };
      const kind = Array.isArray(listed) && listed.length === 0 ? 'indeterminate' : 'schema';
      expect(() => parseGeniki(value, NUMBER), JSON.stringify(listed)?.slice(0, 60)).toThrow(expect.objectContaining({ kind }));
    }
  });

  it('maps codes, not wording', () => {
    expect(genikiStage('toString')).toBeUndefined();
    expect(genikiStage('C_KK')).toBe('accepted');
    expect(genikiStage('C_P1')).toBe('delivered');
    expect(statusMap.stage('C_A3', 'χρέωση σε κούριερ')).toBe('out_for_delivery');
    expect(statusMap.stage(null, 'shipment delivered')).toBeUndefined();
    for (const code of ['C_EA_AG', 'C_E1', 'C_L2', 'C_P4', 'C_S1']) expect(statusMap.stage(code, 'any wording')).toBeUndefined();
    const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')).entries as { code: string; stage?: string }[];
    for (const entry of statuses) expect(genikiStage(entry.code), entry.code).toBe(entry.stage);
  });
});

describe('Geniki Taxydromiki retrieval', () => {
  it("posts the page's anonymous lookup once and recognizes known and unknown vouchers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture()));
    const instance = adapter({ ...environment(fetcher), userAgent: 'ExampleHost/1.0' });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-07T11:05:51' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://taxydromiki.com/external_scripts/track-site.php');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({ lang: 'en', voucherNo: NUMBER });
    const headers = new Headers(init?.headers);
    expect(headers.get('User-Agent')).toBe('ExampleHost/1.0');
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(headers.has('Cookie')).toBe(false);
    fetcher.mockResolvedValueOnce(Response.json(fixture('not-found')));
    await expect(instance.recognize!('8000 0000 17')).resolves.toEqual({ known: false });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ voucherNo: NUMBER });
    fetcher.mockResolvedValueOnce(Response.json({ success: false, error: 'Missing voucherNo' }));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(instance.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
  });

  it.each([[404, 'indeterminate'], [410, 'indeterminate'], [401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'],
    [503, 'maintenance'], [500, 'indeterminate']])('keeps HTTP %s distinct from a missing voucher', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture('not-found'), { status }));
    await expect(new GenikiTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('tells a challenge page, an empty reply and other HTML apart', async () => {
    for (const [body, kind] of [
      ['<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', 'challenge'],
      ['<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></html>', 'challenge'],
      ['', 'indeterminate'],
      ['<html><body>Maintenance</body></html>', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      await expect(new GenikiTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['123', '80000000171', '800000001A', `${NUMBER},8000000025`, '']) {
      await expect(new GenikiTracker({ fetcher: unused }).fetch(number)).rejects.toThrow(InvalidInputError);
    }
    await expect(new GenikiTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return new Response('{}');
    });
    await expect(new GenikiTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new GenikiTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
