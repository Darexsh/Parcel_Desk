import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GMS Worldwide Express live retrieval', () => {
  it.skipIf(!process.env.GMS_WORLDWIDE_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GMS_WORLDWIDE_TRACKING_NUMBER!, carrier: 'gms-worldwide' });
    expect(answer).toMatchObject({ carrier: 'gms-worldwide', source: 'gms-worldwide' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gms-worldwide', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has wording, an instant read on India's clock and the office that recorded it.
    expect(answer.result.events.every((event) => event.description && event.time && event.location)).toBe(true);
    // The consignee's details, references and image links stay out.
    expect(JSON.stringify(answer.result)).not.toMatch(/https?:|amazonaws|\.jpe?g/i);
  }, 45_000);

  it.skipIf(!process.env.GMS_WORLDWIDE_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.GMS_WORLDWIDE_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.GMS_WORLDWIDE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GMS_WORLDWIDE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.GMS_WORLDWIDE_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
