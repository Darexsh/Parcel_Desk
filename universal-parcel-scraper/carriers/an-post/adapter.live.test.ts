import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

// Public reports An Post's own tracking knew. An unknown request also gets an
// empty list, so a clean not-found alone would not show the route still works.
const confirmed = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string } }[])
  .filter(record => record.context?.assessment === 'confirmed' && !record.quarantine).map(record => record.number);

function expectHistory(result: CarrierResult) {
  expect(result.events?.length).toBeGreaterThan(0);
  // An Post's own scans are also dated on Irish time, GMT or IST.
  expect(result.events?.every(event => typeof event.local_time === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(event.local_time)
    && (event.time === undefined || [`${event.local_time}+00:00`, `${event.local_time}+01:00`].includes(event.time))))
    .toBe(true);
  expect(result.events?.every(event => event.provider_code !== undefined)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/receiverName|geisDelivery|senderNo|countryOfOrigin/);
}

describe('An Post live guest tracking', () => {
  it('answers a well-formed unknown number with a clean not-found', async () => {
    await expect(instance().track({ number: 'CP000000005IE' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads the history of a confirmed public record', async () => {
    expect(confirmed.length).toBeGreaterThan(0);
    const histories: CarrierResult[] = [];
    for (const number of confirmed) {
      // An expired item gets the unknown number's answer; nothing else may fail.
      const result = await instance().track({ number }).catch((error: unknown) => {
        expect(error).toMatchObject({ kind: 'not_found' });
        return null;
      });
      if (result) histories.push(result);
    }
    // When every record has expired, add a fresher public report to numbers.json.
    expect(histories.length).toBeGreaterThan(0);
    for (const result of histories) {
      expectHistory(result);
      expect(result.current_stage).toBeTypeOf('string');
    }
  });

  it.skipIf(!process.env.AN_POST_TRACKING_NUMBER)('reads a private number on offset-less local clocks without recipient details', async () => {
    expectHistory(await instance().track({ number: process.env.AN_POST_TRACKING_NUMBER! }));
  });
});
