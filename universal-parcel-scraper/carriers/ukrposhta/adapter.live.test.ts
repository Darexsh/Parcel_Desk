import { describe, expect, it } from 'vitest';
import { ChallengeError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const executablePath = process.env.TRACKING_CHROMIUM_PATH;
const number = process.env.UKRPOSHTA_TRACKING_NUMBER;
const UNKNOWN = '0000000000001';
const direct = () => adapter({ browserExecutablePath: null, trawl: null, recorder: NOOP_RECORDER, env: {} });
/** The browser tier alone: the status API request is refused before it leaves. */
const refused: typeof fetch = async () => new Response('', { status: 403 });
const browser = () => adapter({ browserExecutablePath: executablePath ?? null, trawl: null, recorder: NOOP_RECORDER, fetcher: refused, env: {} });

describe('Ukrposhta status API live', () => {
  it.skipIf(!number)('returns history over plain HTTP', async () => {
    const result = normalizeCarrierResult(await direct().track({ number: number! }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time)).toBe(true);
    expect(result.last_update).toBeNull();
  });
  it('keeps a synthetic unknown barcode inconclusive', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Ukrposhta native anonymous browser live', () => {
  it.skipIf(!executablePath || !number)('returns complete matching history', async () => {
    const result = normalizeCarrierResult(await browser().track({ number: number! }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some(event => event.local_time || event.provider_time_text)).toBe(true);
    expect(result.last_update).toBeNull();
  });
  it.skipIf(!executablePath)('keeps an unbound synthetic unknown response inconclusive', async (context) => {
    const error: unknown = await browser().track({ number: UNKNOWN }).then(() => undefined, caught => caught);
    // The portal scores the browser invisibly and refuses lookups below its
    // threshold. A refused browser proves neither breakage nor health.
    if (error instanceof ChallengeError) return context.skip('Ukrposhta refused the browser\'s automatic verification: adapter remains unverified');
    expect(error).toMatchObject({ kind: 'indeterminate' });
  });
});
