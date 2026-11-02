import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TCC_STATES, TccTracker } from './adapter.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const NUMBER = fixture().remesas.remesa[0].numeroremesa as string;
const reply = (body: unknown = fixture(), status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
function harness(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new TccTracker({ fetcher, recorder, userAgent: 'Synthetic tracking host' }) };
}

describe('TCC native HTTP retrieval', () => {
  it('uses the official secondary request, whole number and visitor appId without CAPTCHA state', async () => {
    const h = harness(reply());
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered', history_truncated: true });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TCC_STATES);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'User-Agent': 'Synthetic tracking host',
      Origin: 'https://tcc.com.co', Referer: 'https://tcc.com.co/rastreo/', appId: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.parse(String(init!.body))).toEqual({ infoadicional: '2', remesas: { numeroremesa: NUMBER } });
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: 'ok' }));
  });

  it('retries only an unread network failure under the same signal/budget', async () => {
    const h = harness(); h.fetcher.mockRejectedValueOnce(new TypeError('Synthetic connection failure')).mockResolvedValueOnce(reply());
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.recorder.step.mock.calls.map(([event]) => [event.step, event.outcome])).toEqual([['direct', 'transport'], ['retry', 'ok']]);
    expect(h.fetcher.mock.calls.every(([, init]) => init!.signal instanceof AbortSignal)).toBe(true);
  });

  it.each([301, 302, 303, 307, 308, 404, 405, 410])('keeps unavailable or redirected route HTTP %s separate from a missing parcel', async status => {
    const h = harness(reply('SYNTHETIC PRIVATE', status));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('preserves a tracking refusal (%s) without the response body', async status => {
    const h = harness(reply('SYNTHETIC PRIVATE', status));
    let error: unknown; try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'challenge', status });
    expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain('SYNTHETIC PRIVATE');
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves rate limits and their retry window without raw observations', async () => {
    const h = harness(reply('SYNTHETIC PRIVATE OBSERVATION', 429, { 'retry-after': '9' }));
    let error: unknown; try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 9000 });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC PRIVATE');
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([reply({ respuesta: { codigo: '0' }, remesas: null }), reply('<html>Changed page</html>'), reply('<html><title>Just a moment...</title></html>')])('does not retry an empty, malformed or blocked reply', async response => {
    const h = harness(response);
    await expect(h.tracker.fetch(NUMBER)).rejects.toHaveProperty('kind', expect.stringMatching(/^(indeterminate|schema|challenge)$/));
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('starts nothing for cancelled or invalid input', async () => {
    const h = harness(); const controller = new AbortController(); controller.abort(new Error('Caller cancelled'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Caller cancelled');
    await expect(h.tracker.fetch(`${NUMBER}7`)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('uses only the supplied HTTP transport even when a browser is configured', async () => {
    const h = harness(reply());
    const native = adapter({ fetcher: h.fetcher, userAgent: 'Synthetic tracking host', recorder: h.recorder, env: {}, trawl: null, browserExecutablePath: null });
    expect(native.recognize).toBeUndefined();
    expect(native.steps).toEqual(['direct', 'retry']);
    await expect(native.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
});
