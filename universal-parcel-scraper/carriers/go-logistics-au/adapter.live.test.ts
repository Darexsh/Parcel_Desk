import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GO Logistics live retrieval', () => {
  it.skipIf(!process.env.GO_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GO_LOGISTICS_TRACKING_NUMBER!, carrier: 'go-logistics-au' });
    expect(answer).toMatchObject({ carrier: 'go-logistics-au', source: 'go-logistics-au' });
    expect(answer.attempts[0]).toMatchObject({ source: 'go-logistics-au', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and an instant on Sydney's clock, without the signatory.
    expect(answer.result.events.every((event) => event.description && /\+1[01]:00$/.test(String(event.time)))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/Signed by|base64|Driver:/);
  }, 45_000);

  it.skipIf(!process.env.GO_LOGISTICS_TRACKING_NUMBER)('recognizes the requested consignment', async () => {
    await expect(direct().recognize!(process.env.GO_LOGISTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.GO_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GO_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
