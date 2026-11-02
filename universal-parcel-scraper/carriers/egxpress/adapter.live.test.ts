import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('EGXPRESS guest domestic tracking', () => {
  it.skipIf(!process.env.EGXPRESS_TRACKING_NUMBER)('retrieves and recognizes dated history without a browser or provider', async () => {
    const carrier = direct();
    const result = await carrier.track({ number: process.env.EGXPRESS_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && event.provider_code && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(result.events!.filter((event) => event.provider_code === 'POD').every((event) => event.description === 'Delivered')).toBe(true);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('cod_amount');
    await expect(carrier.recognize!(process.env.EGXPRESS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true, lastActivityAt: null,
      lastActivityLocal: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  }, 45_000);

  it.skipIf(!process.env.EGXPRESS_UNKNOWN_NUMBER)('keeps the explicit missing-waybill answer distinct from failures', async () => {
    await expect(direct().track({ number: process.env.EGXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.EGXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
