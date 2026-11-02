import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, DhlExpressTracker } from './adapter.js';

it('keeps a synthetic waybill unknown or reports an HTTP challenge', async () => {
  const carrier = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
  try { expect(await carrier.recognize!('9876000046', { budgetMs: 10_000 })).toMatchObject({ known: false }); }
  catch (error) { expect(['challenge', 'indeterminate']).toContain(carrierErrorKind(error)); }
});

const liveNumber = process.env.DHL_EXPRESS_LIVE_TRACKING_NUMBER;
const trawlUrl = process.env.TRAWL_URL;
it.skipIf(!liveNumber)('retrieves matching mobile history over HTTP', async () => {
  const carrier = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
  const result = await carrier.track({ number: liveNumber! }, { budgetMs: 10_000 });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.some((event) => event.time ?? event.local_time)).toBe(true);
  expect(await carrier.recognize!(liveNumber!, { budgetMs: 10_000 })).toMatchObject({ known: true });
}, 25_000);
const apiKey = process.env.DHL_API_KEY;
it.skipIf(!liveNumber || !apiKey)('retrieves dated Express history through the tracking API', async () => {
  const tracker = new DhlExpressTracker({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: { DHL_API_KEY: apiKey } });
  const result = await tracker.unified(liveNumber!, { budgetMs: 15_000 });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.events?.some((event) => event.time)).toBe(true);
}, 20_000);
it.skipIf(!liveNumber || !trawlUrl)('retrieves dated Express history through the public tracking page', async () => {
  const carrier = adapter({ trawl: new TrawlClient(trawlUrl!), browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
  const result = await carrier.recognizeWithBrowser!(liveNumber!, { budgetMs: 60_000 });
  expect(result).toMatchObject({ known: true, result: { events: expect.any(Array) } });
  expect(result.lastActivityAt).toBeTruthy();
}, 65_000);
