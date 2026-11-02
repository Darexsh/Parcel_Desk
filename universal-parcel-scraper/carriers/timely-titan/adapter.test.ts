import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TIMELY_TITAN_TRACKER, TimelyTitanTracker } from './adapter.js';
import { normalizeTimelyTitanNumber, parseTimelyTitan, timelyTitanText } from './parser.js';
import { statusMap, timelyTitanMappedStage, timelyTitanStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const PARCEL = 'TT2600000000017CN';
const UNKNOWN = 'TT2600000000099CN';
const FORWARDED = 'EK100000017MO';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const ROW = /\s*<tr>\s*<td width="30%"[\s\S]*?<\/tr>/g;
// The page with only the rows from the n-th on, newest first.
const from = (index: number) => {
  let seen = 0;
  return text('delivered.html').replace(ROW, (row) => (seen++ < index ? '' : row));
};

describe('Timely Titan HTTP adapter', () => {
  it('asks the tracking page for the number', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TimelyTitanTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tt 2600000000017 cn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TIMELY_TITAN_TRACKER}?number=${PARCEL}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'timely-titan', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the statuses as wall clocks in the page’s order, with their regions, and the number the parcel is forwarded under', () => {
    const result = parseTimelyTitan(text('delivered.html'), PARCEL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: '您的快件已妥收',
      last_update: null, last_update_local: '2026-03-18T19:43:53', expected_delivery: null, delivery_tracking_number: FORWARDED });
    // The page names no partner, only its number.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-18T19:43:53', '您的快件已妥收', 'China', 'delivered'],
      ['2026-03-18T14:15:47', '快件正在派送中，请耐心等待', 'China', 'out_for_delivery'],
      ['2026-03-18T09:29:11', '快件到达【示例市样本街揽投部】', 'China', 'in_transit'],
      ['2026-03-18T07:50:49', '快件离开【示例市样本包件车间】，正在发往下一站', 'China', 'in_transit'],
      ['2026-03-18T05:53:00', '快件已在【示例市样本包件车间】完成分拣，准备发出', 'China', 'in_transit'],
      ['2026-03-18T05:34:18', '快件到达【示例市样本包件车间】', 'China', 'in_transit'],
      ['2026-03-16T03:32:08', '预计【3月18日】到达【示例市】，两地距离2000km，将在【3月18日上午】更新快件状态，请您放心', 'China', undefined],
      ['2026-03-15T21:18:14', '快件已在【样本市一号包件车间】完成分拣，准备发出', 'China', 'in_transit'],
      ['2026-03-15T09:20:11', '快件已在【样本航空中心】完成分拣，准备发出', 'China', 'in_transit'],
      ['2026-03-14T22:19:55', '快件离开【样本市报关行】，正在发往下一站', 'China', 'in_transit'],
      ['2026-03-14T22:16:24', '运输中，已出库', 'China', 'in_transit'],
      ['2026-03-14T21:28:24', '已放行', 'China', 'in_transit'],
      ['2026-03-13T16:46:51', '等待用户缴税', 'China', 'customs'],
      ['2026-03-13T14:49:40', '快件离开【样本市处理中心】，正在发往下一站', 'China', 'in_transit'],
      ['2026-03-13T14:48:38', '进口处理中心留存', 'China', 'customs'],
      ['2026-03-12T12:09:58', '快件离开处理中心', 'China', 'in_transit'],
      ['2026-03-12T08:00:27', '车辆到达', 'China', 'in_transit'],
      ['2026-03-10T10:48:13', '快件到达处理中心', 'China', 'in_transit'],
      ['2026-03-10T09:47:10', '入库收件 示例镇 SAMPLEVILLE', 'China', 'in_transit'],
      ['2026-03-10T05:30:27', '车辆发车', 'China', 'in_transit'],
      ['2026-03-09T15:04:53', '仓库出库', 'China', 'in_transit'],
      ['2026-03-09T14:08:21', '攬收入庫', 'China', 'in_transit'],
      ['2026-03-09T14:08:21', `转寄单号:${FORWARDED}`, 'China', 'in_transit'],
      ['2026-03-07T03:21:58', '打托转运中', 'Hong Kong', 'in_transit'],
      ['2026-03-06T04:02:45', '【出库】您的包裹已从 海外示例仓出库完成', 'Hong Kong', 'in_transit'],
      ['2026-03-04T06:39:20', '接单成功', 'Hong Kong', 'registered'],
      // The shop's row is no region, and comes last though its clock is later.
      ['2026-03-04T09:50:37', '面单已创建', undefined, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && (!event.stage || event.stage_source === 'carrier_map'))).toBe(true);
    // Who signed, the courier and their phones are left out.
    expect(JSON.stringify(result)).not.toMatch(/示例人|样本员|电话|10000000000|10000000001|11183|Sampleshop/);
  });

  it('reads a parcel on its way, and one at customs', () => {
    expect(parseTimelyTitan(from(1), PARCEL)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: '快件正在派送中，请耐心等待', last_update_local: '2026-03-18T14:15:47', delivery_tracking_number: FORWARDED });
    // The estimate sets no stage, so the scan before it does.
    expect(parseTimelyTitan(from(6), PARCEL)).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-03-16T03:32:08' });
    expect(parseTimelyTitan(from(12), PARCEL)).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: '等待用户缴税' });
    const early = parseTimelyTitan(from(23), PARCEL);
    expect(early).toMatchObject({ current_stage: 'in_transit', last_status_text: '打托转运中' });
    expect(early).not.toHaveProperty('delivery_tracking_number');
    // A status the map does not know goes to the shared wording rules, and one they do not know has no stage.
    const returned = parseTimelyTitan(text('delivered.html').replace('[中国]您的快件已妥收', '[Hong Kong]Returned to sender'), PARCEL);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language', last_status_text: 'Returned to sender' });
    const odd = parseTimelyTitan(text('delivered.html').replace(/\[中国\]您的快件已妥收[^<]*/, '[中国]示例状态'), PARCEL);
    expect(odd).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: '示例状态' });
    expect(odd.events![0]).not.toHaveProperty('stage');
  });

  it('takes the forwarding number only when the page gives one, other than the number asked', () => {
    const forwarded = (number: string) => text('delivered.html').replace(`转寄单号:${FORWARDED}`, `转寄单号:${number}`);
    expect(parseTimelyTitan(forwarded(PARCEL), PARCEL)).not.toHaveProperty('delivery_tracking_number');
    expect(parseTimelyTitan(forwarded('not a number'), PARCEL)).not.toHaveProperty('delivery_tracking_number');
    // Two numbers name none.
    const twice = text('delivered.html').replace('[中国]车辆发车', '[中国]转寄单号:EK100000025MO');
    expect(parseTimelyTitan(twice, PARCEL)).not.toHaveProperty('delivery_tracking_number');
    // The same number twice is one.
    const again = text('delivered.html').replace('[中国]车辆发车', `[中国]转寄单号：${FORWARDED.toLowerCase()}`);
    expect(parseTimelyTitan(again, PARCEL)).toMatchObject({ delivery_tracking_number: FORWARDED });
  });

  it('leaves out who signed, couriers, phones and rows that gave only contacts', () => {
    expect(timelyTitanText('您的快件已妥收【本人签收，示例人】，如有疑问请电联快递员【样本员，电话:10000000000】。服务热线11183。')).toBe('您的快件已妥收');
    expect(timelyTitanText('快件到达【示例市样本街揽投部】，投递员：样本员，电话 100 0000 0000')).toBe('快件到达【示例市样本街揽投部】');
    expect(timelyTitanText('Delivered, signed by Sample Person')).toBe('Delivered');
    expect(timelyTitanText('Held at Sample Hub, mail sample@example.com, call +31 10 000 0000')).toBe('Held at Sample Hub, mail, call');
    const contacts = parseTimelyTitan(text('delivered.html').replace('[中国]车辆发车', '[中国]联系电话:10000000000'), PARCEL);
    expect(contacts.events).toHaveLength(26);
    expect(JSON.stringify(contacts)).not.toContain('10000000000');
    // A row the page lists twice is kept once.
    const twice = parseTimelyTitan(text('delivered.html').replace(/(\s*<tr>\s*<td width="30%"[^<]*2026-03-12 08:00:27[\s\S]*?<\/tr>)/, '$1$1'), PARCEL);
    expect(twice.events).toHaveLength(27);
  });

  it('reads the page’s answer for an unknown number as not found', async () => {
    expect(() => parseTimelyTitan(text('not-found.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps only a page whose form holds the whole number asked', () => {
    for (const [page, number] of [['delivered.html', PARCEL], ['not-found.html', UNKNOWN]]) {
      expect(() => parseTimelyTitan(text(page!), 'TT2600000000018CN'))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Timely Titan answered for another shipment' }));
      expect(() => parseTimelyTitan(text(page!).replace(`value="${number}"`, `value="${number!.slice(0, -2)}"`), number!))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
      expect(() => parseTimelyTitan(text(page!).replace(`value="${number}"`, 'value=""'), number!))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('rejects a changed page', () => {
    const delivered = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      delivered.replace('id="services"', 'id="tracking"'),
      delivered.replace('name="number"', 'name="no"'),
      delivered.replace('<th style="text-align: center">Context</th>', '<th>Status</th>'),
      delivered.replace('<th style="text-align: center">Context</th>', ''),
      delivered.replace('</table>', '</table><table><tr><th>Time</th><th>Context</th></tr></table>'),
      delivered.replace('>2026-03-18 19:43:53<', '>18/03/2026 19:43<'),
      delivered.replace('>2026-03-18 19:43:53<', '>2026-03-18 24:43:53<'),
      delivered.replace('>2026-03-18 19:43:53<', '>2026-02-30 19:43:53<'),
      delivered.replace(/>\[中国\]已放行</, '><'),
      delivered.replace('>[中国]已放行</td>', '>[中国]已放行</td><td>Sample</td>'),
      delivered.replace(ROW, (row: string) => row.repeat(19)),
    ].entries()) {
      expect(() => parseTimelyTitan(body, PARCEL), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTimelyTitan(text('not-found.html').replace('tracking not found', 'Sample maintenance'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('has no history for a parcel without statuses', () => {
    expect(() => parseTimelyTitan(text('delivered.html').replace(ROW, ''), PARCEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a firewall page, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: PARCEL });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 301, headers: { Location: 'https://timelytitan.com/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 301 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
  });

  it('refuses what is no tracking number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TT123', 'TT-26/00', '0'.repeat(41), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTimelyTitanNumber(' tt 260 0000 0000 17 cn ')).toBe(PARCEL);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('recognizes a number the tracker knows, and not one it does not', async () => {
    await expect(carrier(replying(() => html(text('delivered.html')))).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('TT123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number of its shape to the adapter', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: PARCEL }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'timely-titan', source: 'timely-titan', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${TIMELY_TITAN_TRACKER}?number=${PARCEL}`)).toBe(true);
  });
});

describe('Timely Titan status vocabulary', () => {
  const entries = statuses.entries as { wording: string; stage?: string }[];
  // What the page fills in for an entry's `…`.
  const example = (wording: string) => wording.replaceAll('【…】', '【示例市处理中心】').replaceAll('…', ' 示例 ');

  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of entries.filter((candidate) => candidate.stage)) {
      expect(statusMapAnswer({ carrier: 'timely-titan', providerCode: null, description: example(entry.wording) }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(timelyTitanStage(example(entry.wording)), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('reads a wording whatever the page fills in, and only that', () => {
    expect(timelyTitanMappedStage('快件到达【示例市样本街揽投部】')).toBe('in_transit');
    expect(timelyTitanMappedStage('快件到达【】')).toBeUndefined();
    expect(timelyTitanMappedStage('快件到达【示例市】，准备发往【样本市】')).toBeUndefined();
    expect(timelyTitanMappedStage('入库收件 示例镇 sampleville')).toBe('in_transit');
    expect(timelyTitanMappedStage(`转寄单号:${FORWARDED.toLowerCase()}`)).toBe('in_transit');
  });

  it('leaves the estimate and an unknown wording to the shared rules', () => {
    const estimate = entries.find((entry) => !entry.stage)!.wording;
    expect(timelyTitanStage(example(estimate))).toBeNull();
    expect(statusMap.stage(null, 'sample state')).toBeUndefined();
    expect(timelyTitanStage('Returned to sender')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(timelyTitanStage('示例状态')).toBeNull();
    expect(statusMapAnswer({ carrier: 'timely-titan', providerCode: null, description: '示例状态' })).toEqual({ kind: 'unknown' });
  });
});
