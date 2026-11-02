import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';

const instance = () => adapter({ fetcher: fetch, env: {}, trawl: null, browserExecutablePath: null,
  recorder: { step() {}, lookup() {} } });

describe('SEUR public simple tracking', () => {
  it.skipIf(!process.env.SEUR_TRACKING_NUMBER)('retrieves identity-bound history through the full factory', async () => {
    const result = await instance().track({ number: process.env.SEUR_TRACKING_NUMBER! });
    expect(result.events?.length).toBeGreaterThan(0);
    // Scans name no place, so a clock without a numeric offset stays a wall clock.
    expect(result.events?.every(event => Boolean(event.time) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(String(event.local_time)))).toBe(true);
    expect(result.last_update).toBe(result.events![0]!.time ?? null);
    expect(JSON.stringify(result)).not.toMatch(/pin_entrega|pin_locker|deliverer_latitude|comentario_bbdd/);
  });
  it.skipIf(!process.env.SEUR_UNKNOWN_NUMBER)('keeps no-history controls inconclusive', async () => {
    await expect(instance().track({ number: process.env.SEUR_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
