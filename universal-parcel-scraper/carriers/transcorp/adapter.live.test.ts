import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Transcorp live retrieval', () => {
  it.skipIf(!process.env.TRANSCORP_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TRANSCORP_TRACKING_NUMBER!, carrier: 'transcorp' },
      { budgetMs: 40_000 });
    expect(answer).toMatchObject({ carrier: 'transcorp', source: 'transcorp' });
    expect(answer.attempts[0]).toMatchObject({ source: 'transcorp', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every event keeps an instant with its offset, the tracker's label and its type.
    expect(answer.result.events.every((event) => event.description && event.provider_code
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.TRANSCORP_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.TRANSCORP_TRACKING_NUMBER!, { budgetMs: 40_000 })).resolves.toMatchObject({ known: true });
  }, 75_000);

  it.skipIf(!process.env.TRANSCORP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TRANSCORP_UNKNOWN_NUMBER! }, { budgetMs: 40_000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.TRANSCORP_UNKNOWN_NUMBER!, { budgetMs: 40_000 })).resolves.toEqual({ known: false });
  }, 75_000);
});
