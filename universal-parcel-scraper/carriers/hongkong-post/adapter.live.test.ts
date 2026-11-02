import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const instance = () => adapter({ fetcher: fetch, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });

describe('Hongkong Post live chatbot', () => {
  it('answers a well-formed unknown number with a clean not-found', async () => {
    await expect(instance().track({ number: 'RR000000005HK' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.HONGKONG_POST_TRACKING_NUMBER)('reads the latest status of a real number on its local clock', async () => {
    const result = await instance().track({ number: process.env.HONGKONG_POST_TRACKING_NUMBER! });
    expect(result).toMatchObject({ summary_only: true, events: [], last_update: null });
    expect(result.last_update_local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    expect(result.last_status_text).toMatch(/^[^<>]{1,200}$/);
    expect(result.status).not.toBe('unknown');
    expect(JSON.stringify(result)).not.toMatch(/https?:|eform|Signed|Recipient|Addressee/i);
  });
});
