import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('99minutos live retrieval', () => {
  it.skipIf(!process.env.NINETYNINEMINUTOS_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const number = process.env.NINETYNINEMINUTOS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: '99minutos' });
    expect(answer).toMatchObject({ carrier: '99minutos', source: '99minutos', attempts: [{ source: '99minutos', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    // Every clock carries an offset.
    expect(answer.result.events.every(event => event.time && event.local_time === undefined && event.description && event.provider_code)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.NINETYNINEMINUTOS_UNKNOWN_NUMBER)('reads the search’s answer for an unknown guía as not found', async () => {
    await expect(direct().track({ number: process.env.NINETYNINEMINUTOS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.NINETYNINEMINUTOS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
