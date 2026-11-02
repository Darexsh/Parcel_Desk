import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TopYou live retrieval', () => {
  it.skipIf(!process.env.TOPYOU_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [], trawlUrl: process.env.FLARESOLVERR_URL }).track({ number: process.env.TOPYOU_TRACKING_NUMBER!, carrier: 'topyou' });
    expect(answer).toMatchObject({ carrier: 'topyou', source: 'topyou' });
    expect(answer.attempts[0]).toMatchObject({ source: 'topyou', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && (event.time || event.local_time))).toBe(true);
    // TopYou's own first-mile scan states its offset.
    expect(answer.result.events.some((event) => event.time?.endsWith('+08:00'))).toBe(true);
  }, 60_000);

  it.skipIf(!process.env.TOPYOU_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.TOPYOU_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.TOPYOU_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.TOPYOU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
