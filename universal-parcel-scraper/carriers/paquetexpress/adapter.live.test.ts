import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Paquetexpress live retrieval', () => {
  it.skipIf(!process.env.PAQUETEXPRESS_TRACKING_NUMBER)('retrieves the history of the requested tracking code or guía with providers disabled', async () => {
    const number = process.env.PAQUETEXPRESS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'paquetexpress' });
    expect(answer).toMatchObject({ carrier: 'paquetexpress', source: 'paquetexpress', attempts: [{ source: 'paquetexpress', kind: 'ok' }] });
    expect(answer.result.current_stage).toBeDefined();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan carries the offset of its branch's clock.
    expect(answer.result.events.every((event) => /(?:[+-]\d{2}:\d{2})$/.test(event.time ?? '') && event.description)).toBe(true);
    // The wording never keeps the person who made the label, handed the parcel over or took it.
    expect(answer.result.events.some((event) => /\sPOR\s|,\s*recibi/.test(event.description ?? ''))).toBe(false);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true, lastActivityAt: expect.any(String) });
  });

  it.skipIf(!process.env.PAQUETEXPRESS_UNKNOWN_NUMBER)('reads the service’s empty list for an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.PAQUETEXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.PAQUETEXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  });
});
