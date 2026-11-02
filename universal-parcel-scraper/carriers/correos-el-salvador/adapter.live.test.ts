import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Correos de El Salvador live retrieval', () => {
  it.skipIf(!process.env.CORREOS_EL_SALVADOR_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.CORREOS_EL_SALVADOR_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'correos-el-salvador' });
    expect(answer).toMatchObject({ carrier: 'correos-el-salvador', source: 'correos-el-salvador', attempts: [{ source: 'correos-el-salvador', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock, without an offset, and names its office.
    expect(answer.result.events.every((event) => event.description && event.location && !event.time && WALL_CLOCK.test(String(event.local_time))))
      .toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.CORREOS_EL_SALVADOR_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.CORREOS_EL_SALVADOR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.CORREOS_EL_SALVADOR_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
