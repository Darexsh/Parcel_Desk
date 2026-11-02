import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('anc-delivers live retrieval', () => {
  it.skipIf(!process.env.ANC_DELIVERS_TRACKING_NUMBER)('reads the requested delivery\'s steps with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ANC_DELIVERS_TRACKING_NUMBER!, carrier: 'anc-delivers' });
    expect(answer).toMatchObject({ carrier: 'anc-delivers', source: 'anc-delivers' });
    expect(answer.attempts[0]).toMatchObject({ source: 'anc-delivers', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    for (const event of answer.result.events) expect(event.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  }, 45_000);

  it.skipIf(!process.env.ANC_DELIVERS_TRACKING_NUMBER)('recognizes the requested delivery', async () => {
    await expect(direct().recognize!(process.env.ANC_DELIVERS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.ANC_DELIVERS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ANC_DELIVERS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
