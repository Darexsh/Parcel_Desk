import { describe, expect, it } from 'vitest';
import { FastboxTracker } from './adapter.js';

const NUMBER = process.env.FASTBOX_TRACKING_NUMBER;
const UNKNOWN = process.env.FASTBOX_UNKNOWN_NUMBER;

describe('Fastbox live tracking', () => {
  it.skipIf(!NUMBER)('returns the history of the requested invoice', async () => {
    const result = await new FastboxTracker().fetch(NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.current_stage).toBeTruthy();
  }, 30_000);

  it.skipIf(!UNKNOWN)('reads an unknown invoice as not found', async () => {
    await expect(new FastboxTracker().fetch(UNKNOWN!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
