import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ShipGlobal India live guest retrieval', () => {
  it.skipIf(!process.env.SHIPGLOBAL_IN_TRACKING_NUMBER)('retrieves identity-bound dated history without providers', async () => {
    const fetched = await createTracker({ providers: [] }).track({ number: process.env.SHIPGLOBAL_IN_TRACKING_NUMBER!, carrier: 'shipglobal-in' });
    expect(fetched).toMatchObject({ carrier: 'shipglobal-in', source: 'shipglobal-in' });
    expect(fetched.attempts[0]).toMatchObject({ source: 'shipglobal-in', kind: 'ok' });
    const answer = fetched.result;
    expect(answer.events.length).toBeGreaterThan(0);
    expect(answer.events.some((event) => event.time || event.local_time)).toBe(true);
    expect(answer.events.every((event) => typeof event.description === 'string' && event.description.length > 0)).toBe(true);
    expect(answer).not.toHaveProperty('receiver_name');
    expect(answer).not.toHaveProperty('sender_name');
    expect(JSON.stringify(answer)).not.toMatch(/partnerLastMileTrackingUrl|awbPostCode|awbReceiverName|awbSenderName|vendorId|dispatchBagCode/);
  }, 25_000);

  it.skipIf(!process.env.SHIPGLOBAL_IN_TRACKING_NUMBER)('confirms the dated history over HTTP', async () => {
    const answer = await direct().recognize!(process.env.SHIPGLOBAL_IN_TRACKING_NUMBER!);
    expect(answer.known).toBe(true);
    expect(answer.lastActivityAt || answer.lastActivityLocal).toBeTruthy();
  }, 25_000);

  it.skipIf(!process.env.SHIPGLOBAL_IN_UNKNOWN_NUMBER)('reads the explicit unknown-number reply', async () => {
    await expect(direct().track({ number: process.env.SHIPGLOBAL_IN_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 25_000);
});
