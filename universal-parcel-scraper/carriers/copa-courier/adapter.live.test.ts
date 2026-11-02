import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Copa Courier live retrieval', () => {
  it.skipIf(!process.env.COPA_COURIER_TRACKING_NUMBER)('retrieves the history of the requested HAWB with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.COPA_COURIER_TRACKING_NUMBER!, carrier: 'copa-courier' });
    expect(answer).toMatchObject({ carrier: 'copa-courier', source: 'copa-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'copa-courier', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone keeps its wall clock to the minute, with no offset, and its wording without the station code.
    expect(answer.result.events.every((event) => event.description && !/ -( [A-Z]{3})?$/.test(event.description) && !event.time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.at(-1)).toMatchObject({ description: 'ENVIO RECIBIDO EN ORIGEN', stage: 'accepted' });
  }, 45_000);

  it.skipIf(!process.env.COPA_COURIER_TRACKING_NUMBER)('recognizes the requested HAWB', async () => {
    await expect(direct().recognize!(process.env.COPA_COURIER_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.COPA_COURIER_UNKNOWN_NUMBER)('reads an unknown HAWB as not found', async () => {
    await expect(direct().track({ number: process.env.COPA_COURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
