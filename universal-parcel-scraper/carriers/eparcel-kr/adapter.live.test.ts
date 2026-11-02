import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('eParcel Korea live retrieval', () => {
  it.skipIf(!process.env.EPARCEL_KR_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EPARCEL_KR_TRACKING_NUMBER!, carrier: 'eparcel-kr' });
    expect(answer).toMatchObject({ carrier: 'eparcel-kr', source: 'eparcel-kr' });
    expect(answer.attempts[0]).toMatchObject({ source: 'eparcel-kr', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and either an instant or the page's wall clock.
    expect(answer.result.events.every((event) => event.description && (event.time || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.EPARCEL_KR_TRACKING_NUMBER)('recognizes the requested number', async () => {
    await expect(direct().recognize!(process.env.EPARCEL_KR_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.EPARCEL_KR_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.EPARCEL_KR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.EPARCEL_KR_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
