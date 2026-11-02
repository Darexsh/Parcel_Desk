import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('lex-my live retrieval', () => {
  it.skipIf(!process.env.LEX_MY_TRACKING_NUMBER)('reads the requested package\'s status with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LEX_MY_TRACKING_NUMBER!, carrier: 'lex-my' });
    expect(answer).toMatchObject({ carrier: 'lex-my', source: 'lex-my' });
    expect(answer.attempts[0]).toMatchObject({ source: 'lex-my', kind: 'ok' });
    expect(answer.result).toMatchObject({ summary_only: true, events: [] });
    expect(answer.result.provider_code).toMatch(/^[a-z_]+$/);
  }, 45_000);

  it.skipIf(!process.env.LEX_MY_TRACKING_NUMBER)('recognizes the requested package', async () => {
    await expect(direct().recognize!(process.env.LEX_MY_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.LEX_MY_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LEX_MY_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
