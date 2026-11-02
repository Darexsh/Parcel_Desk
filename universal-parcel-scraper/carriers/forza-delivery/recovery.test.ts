import { afterEach, expect, it, vi } from 'vitest';
import { ChallengeError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { fetchForzaInBrowser } from './browser.js';

vi.mock('./browser.js', () => ({ fetchForzaInBrowser: vi.fn() }));
const number = 'FD0000001';
function tracker(configured = true, status = 403) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('blocked', { status }));
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { recorder, fetcher, carrier: adapter({ fetcher, recorder, env: configured ? { FORZA_DELIVERY_BROWSER_WS_ENDPOINT: 'ws://browser.test/synthetic' } : {},
    trawl: null, browserExecutablePath: null }) };
}
afterEach(() => { vi.clearAllMocks(); });

it('recovers a direct challenge inside the supplied budget and preserves its provenance', async () => {
  const h = tracker(); vi.mocked(fetchForzaInBrowser).mockResolvedValue({ status: 'delivered', last_status_text: 'Delivered', last_update: null, expected_delivery: null, events: [] });
  await expect(h.carrier.track({ number }, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'delivered' });
  expect(h.fetcher).toHaveBeenCalledOnce();
  expect(fetchForzaInBrowser).toHaveBeenCalledWith(number, 'ws://browser.test/synthetic', expect.any(AbortSignal), expect.any(Number));
  expect(vi.mocked(fetchForzaInBrowser).mock.calls[0]![3]).toBeLessThanOrEqual(2000);
  expect(h.recorder.step.mock.calls.map(([r]) => [r.step, r.outcome])).toEqual([['direct', 'challenge'], ['browser', 'ok']]);
  expect(h.recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ fallbackFrom: 'direct', fallbackReason: 'challenge' }));
});

it('keeps recognition HTTP-only even when the browser is configured', async () => {
  const h = tracker();
  await expect(h.carrier.recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
  expect(fetchForzaInBrowser).not.toHaveBeenCalled();
});

it('keeps the challenge when browser recovery is absent or fails', async () => {
  await expect(tracker(false).carrier.track({ number })).rejects.toMatchObject({ kind: 'challenge' });
  expect(fetchForzaInBrowser).not.toHaveBeenCalled();
  vi.mocked(fetchForzaInBrowser).mockRejectedValue(new ChallengeError('Forza Delivery'));
  await expect(tracker().carrier.track({ number })).rejects.toMatchObject({ kind: 'challenge' });
});

it('does not use a browser to retry rate limits or missing routes', async () => {
  for (const status of [429, 404]) await expect(tracker(true, status).carrier.track({ number })).rejects.toBeDefined();
  expect(fetchForzaInBrowser).not.toHaveBeenCalled();
});

it('starts neither transport after cancellation', async () => {
  const h = tracker(), controller = new AbortController(); controller.abort();
  await expect(h.carrier.track({ number }, { signal: controller.signal })).rejects.toBeDefined();
  expect(h.fetcher).not.toHaveBeenCalled(); expect(fetchForzaInBrowser).not.toHaveBeenCalled();
});
