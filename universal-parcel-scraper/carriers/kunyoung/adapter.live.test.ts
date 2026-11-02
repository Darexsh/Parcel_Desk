import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Kunyoung Express live retrieval', () => {
  it.skipIf(!process.env.KUNYOUNG_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.KUNYOUNG_TRACKING_NUMBER!, carrier: 'kunyoung' });
    expect(answer).toMatchObject({ carrier: 'kunyoung', source: 'kunyoung' });
    expect(answer.attempts[0]).toMatchObject({ source: 'kunyoung', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its status, its code and an instant read in Korea's zone.
    expect(answer.result.events.every((event) => event.description && /^[A-Z]$/.test(String(event.provider_code))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(event.time)) && event.local_time === undefined)).toBe(true);
    // No site keeps a phone number, and nobody is named.
    expect(answer.result.events.every((event) => !/\d{3,}/.test(event.location ?? ''))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/\*|https?:/);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.KUNYOUNG_TRACKING_NUMBER)('recognizes the requested number', async () => {
    await expect(direct().recognize!(process.env.KUNYOUNG_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.KUNYOUNG_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.KUNYOUNG_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.KUNYOUNG_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
