import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Madhur Courier live retrieval', () => {
  it.skipIf(!process.env.MADHUR_COURIER_TRACKING_NUMBER)('retrieves the history of the requested C-Note with providers disabled', async () => {
    const number = process.env.MADHUR_COURIER_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'madhur-courier' });
    expect(answer).toMatchObject({ carrier: 'madhur-courier', source: 'madhur-courier', attempts: [{ source: 'madhur-courier', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row has its transaction type, its wording and only its day, never an invented offset.
    expect(answer.result.events.every((event) => event.provider_code && event.description && !event.time
      && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/Consignor|Consignee|Mobile No|Pcs/i);
  }, 45_000);

  it.skipIf(!process.env.MADHUR_COURIER_UNKNOWN_NUMBER)('reads the tracker’s empty answer for an unknown C-Note as not found', async () => {
    await expect(direct().track({ number: process.env.MADHUR_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
