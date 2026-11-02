import { describe, expect, it, vi } from 'vitest';
import { adapter, AnterajaTracker, normalizeAnterajaNumber, parseAnteraja } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const NUMBER = '11000000000001';
const fixture = () => ({ status: 200, info: 'OK', content: [{ awb: NUMBER,
  detail: { waybill: NUMBER, service_code: 'REG', final_status: '250', receiver: { name: 'PRIVATE' }, sender: { address: 'PRIVATE' }, weight: 1000 },
  history: [
    { tracking_code: 250, timestamp: '2026-01-03 10:20:30', message: { id: 'Delivery sukses oleh SATRIA dan paket telah diterima oleh PRIVATE.' } },
    { tracking_code: 334, timestamp: '2026-01-03 09:00:00', message: { id: 'Paket tiba di Hub Test City (proses transit).' } },
    { tracking_code: 332, timestamp: '2026-01-03 09:00:00', message: { id: 'Paket menuju ke Hub (proses transit).' } },
  ] }] });

describe('Anteraja guest tracking', () => {
  it('keeps facility history and local clocks without recipient details, preserving tied clocks', () => {
    const result = parseAnteraja(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: '250', service_name: 'REG',
      last_update: null, last_update_local: '2026-01-03T10:20:30' });
    expect(result.events!.map(row => row.provider_code)).toEqual(['250', '334', '332']);
    expect(result.events![1]).toMatchObject({ location: 'Test City', local_time: '2026-01-03T09:00:00', stage: 'in_transit' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.delivered_at).toBeUndefined(); expect(result.weight).toBeUndefined();
  });

  it('does not let a summary or an unknown code invent the latest state', () => {
    const value = fixture(); value.content[0]!.history[0]!.tracking_code = 999;
    const result = parseAnteraja(value, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toMatchObject({ provider_code: '999', description: 'Pembaruan status Anteraja (999)' });
    expect(result.events![0]!.stage).toBeUndefined();
  });

  it('separates absence, empty history, refused access, limits, wrong identity and malformed clocks', () => {
    expect(() => parseAnteraja({ status: 404, info: 'NOT FOUND', content: null }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ status: 404, info: 'route missing' }, { status: 500, content: null }]) {
      expect(() => parseAnteraja(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const status of [401, 403]) expect(() => parseAnteraja({ status }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseAnteraja({ status: 429 }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    const empty = fixture(); empty.content[0]!.history = [];
    expect(() => parseAnteraja(empty, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    const wrong = fixture(); wrong.content[0]!.awb += '0';
    expect(() => parseAnteraja(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const alias = fixture(); alias.content[0]!.detail.waybill += '0';
    expect(() => parseAnteraja(alias, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const badClock = fixture(); badClock.content[0]!.history[0]!.timestamp = '2026-02-31 10:00:00';
    expect(() => parseAnteraja(badClock, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the supplied transport for one whole guest lookup and retains HTTP failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture()));
    await expect(new AnterajaTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anteraja.id/order/tracking');
    expect(JSON.parse(String(init?.body))).toEqual([{ codes: NUMBER }]);
    expect(new Headers(init?.headers).get('source')).toBe('aca_android'); expect(new Headers(init?.headers).get('mv')).toBe('1.2');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    fetcher.mockResolvedValue(new Response('<html>Verification required</html>'));
    await expect(new AnterajaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    fetcher.mockResolvedValue(new Response('unavailable', { status: 404 }));
    await expect(new AnterajaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    fetcher.mockResolvedValue(new Response('slow down', { status: 429 }));
    await expect(new AnterajaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('confirms only a matching shipment over HTTP and rejects unsupported inputs without a request', async () => {
    expect(normalizeAnterajaNumber('1100 0000 0000 01')).toBe(NUMBER);
    for (const number of ['BOOKINGREF', '1100000000000', NUMBER + '0']) expect(() => normalizeAnterajaNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture()));
    const made = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(made.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    fetcher.mockResolvedValue(Response.json({ status: 404, info: 'NOT FOUND', content: null }));
    await expect(made.recognize!(NUMBER)).resolves.toEqual({ known: false });
    const previousCalls = fetcher.mock.calls.length;
    await expect(made.recognize!('NOTANAWB')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(previousCalls);
  });
});
