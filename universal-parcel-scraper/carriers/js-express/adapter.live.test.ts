import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('JS Express live retrieval', () => {
  it.skipIf(!process.env.JS_EXPRESS_TRACKING_NUMBER)('retrieves dated scans for the requested waybill with providers disabled', async () => {
    const number = process.env.JS_EXPRESS_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'js-express' });
    expect(answer).toMatchObject({ carrier: 'js-express', source: 'js-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'js-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A row whose place or courier settles its clock has an instant, never ahead of the lookup; the others keep the site's wall clock.
    expect(answer.result.events.every(event => event.description
      && (event.time ? !event.local_time && Date.parse(event.time) <= Date.now() : WALL_CLOCK.test(String(event.local_time))))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.JS_EXPRESS_DELIVERED_NUMBER)('reads a delivered waybill', async () => {
    const result = await direct().track({ number: process.env.JS_EXPRESS_DELIVERED_NUMBER! });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    // The newest row's instant, when it has one, is the last update, and a dated delivery's the delivery time.
    expect(result.last_update).toBe(result.events![0]!.time ?? null);
    expect(result.delivered_at).toBe(result.events!.find(event => event.stage)!.time);
  }, 30_000);

  it.skipIf(!process.env.JS_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.JS_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.JS_EXPRESS_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);
});
