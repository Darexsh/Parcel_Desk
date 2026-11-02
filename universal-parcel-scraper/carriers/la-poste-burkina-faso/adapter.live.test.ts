import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A Burkina Faso office's scan on Ouagadougou's clock, or another post's wall clock.
const CLOCK = (event: { time?: unknown; local_time?: unknown }) => typeof event.time === 'string'
  ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(event.time) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time));

describe('La Poste Burkina Faso live retrieval', () => {
  it.skipIf(!process.env.LA_POSTE_BURKINA_FASO_TRACKING_NUMBER)('retrieves the requested item’s scans with providers disabled', async () => {
    const number = process.env.LA_POSTE_BURKINA_FASO_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'la-poste-burkina-faso' });
    expect(answer).toMatchObject({ carrier: 'la-poste-burkina-faso', source: 'la-poste-burkina-faso' });
    // An item delivered abroad can also be handed to the destination's post.
    expect(answer.attempts[0]).toMatchObject({ source: 'la-poste-burkina-faso', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.location && CLOCK(event))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.LA_POSTE_BURKINA_FASO_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.LA_POSTE_BURKINA_FASO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.LA_POSTE_BURKINA_FASO_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});
