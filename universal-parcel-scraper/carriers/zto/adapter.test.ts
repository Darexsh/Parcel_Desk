import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';
import { API, normalizeZtoNumber, parseZto } from './parser.js';

const number = '79990000000001', other = '79990000000002';
const found = () => ({ status: true, statusCode: 'E0000', result: { items: [{ billCode: number, recipientName: 'PRIVATE', traces: [
  { traceTime: Date.UTC(2031, 3, 18, 8), traceTypeCode: 'DISPATCHING', traceTypeDesc: '派件', traceSiteName: 'Example depot', traceDescText: 'PRIVATE' },
  { traceTime: Date.UTC(2031, 3, 18, 12), traceTypeCode: 'SIGNED', traceTypeDesc: '签收', traceSiteName: 'Example depot', traceDescText: 'PRIVATE' },
] }] } });
const challenge = { status: false, statusCode: '10201', message: '请输入验证码', result: null };
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const capture = (value: unknown, status = 200, submitted = number) => ({ url: API, trackingNumberSubmitted: submitted,
  status, headers: {}, body: JSON.stringify(value), truncated: false, base64Encoded: false, error: null });
const environment = () => ({ env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER,
  fetcher: vi.fn<typeof fetch>(async () => reply(challenge)) });

describe('ZTO', () => {
  it('shares domestic candidate validation and requires the complete identity', () => {
    expect(detectCarrierMatch(number).candidates).toContain('zto');
    expect(detectCarrierMatch(number).carrier).not.toBe('zto');
    expect(recognitionCandidates(number, { phase: 'browser' }).map(row => row.carrier)).not.toContain('zto');
    expect(recognitionCandidates(number, { hint: 'zto' }).map(row => row.carrier)).not.toContain('zto');
    expect(normalizeZtoNumber('7999 0000000001')).toBe(number);
    expect(normalizeZtoNumber('999000000001')).toBe('999000000001');
    for (const input of [number + '0', '89990000000001', 'ABC79990000000001']) expect(() => normalizeZtoNumber(input)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    const wrong = found(); wrong.result.items[0]!.billCode = other;
    expect(() => parseZto(wrong, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('preserves epoch clocks, drops private wording and allows provider completion', () => {
    const result = parseZto(found(), number);
    expect(result).toMatchObject({ current_stage: 'delivered', history_truncated: true,
      last_update: '2031-04-18T12:00:00Z', events: [{ stage: 'delivered' }, { stage: 'out_for_delivery' }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const moving = found(); moving.result.items[0]!.traces = [
      { traceTime: Date.UTC(2031, 3, 17, 8), traceTypeCode: 'TRANSITING', traceTypeDesc: '运输中', traceSiteName: 'Example hub', traceDescText: 'PRIVATE' }];
    expect(parseZto(moving, number)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      events: [{ stage: 'in_transit', stage_source: 'carrier_map' }] });
    for (const [code, stage] of [['RECEIVED', 'accepted'], ['ARRIVED', 'ready_for_pickup'], ['ABNORMAL', 'exception']] as const) {
      moving.result.items[0]!.traces[0]!.traceTypeCode = code;
      expect(parseZto(moving, number)).toMatchObject({ current_stage: stage, current_stage_source: 'carrier_map' });
    }
    // A trace type's label in Chinese shows in English; a type the map does not know keeps its label.
    expect(result).toMatchObject({ last_status_text: 'Signed for', events: [{ description: 'Signed for' }, { description: 'Out for delivery' }] });
    moving.result.items[0]!.traces[0]!.traceTypeCode = 'RETURNING';
    moving.result.items[0]!.traces[0]!.traceTypeDesc = '退回件';
    expect(parseZto(moving, number).events).toMatchObject([{ description: '退回件' }]);
    const clock = found(); clock.result.items[0]!.traces[0]!.traceTime = NaN;
    expect(() => parseZto(clock, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps verification, throttles, empty history and malformed replies distinct', () => {
    expect(() => parseZto(challenge, number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseZto({ ...challenge, statusCode: '10202', message: '' }, number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseZto({ ...challenge, message: '访问频繁' }, number)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    const empty = found(); empty.result.items[0]!.traces = [];
    expect(() => parseZto(empty, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [null, [], {}, { status: true, statusCode: 'E0000', result: null }]) expect(() => parseZto(value, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps HTTP recognition HTTP-only and records challenge recovery', async () => {
    const env = environment(), recorded: unknown[] = [];
    const browserFetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ skipHttp: true, captureResponses: [API] });
      expect(init?.signal).toBeDefined();
      return reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture(challenge), capture(found())] });
    });
    const carrier = adapter({ ...env, trawl: new TrawlClient('http://browser.test', browserFetcher),
      recorder: { ...NOOP_RECORDER, step: event => { recorded.push(event); } } });
    await expect(carrier.recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
    expect(browserFetcher).not.toHaveBeenCalled();
    // Recognition's request is a recorded step too.
    expect(recorded.splice(0)).toMatchObject([{ step: 'direct', outcome: 'challenge' }]);
    await expect(carrier.track({ number }, { budgetMs: 8000 })).resolves.toMatchObject({ current_stage: 'delivered', history_truncated: true });
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'challenge' }, { step: 'trawl', outcome: 'ok' }]);
    expect(JSON.parse(String(env.fetcher.mock.calls[0]![1]!.body))).toEqual({ items: [{ billCode: number }] });
  });
  it('refuses unbound captures, final rejections and incomplete bodies', async () => {
    for (const [captures, kind] of [
      [[capture(found(), 200, other)], 'challenge'], [[capture(found()), capture(challenge)], 'challenge'],
      [[{ ...capture(found()), truncated: true }], 'transport'], [[capture(found(), 429)], 'rate_limited'], [[capture(found(), 403)], 'challenge'],
    ] as const) {
      const trawl = new TrawlClient('http://browser.test', async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: captures }));
      await expect(adapter({ ...environment(), trawl }).track({ number }, { budgetMs: 8000 })).rejects.toMatchObject({ kind });
    }
    const env = environment();
    await expect(adapter(env).track({ number }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(env.fetcher).not.toHaveBeenCalled();
  });
  it('says why the browser page stayed challenged, as the service helper labels it', async () => {
    const lookup = (captures: unknown[], reason?: string) => adapter({ ...environment(), trawl: new TrawlClient('http://browser.test',
      async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: captures, timings: [{ tier: 3, status: 'success', durationMs: 1, reason }] })),
    }).track({ number }, { budgetMs: 8000 });
    for (const [outcome, reason] of [['unsolved', 'puzzle_unsolved'], ['solver_unavailable', 'solver_unavailable'],
      ['refused', 'verification_refused'], ['deadline', 'verification_unfinished'], ['no_puzzle', 'puzzle_missing']]) {
      await expect(lookup([capture(challenge)], `zto-${outcome}`)).rejects.toMatchObject({ kind: 'challenge', reason });
    }
    await expect(lookup([], 'zto-no_puzzle')).rejects.toMatchObject({ kind: 'challenge', reason: 'puzzle_missing' });
    await expect(lookup([capture(found(), 403)], 'zto-reply_failed')).rejects.toMatchObject({ kind: 'challenge', reason: 'api_denied', status: 403 });
    for (const reason of [undefined, 'zto-constructor', 'ZTO browser retrieval failed']) {
      const error = await lookup([capture(challenge)], reason).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: 'challenge' });
      expect((error as { reason?: string }).reason).toBeUndefined();
    }
    await expect(lookup([capture({ ...challenge, message: '访问频繁' })], 'zto-rate_limited')).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
