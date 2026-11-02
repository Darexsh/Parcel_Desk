import { describe, expect, it } from 'vitest';
import { CorreosExpressTracker } from './adapter.js';

const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:[+-]\d{2}:\d{2}|Z)$/;

describe('Correos Express live tracking', () => {
  it.skipIf(!process.env.CORREOS_EXPRESS_TRACKING_NUMBER)('returns matching public history with the localizador\'s codes', async () => {
    const result = await new CorreosExpressTracker().fetch(process.env.CORREOS_EXPRESS_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    // An instant to the form's minute where the scan's locality settles its clock, else the wall clock; the newest scan's instant is the last update.
    expect(result.events?.every(event => (event.time
      ? !event.local_time && MINUTE.test(event.time) && Date.parse(event.time) <= Date.now() : WALL.test(String(event.local_time))))).toBe(true);
    expect(result.last_update).toBe(result.events![0]!.time ?? null);
    if (result.status === 'delivered') expect(result.delivered_at ?? null).toBe(result.events![0]!.time ?? null);
    expect(result.events?.some(event => event.provider_code)).toBe(true);
  });
  it.skipIf(!process.env.CORREOS_EXPRESS_UNKNOWN_NUMBER)('identifies a negative both sources agree on', async () => {
    await expect(new CorreosExpressTracker().fetch(process.env.CORREOS_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
