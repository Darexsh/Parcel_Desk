import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GSI Express live retrieval', () => {
  it.skipIf(!process.env.GSI_EXPRESS_TRACKING_NUMBER)('retrieves the milestones of the requested receipt with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GSI_EXPRESS_TRACKING_NUMBER!, carrier: 'gsi-express' });
    expect(answer).toMatchObject({ carrier: 'gsi-express', source: 'gsi-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gsi-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Korean wall clocks, with no offset.
    expect(answer.result.events.every((event) => event.time === undefined
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.description === '출고')).toBe(true);
    expect(answer.result.delivery_tracking_number).toMatch(/^[A-Z\d]+$/);
  }, 45_000);

  it.skipIf(!process.env.GSI_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GSI_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
