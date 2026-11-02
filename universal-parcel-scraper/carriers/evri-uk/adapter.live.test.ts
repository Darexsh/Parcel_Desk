import { describe, expect, it } from 'vitest';
import { carrierErrorKind } from '../../core/errors/index.js';
import { EvriUkTracker } from './adapter.js';

const executablePath = process.env.TRACKING_CHROMIUM_PATH;
const number = process.env.EVRI_UK_TRACKING_NUMBER;

describe('Evri UK live tracking', () => {
  it('keeps a reference the guest API rejects inconclusive', async (context) => {
    const error: unknown = await new EvriUkTracker().fetch('H000000000000001', { budgetMs: 15_000 }).then(() => undefined, caught => caught);
    // Evri refuses some networks, GitHub runners included, while others get
    // the answer: a refusal proves neither breakage nor health.
    if (carrierErrorKind(error) === 'challenge') return context.skip('Evri UK refused this network: guest API remains unverified');
    expect(error).toMatchObject({ kind: 'indeterminate' });
  }, 20_000);

  it.runIf(Boolean(number))('returns dated anonymous history from the guest API without a postcode', async () => {
    const result = await new EvriUkTracker().fetch(number!, { budgetMs: 15_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some(event => event.time)).toBe(true);
    expect(Object.keys(result).some(key => /recipient|receiver|address|photo|signature|token/i.test(key))).toBe(false);
  }, 20_000);

  it.runIf(Boolean(executablePath && number))('returns the same history through the page', async () => {
    const direct = await new EvriUkTracker().fetch(number!, { budgetMs: 15_000 });
    // The guest API is refused here, so the page answers.
    const result = await new EvriUkTracker({ executablePath, fetcher: async () => new Response('', { status: 403 }) })
      .fetch(number!, { budgetMs: 45_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.tracking_source).toBe('structured-web-response');
    expect(result.events).toEqual(direct.events);
    expect(Object.keys(result).some(key => /recipient|receiver|address|photo|signature|token/i.test(key))).toBe(false);
  }, 70_000);
});
