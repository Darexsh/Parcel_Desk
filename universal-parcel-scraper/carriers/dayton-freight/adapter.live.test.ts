import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Dayton Freight live retrieval', () => {
  it.skipIf(!process.env.DAYTON_FREIGHT_TRACKING_NUMBER)('retrieves the status of the requested PRO with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DAYTON_FREIGHT_TRACKING_NUMBER!, carrier: 'dayton-freight' });
    expect(answer).toMatchObject({ carrier: 'dayton-freight', source: 'dayton-freight' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dayton-freight', kind: 'ok' });
    expect(answer.result).toMatchObject({ summary_only: true, last_update: null });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event has its wording and a wall clock or a day, never an invented offset.
    expect(answer.result.events.every((event) => event.description && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
    // Nobody is named.
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.DAYTON_FREIGHT_TRACKING_NUMBER)('recognizes the requested PRO', async () => {
    await expect(direct().recognize!(process.env.DAYTON_FREIGHT_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DAYTON_FREIGHT_UNKNOWN_NUMBER)('reads an unknown PRO as not found', async () => {
    await expect(direct().track({ number: process.env.DAYTON_FREIGHT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
