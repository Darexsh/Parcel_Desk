import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PCP Express live retrieval', () => {
  it.skipIf(!process.env.PCP_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested AWB with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.PCP_EXPRESS_TRACKING_NUMBER!, carrier: 'pcp-express' });
    expect(answer).toMatchObject({ carrier: 'pcp-express', source: 'pcp-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pcp-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the second, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
    expect(answer.result.events.some((event) => event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PCP_EXPRESS_TRACKING_NUMBER)('recognizes the requested AWB', async () => {
    await expect(direct().recognize!(process.env.PCP_EXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!process.env.PCP_EXPRESS_UNKNOWN_NUMBER)('reads an unknown AWB as not found', async () => {
    await expect(direct().track({ number: process.env.PCP_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
