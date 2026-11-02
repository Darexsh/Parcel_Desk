import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { NotFoundError } from '../errors/index.js';
import type { CarrierResult } from '../result/index.js';
import { scrapeUniversalPage } from './browser.js';
import { withLocalBrowser } from './localBrowser.js';

vi.mock('./localBrowser.js', () => ({ withLocalBrowser: vi.fn() }));
const PAGE = 'https://tracking.example/track?id=SYNTHETIC';
const API = 'https://tracking.example/api?id=SYNTHETIC';
const HISTORY: CarrierResult = { status: 'in_transit', last_status_text: 'Synthetic scan', last_update: null, expected_delivery: null, timezone: 'UTC', events: [] };
afterEach(() => vi.clearAllMocks());

/** A page whose navigation brings the given replies to the tracking API. */
function lookup(replies: readonly { status: number; payload: unknown }[], spec: Partial<Parameters<typeof scrapeUniversalPage>[1]> = {}) {
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout: () => {},
    goto: async () => {
      for (const { status, payload } of replies) {
        page.emit('response', { url: () => API, status: () => status, headers: () => ({}), body: async () => Buffer.from(JSON.stringify(payload)) });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return { status: () => 200, headers: () => ({}) };
    },
  });
  const browser = { version: () => '140.0.0.0', newContext: async () => ({ route: async () => {}, newPage: async () => page }) };
  vi.mocked(withLocalBrowser).mockImplementation(async (_options, run) => run({ browser: browser as never, remainingMs: () => 5_000 } as never));
  const parse = vi.fn(() => HISTORY);
  return { parse, result: scrapeUniversalPage({ executablePath: '/test/chromium' }, { name: 'Synthetic', url: PAGE, responseUrl: API, ...spec }, parse) };
}

const missing = (payload: unknown) => (payload as { title?: string }).title === 'No result found' ? new NotFoundError('Synthetic') : undefined;

it('ends the lookup on an error reply the flow names, and parses only successful replies as history', async () => {
  const named = lookup([{ status: 404, payload: { title: 'No result found' } }], { responseErrors: { [API]: missing }, errorStatuses: [404] });
  await expect(named.result).rejects.toBeInstanceOf(NotFoundError);
  expect(named.parse).not.toHaveBeenCalled();
  const unnamed = lookup([{ status: 404, payload: { title: 'Other' } }, { status: 200, payload: {} }], { responseErrors: { [API]: missing }, errorStatuses: [404] });
  await expect(unnamed.result).resolves.toBe(HISTORY);
  expect(unnamed.parse).toHaveBeenCalledOnce();
});

it('leaves error replies alone unless the flow reads their status', async () => {
  const { result, parse } = lookup([{ status: 404, payload: { title: 'No result found' } }, { status: 200, payload: {} }], { responseErrors: { [API]: missing } });
  await expect(result).resolves.toBe(HISTORY);
  expect(parse).toHaveBeenCalledOnce();
});
