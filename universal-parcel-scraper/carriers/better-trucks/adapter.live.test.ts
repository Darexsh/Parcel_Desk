import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Better Trucks live retrieval', () => {
  it.skipIf(!process.env.BETTER_TRUCKS_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.BETTER_TRUCKS_TRACKING_NUMBER!, carrier: 'better-trucks' });
    expect(answer).toMatchObject({ carrier: 'better-trucks', source: 'better-trucks' });
    expect(answer.attempts[0]).toMatchObject({ source: 'better-trucks', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant with its offset, and has its wording and code.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
    // Nobody is named and no photo is kept.
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(JSON.stringify(answer.result)).not.toMatch(/storage\.googleapis|ConsigneeName|DropoffLocation/);
  }, 45_000);

  it.skipIf(!process.env.BETTER_TRUCKS_TRACKING_NUMBER)('recognizes the requested number', async () => {
    await expect(direct().recognize!(process.env.BETTER_TRUCKS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.BETTER_TRUCKS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BETTER_TRUCKS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
