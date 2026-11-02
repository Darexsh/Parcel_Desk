import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Egypt Post live retrieval', () => {
  it.skipIf(!process.env.EGYPT_POST_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.EGYPT_POST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'egypt-post' });
    expect(answer).toMatchObject({ carrier: 'egypt-post', source: 'egypt-post', attempts: [{ source: 'egypt-post', kind: 'ok' }],
      result: { history_truncated: true } });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.EGYPT_POST_INBOUND_NUMBER)('retrieves the scans of mail from abroad', async () => {
    const result = await direct().track({ number: process.env.EGYPT_POST_INBOUND_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!process.env.EGYPT_POST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.EGYPT_POST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.EGYPT_POST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
