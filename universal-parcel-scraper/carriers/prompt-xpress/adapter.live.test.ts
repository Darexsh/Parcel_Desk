import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Prompt Xpress live retrieval', () => {
  it.skipIf(!process.env.PROMPT_XPRESS_TRACKING_NUMBER)('retrieves the newest movement of the requested parcel with providers disabled', async () => {
    const number = process.env.PROMPT_XPRESS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'prompt-xpress' });
    expect(answer).toMatchObject({ carrier: 'prompt-xpress', source: 'prompt-xpress', attempts: [{ source: 'prompt-xpress', kind: 'ok' }],
      result: { summary_only: true } });
    expect(answer.result.events).toHaveLength(1);
    // The scan has its wording, its branch and a wall clock without an offset.
    expect(answer.result.events.every((event) => event.description && event.location && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.PROMPT_XPRESS_UNKNOWN_NUMBER)('reads the portal’s no-data notice for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PROMPT_XPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PROMPT_XPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
