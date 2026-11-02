import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;

describe('Correo Uruguayo live retrieval', () => {
  it.skipIf(!process.env.CORREO_URUGUAYO_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.CORREO_URUGUAYO_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'correo-uruguayo' });
    expect(answer).toMatchObject({ carrier: 'correo-uruguayo', source: 'correo-uruguayo', attempts: [{ source: 'correo-uruguayo', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.CORREO_URUGUAYO_FILED_NUMBER)('reads an item whose history went to the archive as expired', async () => {
    await expect(direct().track({ number: process.env.CORREO_URUGUAYO_FILED_NUMBER! }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  }, 30_000);

  it.skipIf(!process.env.CORREO_URUGUAYO_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.CORREO_URUGUAYO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CORREO_URUGUAYO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
