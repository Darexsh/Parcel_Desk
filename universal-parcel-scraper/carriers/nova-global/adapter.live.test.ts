import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Nova Global live retrieval', () => {
  it.skipIf(!process.env.NOVA_GLOBAL_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.NOVA_GLOBAL_TRACKING_NUMBER!, carrier: 'nova-global' });
    expect(answer).toMatchObject({ carrier: 'nova-global', source: 'nova-global' });
    expect(answer.attempts[0]).toMatchObject({ source: 'nova-global', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code)).toBe(true);
    // Ukrainian scans carry Kyiv's offset; every other scan keeps its wall clock.
    for (const event of answer.result.events) {
      if (event.time) expect(event.time, event.description).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/);
      else expect(event.local_time, event.description).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
  }, 45_000);

  it.skipIf(!process.env.NOVA_GLOBAL_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.NOVA_GLOBAL_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.NOVA_GLOBAL_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.NOVA_GLOBAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
