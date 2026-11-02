import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SmsaTracker } from './adapter.js';
import { SMSA_APP_ENDPOINT } from './app.js';

const NUMBER = process.env.SMSA_EXPRESS_TRACKING_NUMBER;
const UNKNOWN = process.env.SMSA_EXPRESS_UNKNOWN_NUMBER;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/** Whether an error is Node refusing the site's certificate, which comes without its intermediate. */
function incompleteChain(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth += 1) {
    if ((current as { code?: unknown }).code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return true;
  }
  return false;
}

describe('SMSA Express live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the history of the requested airway bill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER!, carrier: 'smsa-express' });
    expect(answer).toMatchObject({ carrier: 'smsa-express', source: 'smsa-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'smsa-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The app's service dates every scan with an offset, and no wording keeps a signer.
    expect(answer.result.events.every((event) => event.description && !/signed by/i.test(event.description)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!NUMBER)('reads the same scans on the page as Saudi clocks, when Node accepts the page’s certificate', async (context) => {
    const fromApp = await new SmsaTracker().fetch(NUMBER!);
    // Only the page: the app's service is not asked.
    const onlyPage: typeof fetch = (input, init) => (String(input) === SMSA_APP_ENDPOINT
      ? Promise.resolve(new Response('', { status: 500 })) : fetch(input, init));
    let fromPage;
    try {
      fromPage = await new SmsaTracker({ fetcher: onlyPage }).fetch(NUMBER!);
    } catch (error) {
      // NODE_EXTRA_CA_CERTS with SMSA's intermediate lets Node read the page.
      if (incompleteChain(error)) return context.skip('Node lacks the intermediate certificate SMSA’s site does not send');
      throw error;
    }
    expect(fromPage.events!.map((event) => event.description)).toEqual(fromApp.events!.map((event) => event.description));
    expect(fromPage.events!.map((event) => String(event.local_time).slice(0, 16)))
      .toEqual(fromApp.events!.map((event) => new Date(Date.parse(event.time!) + 3 * 3_600_000).toISOString().slice(0, 16)));
  }, 45_000);

  it.skipIf(!NUMBER)('recognizes the requested airway bill', async () => {
    await expect(direct().recognize!(NUMBER!)).resolves.toMatchObject({ known: true, lastActivityAt: expect.any(String) });
  }, 30_000);

  it.skipIf(!UNKNOWN)('reads an unknown airway bill as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
