import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, NEPAL_POST_ENDPOINT, NepalPostTracker } from './adapter.js';
import { parseNepalPost } from './parser.js';

const NUMBER = 'ZZ000000014NP';
const head = ['SN.', 'Event Type', 'Event Date', 'User', 'Event Office', 'Next Office', 'Condition', 'Retention Reason'];
const form = (number = NUMBER) => `<input id="ItemId" name="ItemId" value="${number}">`;
const fixture = () => `${form()}<table><tr><th colspan="8">Event Details : ${NUMBER}</th></tr><tr>${head.map(label => `<th>${label}</th>`).join('')}</tr>
<tr><td>1</td><td>Counter Entry</td><td>3/12/2026 2:30:52 PM</td><td>PRIVATE operator</td><td>Kathmandu, General Post Office</td><td>PRIVATE next office</td><td>PRIVATE condition</td><td>PRIVATE reason</td></tr></table>`;
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1.0' });

describe('Nepal Post internal tracking', () => {
  it('reads only operational scan fields and retains the Nepal wall clock and its basis', () => {
    const result = parseNepalPost(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_update: '2026-03-12T14:30:52+05:45', history_truncated: true });
    expect(result.events![0]).toMatchObject({ local_time: '2026-03-12T14:30:52', time_zone: 'Asia/Kathmandu', time_zone_basis: 'carrier' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('binds both the form and event heading to the whole item', () => {
    for (const html of [fixture().replace(`value="${NUMBER}"`, `value="${NUMBER}EXTRA"`), fixture().replace(`Event Details : ${NUMBER}`, 'Event Details : ZZ000000028NP')]) {
      expect(() => parseNepalPost(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseNepalPost(`${form()}<p>No Events Found</p>`, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNepalPost(`${form('ZZ000000028NP')}<p>No Events Found</p>`, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNepalPost('<p>No Events Found</p>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps block pages, changed schemas and impossible dates distinct from absence', () => {
    expect(() => parseNepalPost('<title>Request Rejected</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const html of [fixture().replace('Event Office', 'Address'), fixture().replace('3/12/2026', '2/30/2026'), fixture().replace('Counter Entry', '')]) {
      expect(() => parseNepalPost(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseNepalPost(fixture().replace('Counter Entry', 'Synthetic unmapped operation'), NUMBER).events![0]!.stage).toBeUndefined();
  });

  it('uses the supplied transport and signal and recognizes only actual history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture()));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T08:45:52.000Z' });
    expect(fetcher.mock.calls[0]![0]).toBe(`${NEPAL_POST_ENDPOINT}?ItemId=${NUMBER}`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    await expect(new NepalPostTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(fetcher).recognize!('ZZ000000015NP')).resolves.toEqual({ known: false });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response(form() + '<p>No Events Found</p>'))).recognize!(NUMBER)).resolves.toEqual({ known: false });
  });

  it.each([[404, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });
});
