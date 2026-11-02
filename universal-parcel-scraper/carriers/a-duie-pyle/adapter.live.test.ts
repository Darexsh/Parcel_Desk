import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('A. Duie Pyle live retrieval', () => {
  it.skipIf(!process.env.A_DUIE_PYLE_TRACKING_NUMBER)('retrieves the history of the requested PRO with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.A_DUIE_PYLE_TRACKING_NUMBER!, carrier: 'a-duie-pyle' });
    expect(answer).toMatchObject({ carrier: 'a-duie-pyle', source: 'a-duie-pyle' });
    expect(answer.attempts[0]).toMatchObject({ source: 'a-duie-pyle', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and a clock: an instant with its offset, a wall clock or a day.
    expect(answer.result.events.every((event) => event.description
      && (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time))
        || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
    // Nobody is named.
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.A_DUIE_PYLE_TRACKING_NUMBER)('recognizes the requested PRO', async () => {
    await expect(direct().recognize!(process.env.A_DUIE_PYLE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.A_DUIE_PYLE_UNKNOWN_NUMBER)('reads an unknown PRO as not found', async () => {
    await expect(direct().track({ number: process.env.A_DUIE_PYLE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
