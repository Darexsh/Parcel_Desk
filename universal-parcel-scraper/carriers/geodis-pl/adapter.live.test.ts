import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GEODIS Poland live retrieval', () => {
  it.skipIf(!process.env.GEODIS_PL_TRACKING_NUMBER)('retrieves the history of the requested number with providers disabled', async () => {
    const number = process.env.GEODIS_PL_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'geodis-pl' });
    expect(answer).toMatchObject({ carrier: 'geodis-pl', source: 'geodis-pl', attempts: [expect.objectContaining({ source: 'geodis-pl', kind: 'ok' })] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Polish terminals' scans carry Warsaw's offset; a terminal abroad keeps its wall clock.
    expect(answer.result.events.every((event) => event.description && (event.local_time || /\+0[12]:00$/.test(event.time!)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.GEODIS_PL_UNKNOWN_NUMBER)('reads the tracker’s unknown-number answer as not found', async () => {
    await expect(direct().track({ number: process.env.GEODIS_PL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.GEODIS_PL_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
