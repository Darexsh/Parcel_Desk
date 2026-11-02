import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Easy Mail live retrieval', () => {
  it.skipIf(!process.env.EASY_MAIL_TRACKING_NUMBER)('retrieves the history of the requested voucher with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.EASY_MAIL_TRACKING_NUMBER!, carrier: 'easy-mail' });
    expect(answer).toMatchObject({ carrier: 'easy-mail', source: 'easy-mail' });
    expect(answer.attempts[0]).toMatchObject({ source: 'easy-mail', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is a Greek wall clock read as an instant, to the second.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/\*{3}|Τηλέφωνο|Διεύθυνση|store\//);
  }, 45_000);

  it.skipIf(!process.env.EASY_MAIL_TRACKING_NUMBER)('reads the twelve-digit form the tracker prints as the same voucher', async () => {
    const voucher = process.env.EASY_MAIL_TRACKING_NUMBER!.replace(/^0/, '');
    await expect(direct().track({ number: `0${voucher}` })).resolves.toMatchObject({ events: expect.arrayContaining([expect.anything()]) });
  }, 30_000);

  it.skipIf(!process.env.EASY_MAIL_UNKNOWN_NUMBER)('reads an unknown voucher as not found', async () => {
    await expect(direct().track({ number: process.env.EASY_MAIL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
