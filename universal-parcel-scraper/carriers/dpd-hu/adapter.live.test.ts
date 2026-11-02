import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const number = (process.env.DPD_HU_TRACKING_NUMBER ?? '').trim();
const unknown = (process.env.DPD_HU_UNKNOWN_NUMBER ?? '').trim();
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD Hungary live guest tracking', () => {
  it.runIf(Boolean(number))('returns the requested Hungarian parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'dpd-hu' });
    expect(answer).toMatchObject({ carrier: 'dpd-hu', source: 'dpd-hu' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dpd-hu', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone carries DPD's own offset.
    expect(answer.result.events.every(event => /[+-]\d{2}:\d{2}$/.test(String(event.time)) && event.provider_code)).toBe(true);
    expect(answer.result.tracking_url).toContain('/hu/mydpd/');
  }, 60_000);

  it.runIf(Boolean(number))('recognizes the Hungarian parcel', async () => {
    await expect(direct().recognize!(number)).resolves.toEqual({ known: true });
  }, 30_000);

  it.runIf(Boolean(unknown))('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
