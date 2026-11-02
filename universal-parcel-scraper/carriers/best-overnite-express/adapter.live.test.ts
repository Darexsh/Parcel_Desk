import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Best Overnite Express live retrieval', () => {
  it.skipIf(!process.env.BEST_OVERNITE_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested PRO number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.BEST_OVERNITE_EXPRESS_TRACKING_NUMBER!, carrier: 'best-overnite-express' });
    expect(answer).toMatchObject({ carrier: 'best-overnite-express', source: 'best-overnite-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'best-overnite-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and a clock: an instant with its offset, a wall clock or a day.
    expect(answer.result.events.every((event) => event.description
      && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(event.time))
        || /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time))))).toBe(true);
    // Nobody is named: a delivery's place is who signed, and the status line names them too.
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.events.filter((event) => /^DELIVERED\b/i.test(String(event.description))).every((event) => !event.location)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/signed by|objConsignee|objShipper|addresS/i);
  }, 45_000);

  it.skipIf(!process.env.BEST_OVERNITE_EXPRESS_TRACKING_NUMBER)('recognizes the requested PRO number', async () => {
    await expect(direct().recognize!(process.env.BEST_OVERNITE_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.BEST_OVERNITE_EXPRESS_UNKNOWN_NUMBER)('reads an unknown PRO number as not found', async () => {
    await expect(direct().track({ number: process.env.BEST_OVERNITE_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
