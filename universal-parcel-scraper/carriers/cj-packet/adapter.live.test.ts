import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CJ Packet live retrieval', () => {
  it.skipIf(!process.env.CJ_PACKET_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.CJ_PACKET_TRACKING_NUMBER!, carrier: 'cj-packet' });
    expect(answer).toMatchObject({ carrier: 'cj-packet', source: 'cj-packet' });
    expect(answer.attempts[0]).toMatchObject({ source: 'cj-packet', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.service_name).toMatch(/^CJPacket\b/);
    // Each scan has its offset, or its wall clock when the forwarder sent none.
    expect(answer.result.events.every((event) => event.description && (event.time
      ? Date.parse(event.time) <= Date.now() : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CJ_PACKET_TRACKING_NUMBER)('recognizes the requested parcel', async () => {
    await expect(direct().recognize!(process.env.CJ_PACKET_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.CJ_PACKET_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CJ_PACKET_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
