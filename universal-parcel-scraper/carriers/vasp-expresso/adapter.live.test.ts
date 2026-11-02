import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.VASP_EXPRESSO_TRACKING_NUMBER;

describe('Vasp Expresso live retrieval', () => {
  it.skipIf(!number)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: number!, carrier: 'vasp-expresso' });
    expect(answer).toMatchObject({ carrier: 'vasp-expresso', source: 'vasp-expresso' });
    expect(answer.attempts[0]).toMatchObject({ source: 'vasp-expresso', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps the page's wall clock, without an offset, and its event type.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && /^\d+$/.test(String(event.provider_code)))).toBe(true);
  }, 45_000);

  it.skipIf(!number || number.length !== 13)('finds the service from its first volume barcode', async () => {
    await expect(direct().track({ number: `${number!}001` })).resolves.toMatchObject({ canonical_tracking_number: number });
  });

  it.skipIf(!number)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.VASP_EXPRESSO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.VASP_EXPRESSO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
