import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('MailAmericas live retrieval', () => {
  it.skipIf(!process.env.MAILAMERICAS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MAILAMERICAS_TRACKING_NUMBER!, carrier: 'mailamericas' });
    expect(answer).toMatchObject({ carrier: 'mailamericas', source: 'mailamericas' });
    expect(answer.attempts[0]).toMatchObject({ source: 'mailamericas', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Each scan has an instant where its leg names its clock, and its wall clock otherwise.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(event.time) && !event.local_time
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.last_update).toBe(answer.result.events[0]!.time ?? null);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.MAILAMERICAS_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.MAILAMERICAS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.MAILAMERICAS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MAILAMERICAS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
