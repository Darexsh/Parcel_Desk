import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { statusMap as lexIdMap } from '../lex-id/status.js';
import { adapter } from './adapter.js';
import { normalizeLexMyNumber, parseLexMySearch } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import lexIdStatuses from '../lex-id/statuses.json' with { type: 'json' };

const NUMBER = 'TMYLE000000001';
const found = (): unknown => JSON.parse(readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8'));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('LEX Malaysia tracking', () => {
  it('takes TMYLE and nine digits and posts the number as it is to its own site', async () => {
    expect(normalizeLexMyNumber('tmyle 000000001')).toBe(NUMBER);
    for (const raw of ['TMYLE00000001', 'LXAD0000000001']) expect(() => normalizeLexMyNumber(raw), raw).toThrow('TMYLE and nine digits');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(found()), { headers: { 'Content-Type': 'application/json' } }));
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'out_for_delivery', summary_only: true });
    expect(fetcher.mock.calls[0]![0]).toBe('https://lex.com.my/api/search_packages');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ trackingNumbers: [NUMBER] });
  });

  it('reads the platform’s status on Kuala Lumpur’s clock, by the keys LEX Indonesia’s site shares', () => {
    expect(parseLexMySearch(found(), NUMBER)).toMatchObject({ status: 'out_for_delivery', provider_code: 'domestic_out_for_delivery',
      last_status_text: 'Out for delivery', timezone: 'Asia/Kuala_Lumpur', events: [] });
    expect(statuses.entries.map(({ code, stage, wording }) => [code, stage, wording]))
      .toEqual(lexIdStatuses.entries.map(({ code, stage, wording }) => [code, stage, wording]));
    for (const { code, stage } of statuses.entries) expect(lexIdMap.stage(code, ''), code).toBe(stage);
    expect(statusMapAnswer({ carrier: 'lex-my', providerCode: 'domestic_delivered', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
