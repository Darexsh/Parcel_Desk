import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DSV live retrieval', () => {
  it.skipIf(!process.env.DSV_TRACKING_NUMBER)('retrieves dated history for the requested shipment with providers disabled', async () => {
    const number = process.env.DSV_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'dsv' });
    expect(answer).toMatchObject({ carrier: 'dsv', source: 'dsv', attempts: [{ source: 'dsv', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && event.provider_code)).toBe(true);
  });

  it.skipIf(!process.env.DSV_SCHENKER_NUMBER)('retrieves a former DB Schenker shipment bound to the number', async () => {
    const { events = [] } = await direct().track({ number: process.env.DSV_SCHENKER_NUMBER! }, { budgetMs: 60_000 });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => event.local_time && !event.time && event.description && event.provider_code)).toBe(true);
  }, 90_000);

  it.skipIf(!/^[A-Z]{5}\d{9}$/.test(process.env.DSV_SCHENKER_NUMBER?.replace(/\s/g, '').toUpperCase() ?? ''))(
    'recognizes a long former DB Schenker STT within recognition’s three seconds', async () => {
      await expect(direct().recognize!(process.env.DSV_SCHENKER_NUMBER!, { budgetMs: 60_000 })).resolves.toMatchObject({ known: true });
    }, 10_000);

  it.skipIf(!process.env.DSV_UNKNOWN_NUMBER)('leaves a number neither tracker knows open', async () => {
    await expect(direct().track({ number: process.env.DSV_UNKNOWN_NUMBER! }, { budgetMs: 60_000 }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 90_000);
});
