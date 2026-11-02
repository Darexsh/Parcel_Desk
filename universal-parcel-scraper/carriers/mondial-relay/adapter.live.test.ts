import { describe, expect, it } from 'vitest';
import { MondialRelayTracker } from './adapter.js';

const refreshToken = (process.env.MONDIAL_RELAY_REFRESH_TOKEN ?? '').trim();
const number = (process.env.MONDIAL_RELAY_TRACKING_NUMBER ?? '').trim();
const postcode = (process.env.MONDIAL_RELAY_POSTCODE ?? '').trim();

describe('Mondial Relay live app tracking', () => {
  it.runIf(Boolean(refreshToken && number))('returns caller-supplied history through the app without a browser', async () => {
    const tracker = new MondialRelayTracker({ appRefreshToken: refreshToken, trawl: null, timeoutMs: 20_000 });
    const result = await tracker.fetch(number, postcode);
    expect(result.tracking_source).toBe('mobile-app-response');
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.status).not.toBe('unknown');
    expect(result.events?.every(event => /[+-]\d{2}:\d{2}$/.test(event.time ?? ''))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(postcode || '\u0000');
    // The access token is kept for the next lookup.
    const started = performance.now();
    await expect(tracker.fetch(number, postcode)).resolves.toMatchObject({ events: result.events });
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);
});

const inpostSpainNumber = (process.env.MONDIAL_RELAY_INPOST_SPAIN_NUMBER ?? '').trim();

describe('Mondial Relay live InPost Spain tracking', () => {
  it.runIf(Boolean(inpostSpainNumber))('reads an InPost Spain number from its page without a browser or an account', async () => {
    const result = await new MondialRelayTracker({ trawl: null }).fetch(inpostSpainNumber, '', { budgetMs: 20_000 });
    expect(result.tracking_source).toBe('rendered-page');
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.status).not.toBe('unknown');
    expect(result.events?.every(event => /^[A-Z]{3}\.\d{4}$/.test(event.provider_code ?? '') && /\+0[12]:00$/.test(event.time ?? ''))).toBe(true);
  }, 30_000);
});
