import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Metropolitan Warehouse live retrieval', () => {
  it.skipIf(!process.env.METROPOLITAN_WAREHOUSE_TRACKING_NUMBER)('retrieves the requested order with providers disabled', async () => {
    const number = process.env.METROPOLITAN_WAREHOUSE_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'metropolitan-warehouse' });
    expect(answer).toMatchObject({ carrier: 'metropolitan-warehouse', source: 'metropolitan-warehouse' });
    expect(answer.attempts[0]).toMatchObject({ source: 'metropolitan-warehouse', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps the page's wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && (event.local_time === undefined || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toEqual({ known: true, lastActivityAt: null });
  }, 45_000);

  it.skipIf(!process.env.METROPOLITAN_WAREHOUSE_UNKNOWN_NUMBER)('reads a number the tracker does not hold as missing', async () => {
    await expect(direct().track({ number: process.env.METROPOLITAN_WAREHOUSE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.METROPOLITAN_WAREHOUSE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
