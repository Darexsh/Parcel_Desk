import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const DENMARK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/;

describe('Danske Fragtmænd live retrieval', () => {
  it.skipIf(!process.env.DANSKE_FRAGTMAEND_TRACKING_NUMBER)('retrieves dated scans for the requested consignment with providers disabled', async () => {
    const number = process.env.DANSKE_FRAGTMAEND_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'danske-fragtmaend' });
    expect(answer).toMatchObject({ carrier: 'danske-fragtmaend', source: 'danske-fragtmaend', attempts: [{ source: 'danske-fragtmaend', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && DENMARK.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.DANSKE_FRAGTMAEND_TRACKING_NUMBER)('recognizes the requested parcel by its collicode', async () => {
    const number = process.env.DANSKE_FRAGTMAEND_TRACKING_NUMBER!;
    // Recognition only takes a collicode.
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: /^\d{20}/.test(number) });
  }, 30_000);

  it.skipIf(!process.env.DANSKE_FRAGTMAEND_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DANSKE_FRAGTMAEND_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
