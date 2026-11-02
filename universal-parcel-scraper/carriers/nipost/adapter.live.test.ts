import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { discoverActionId } from './action.js';
import { adapter, NIPOST_ACTION, NIPOST_PAGE, NipostTracker } from './adapter.js';
import { normalizeNipostNumber } from './parser.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe('NIPOST live retrieval', () => {
  it.skipIf(!process.env.NIPOST_TRACKING_NUMBER)('retrieves dated scans for the requested item with providers disabled', async () => {
    const number = process.env.NIPOST_TRACKING_NUMBER!;
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'nipost' });
    expect(answer).toMatchObject({ carrier: 'nipost', source: 'nipost', attempts: [{ source: 'nipost', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.description && CLOCK.test(String(event.time ?? event.local_time)))).toBe(true);
    await expect(direct().recognize!(number)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.NIPOST_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.NIPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.NIPOST_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 30_000);

  it.skipIf(!process.env.NIPOST_UNKNOWN_NUMBER)('finds the built-in action id bound to the page’s lookup', async () => {
    const page = `${NIPOST_PAGE}${normalizeNipostNumber(process.env.NIPOST_UNKNOWN_NUMBER!)}`;
    const read = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(15_000) })).text();
    await expect(discoverActionId(await read(page), page, read)).resolves.toBe(NIPOST_ACTION);
  }, 45_000);

  it.skipIf(!process.env.NIPOST_UNKNOWN_NUMBER)('reads the action id from the page when the tracker does not know the one it tried', async () => {
    const sent: string[] = [];
    const fetcher: typeof fetch = (input, init) => {
      if (init?.method === 'POST') sent.push((init.headers as Record<string, string>)['Next-Action']!);
      return fetch(input, init);
    };
    const steps: string[] = [];
    const recorder = { ...NOOP_RECORDER, step: (event: { step: string; outcome: string }) => { steps.push(`${event.step} ${event.outcome}`); } };
    const tracker = new NipostTracker({ fetcher, recorder, action: '0'.repeat(40) });
    await expect(tracker.fetch(process.env.NIPOST_UNKNOWN_NUMBER!, { budgetMs: 30_000 })).rejects.toMatchObject({ kind: 'not_found' });
    expect(sent).toEqual(['0'.repeat(40), NIPOST_ACTION]);
    expect(steps).toEqual(['direct schema', 'action not_found']);
  }, 45_000);
});
