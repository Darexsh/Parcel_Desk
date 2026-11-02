import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A 24-digit label, which carries its delivery postcode.
const label = process.env.A_TU_HORA_EXPRESS_TRACKING_NUMBER;
// A 10- or 16-digit code and its delivery postcode, which the facade does not pass on.
const code = process.env.A_TU_HORA_EXPRESS_SHORT_NUMBER;
const postcode = process.env.A_TU_HORA_EXPRESS_POSTCODE;
const unknown = process.env.A_TU_HORA_EXPRESS_UNKNOWN_NUMBER;

describe('A Tu Hora Express live retrieval', () => {
  it.skipIf(!label)('retrieves the history of the requested label with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: label!, carrier: 'a-tu-hora-express' });
    expect(answer).toMatchObject({ carrier: 'a-tu-hora-express', source: 'a-tu-hora-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'a-tu-hora-express', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    // Every scan keeps its wall clock, without an offset.
    expect(answer.result.events.every((event) => event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/https?:|@|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  }, 75_000);

  it.skipIf(!label)('recognizes the requested label', async () => {
    await expect(direct().recognize!(label!)).resolves.toMatchObject({ known: true });
  }, 30_000);

  it.skipIf(!code || !postcode)('retrieves a shorter code with its postcode', async () => {
    const result = await direct().track({ number: code!, postcode: postcode! });
    expect(result.events!.length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!unknown)('reads an unknown label as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
