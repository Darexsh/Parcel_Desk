import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Envía live retrieval', () => {
  it.skipIf(!process.env.ENVIA_COLOMBIA_TRACKING_NUMBER)('retrieves the history of the requested guía with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ENVIA_COLOMBIA_TRACKING_NUMBER!, carrier: 'envia-colombia' },
      { budgetMs: 40_000 });
    expect(answer).toMatchObject({ carrier: 'envia-colombia', source: 'envia-colombia' });
    expect(answer.attempts[0]).toMatchObject({ source: 'envia-colombia', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.current_stage).toBeTruthy();
    // Every scan has wording, and a clock in Bogotá time or a date; no phone number reaches the result.
    expect(answer.result.events.every((event) => event.description
      && (/-05:00$/.test(String(event.time)) || /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time))))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/\b3\d{9}\b/);
  }, 60_000);

  it.skipIf(!process.env.ENVIA_COLOMBIA_TRACKING_NUMBER)('recognizes the requested guía', async () => {
    await expect(direct().recognize!(process.env.ENVIA_COLOMBIA_TRACKING_NUMBER!, { budgetMs: 40_000 })).resolves.toMatchObject({ known: true });
  }, 60_000);

  it.skipIf(!process.env.ENVIA_COLOMBIA_UNKNOWN_NUMBER)('reads an unknown guía as not found', async () => {
    await expect(direct().track({ number: process.env.ENVIA_COLOMBIA_UNKNOWN_NUMBER! }, { budgetMs: 40_000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
