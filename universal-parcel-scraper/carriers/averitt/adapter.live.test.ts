import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Averitt live retrieval', () => {
  it.skipIf(!process.env.AVERITT_TRACKING_NUMBER)('retrieves dated history for the requested PRO number with providers disabled', async () => {
    const number = process.env.AVERITT_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'averitt' });
    expect(answer).toMatchObject({ carrier: 'averitt', source: 'averitt', attempts: [{ source: 'averitt', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && !event.time)).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.AVERITT_UNKNOWN_NUMBER)('reads the results page’s notice for an unknown PRO number as not found', async () => {
    await expect(direct().track({ number: process.env.AVERITT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.AVERITT_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
