import { describe, expect, it } from 'vitest';
import { AllegroOneTracker } from './adapter.js';

describe('Allegro One live direct retrieval', () => {
  it.skipIf(!process.env.ALLEGRO_ONE_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new AllegroOneTracker().fetch(process.env.ALLEGRO_ONE_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /Z$/.test(event.time ?? '') && event.stage_source === 'carrier_map')).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.ALLEGRO_ONE_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new AllegroOneTracker().fetch(process.env.ALLEGRO_ONE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
