import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { borderExpressNumber } from './number.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const NUMBER = process.env.BORDER_EXPRESS_TRACKING_NUMBER;
// The first unit's label of a consignment with a sender prefix; the request is the same.
const prefixed = NUMBER ? /^([A-Z]{4})(\d+)$/.exec(borderExpressNumber(NUMBER).consignment) : null;

describe('Border Express live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the history of the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER!, carrier: 'border-express' });
    expect(answer).toMatchObject({ carrier: 'border-express', source: 'border-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'border-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps its state's offset.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!prefixed)('reads a unit label into its consignment', async () => {
    const [, prefix, range] = prefixed!;
    await expect(direct().track({ number: `${prefix}BX${range!.padStart(11, '0')}001` }))
      .resolves.toMatchObject({ canonical_tracking_number: `${prefix}${range}` });
  }, 45_000);

  it.skipIf(!process.env.BORDER_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BORDER_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
