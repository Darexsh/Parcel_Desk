import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Chit Chats live retrieval', () => {
  it.skipIf(!process.env.CHIT_CHATS_TRACKING_NUMBER)('retrieves dated history for the requested shipment with providers disabled', async () => {
    const number = process.env.CHIT_CHATS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'chit-chats' });
    expect(answer).toMatchObject({ carrier: 'chit-chats', source: 'chit-chats' });
    // The partner carrier can be asked after it, to confirm the hand-off.
    expect(answer.attempts[0]).toMatchObject({ source: 'chit-chats', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => (event.time || event.local_time) && event.description)).toBe(true);
    // Chit Chats' own label scan is the oldest and keeps its offset.
    expect(answer.result.events.some(event => event.time)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CHIT_CHATS_UNKNOWN_NUMBER)('reads the search page notice for an unknown shipment ID as not found', async () => {
    await expect(direct().track({ number: process.env.CHIT_CHATS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CHIT_CHATS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
