// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { HONGKONG_POST_POLL, HONGKONG_POST_SEND } from './chatbot.js';
import { expectMenuOption, expectNumberPrompt, MAIL_TRACING_PATH, normalizeHongkongPostNumber, parseHongkongPostAnswer, pollMessage } from './parser.js';
import { classifyHongkongPostStatus, hongkongPostStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'RR000000005HK';
const HOST_USER_AGENT = 'SyntheticHost/1.0';
const replies = JSON.parse(readFileSync(new URL('./fixtures/replies.json', import.meta.url), 'utf8'));
const text = (name: string): string => replies[name].message.text;
const envelope = (message: string) => ({ ...replies.found, message: { text: message } });
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, userAgent: HOST_USER_AGENT, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });

type Reply = () => Response;
const reply = (name: string): Reply => () => json(replies[name]);
const timeout: Reply = () => json(replies.timeout, { status: 408 });

/**
 * A bot that answers each input with the replies the following polls collect,
 * and an idle 408 once they are taken. `send` can replace the acknowledgement.
 */
function bot(answers: Record<string, Reply[]> = {}, send?: (content: string) => Response | undefined) {
  const script: Record<string, Reply[]> = { init: [reply('language')], 2: [reply('main')], 3: [reply('tracing')], 1: [reply('prompt')],
    [NUMBER]: [reply('found')], ...answers };
  let queue: Reply[] = [];
  const inputs: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(input) === HONGKONG_POST_SEND) {
      inputs.push(body.input.content);
      const replaced = send?.(body.input.content);
      if (replaced) return replaced;
      queue = [...script[body.input.content] ?? []];
      return json(replies.ack);
    }
    if (String(input) === HONGKONG_POST_POLL) return (queue.shift() ?? timeout)();
    throw new Error(`Unexpected request to ${String(input)}`);
  });
  const track = (number = NUMBER, context = {}) => adapter(environment(fetcher)).track({ number }, context);
  return { fetcher, inputs, track };
}

describe('Hongkong Post numbers', () => {
  it('takes only checksum-valid postal item numbers ending in HK', async () => {
    expect(normalizeHongkongPostNumber(' rr 000000005 hk ')).toBe(NUMBER);
    for (const number of ['RR000000006HK', 'RR000000005CN', 'RR00000005HK', '12345678901234', 'EE123456789HK', `${NUMBER}${'0'.repeat(60)}`]) {
      expect(() => normalizeHongkongPostNumber(number), number).toThrow(InvalidInputError);
    }
    const { fetcher, track } = bot();
    await expect(track('RR000000006HK')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Hongkong Post chatbot answer', () => {
  it('reads the latest status and its local clock, and nothing else', () => {
    const result = normalizeCarrierResult(parseHongkongPostAnswer(`${text('found')}<br>Signed by PRIVATE SYNTHETIC RECIPIENT, +852 0000 0000`));
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-01-03T14:05:00', expected_delivery: null,
      summary_only: true, events: [] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|\+852|http|eform/);
    expect(resolveResult(result)).toMatchObject({ current_stage: 'delivered', events: [] });
  });

  it('accepts the corrected "as at" wording and leaves wordings no rule knows unmapped', () => {
    const corrected = text('found').replace('at as  03-01-2026', 'as at 03-01-2026').replace('Delivered.', 'Item returned to sender.');
    expect(parseHongkongPostAnswer(corrected)).toMatchObject({ status: 'exception', current_stage: 'returned',
      current_stage_source: 'wording:language', last_status_text: 'Item returned to sender', last_update_local: '2026-01-03T14:05:00' });
    const unknown = parseHongkongPostAnswer(text('found').replace('Delivered.', 'Synthetic new wording.'));
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic new wording', last_update_local: '2026-01-03T14:05:00' });
    expect(unknown).not.toHaveProperty('current_stage');
    expect(unknown).not.toHaveProperty('current_stage_source');
  });

  it('maps every recorded wording with the carrier map', () => {
    for (const entry of statuses.entries) {
      expect(hongkongPostStatus(`${entry.wording}.`)?.stage, entry.wording).toBe(entry.stage);
      expect(classifyHongkongPostStatus(entry.wording).source).toBe('carrier_map');
    }
    expect(hongkongPostStatus('Out for delivery')).toBeUndefined();
  });

  it('reads the carrier\'s own answers to an unknown or rejected number', () => {
    expect(() => parseHongkongPostAnswer(text('noRecord'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHongkongPostAnswer(text('invalid'))).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseHongkongPostAnswer(text('incorrect'))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects anything else as a changed answer', () => {
    for (const answer of [
      text('prompt'), text('main'), 'Hello',
      text('found').replace('03-01-2026', '31-02-2026'),
      text('found').replace('14:05', '24:05'),
      text('found').replace('03-01-2026 14:05', '2026-01-03 14:05'),
      text('found').replace('Delivered.', '.'),
      text('found').replace('Delivered.', '<b>Delivered.</b>'),
      text('found').replace('Delivered.', 'D'.repeat(201)),
    ]) expect(() => parseHongkongPostAnswer(answer), answer.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Hongkong Post chatbot menus', () => {
  it('finds each option on the scripted path under its label', () => {
    ['language', 'main', 'tracing'].forEach((name, index) => expect(() => expectMenuOption(text(name), MAIL_TRACING_PATH[index]!)).not.toThrow());
    expect(() => expectNumberPrompt(text('prompt'))).not.toThrow();
  });

  it('treats a reordered, reworded or repeated option as a changed menu', () => {
    for (const [menu, step] of [
      [text('main').replace('3. Mail Tracing and Compensation', '3. Receiving Mail'), MAIL_TRACING_PATH[1]],
      [text('main').replace('6. ShopThruPost', '3. ShopThruPost'), MAIL_TRACING_PATH[1]],
      [text('tracing').replace('1. Mail Tracing', '1. Track a Parcel'), MAIL_TRACING_PATH[2]],
      [text('language').replace('2. 英文 / English', '2. 简体中文 / Simplified Chinese'), MAIL_TRACING_PATH[0]],
      [text('incorrect'), MAIL_TRACING_PATH[2]],
    ] as const) expect(() => expectMenuOption(menu, step)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const prompt of [text('tracing'), text('prompt').replace('Mail Tracing<br>', 'Compensation<br>')]) {
      expect(() => expectNumberPrompt(prompt)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('separates an ended or handed-over session from a malformed reply', () => {
    expect(pollMessage(replies.found)).toBe(text('found'));
    // Like an idle 408, a reply without a message means none yet.
    expect(pollMessage({ Success: false })).toBeNull();
    expect(pollMessage({ Success: false, message: null })).toBeNull();
    for (const payload of [{ ...replies.found, Status: 'SessionEnd' }, { ...replies.found, live_chat: true },
      { Success: false, Status: 'SessionEnd' }, { Success: false, live_chat: true }, { ...replies.found, Success: false }]) {
      expect(() => pollMessage(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const payload of [null, [], {}, { Success: true }, envelope(''), envelope('x'.repeat(20_001)), { ...replies.found, message: { text: 1 } }]) {
      expect(() => pollMessage(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Hongkong Post adapter', () => {
  it('walks one fresh session to Mail Tracing and sends the number last', async () => {
    const { fetcher, inputs, track } = bot();
    const result = await track(' rr000000005hk ');
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-01-03T14:05:00', summary_only: true, events: [] });
    expect(inputs).toEqual(['init', '2', '3', '1', NUMBER]);
    const calls = fetcher.mock.calls.map(([url, init]) => ({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) }));
    expect(calls.map(({ url }) => url)).toEqual(Array.from({ length: 5 }, () => [HONGKONG_POST_SEND, HONGKONG_POST_POLL]).flat());
    const sessions = new Set(calls.map(({ body }) => body.session_id));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls[0]!.body).toEqual({ session_id: [...sessions][0], channel: 'Talk2Elain', input: { type: 'text', content: 'init' },
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), remarks: null });
    expect(calls[1]!.body).toEqual({ session_id: [...sessions][0] });
    for (const { init } of calls) {
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('user-agent')).toBe(HOST_USER_AGENT);
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    // The number appears in exactly one request.
    expect(calls.filter(({ init }) => String(init.body).includes(NUMBER))).toHaveLength(1);
  });

  it('opens a new session for every lookup', async () => {
    const { fetcher, track } = bot();
    await track();
    await track();
    const sessions = new Set(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).session_id));
    expect(sessions.size).toBe(2);
  });

  it('polls again after an idle 408, a bounded number of times', async () => {
    const slow = bot({ 3: [timeout, timeout, reply('tracing')] });
    await expect(slow.track()).resolves.toMatchObject({ status: 'delivered' });
    const silent = bot({ 3: [] });
    await expect(silent.track()).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(silent.inputs).toEqual(['init', '2', '3']);
    expect(silent.fetcher.mock.calls.filter(([url]) => String(url) === HONGKONG_POST_POLL)).toHaveLength(5);
  });

  it('polls again after a reply without a message, within the same bound', async () => {
    const empty: Reply = () => json({ Success: false });
    const late = bot({ [NUMBER]: [empty, timeout, reply('found')] });
    await expect(late.track()).resolves.toMatchObject({ status: 'delivered', summary_only: true });
    expect(late.inputs).toEqual(['init', '2', '3', '1', NUMBER]);
    const never = bot({ [NUMBER]: [empty, empty, empty, reply('found')] });
    await expect(never.track()).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(never.fetcher.mock.calls.filter(([url]) => String(url) === HONGKONG_POST_POLL)).toHaveLength(7);
    await expect(bot({ [NUMBER]: [() => json({ Success: false, Status: 'SessionEnd' }), reply('found')] }).track())
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('answers not found and invalid numbers from the carrier\'s own replies', async () => {
    await expect(bot({ [NUMBER]: [reply('noRecord')] }).track()).rejects.toMatchObject({ kind: 'not_found' });
    await expect(bot({ [NUMBER]: [reply('invalid')] }).track()).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('stops before the number when the menu drifts', async () => {
    for (const answers of [
      { 2: [() => json(envelope(text('main').replace('3. Mail Tracing and Compensation', '3. Receiving Mail')))] },
      { 3: [reply('incorrect')] },
      { 1: [reply('main')] },
      { init: [reply('main')] },
    ] as Record<string, Reply[]>[]) {
      const { inputs, track } = bot(answers);
      await expect(track()).rejects.toMatchObject({ kind: 'schema' });
      expect(inputs).not.toContain(NUMBER);
    }
  });

  it('accepts only an answer that follows the number in its own session', async () => {
    // A repeated prompt or menu after the number is not an answer about it.
    for (const answer of [reply('prompt'), reply('tracing'), reply('incorrect')]) {
      await expect(bot({ [NUMBER]: [answer] }).track()).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('treats web pages and refusals as challenges', async () => {
    const page = () => new Response('<!doctype html><title>Request blocked</title>', { headers: { 'Content-Type': 'text/html' } });
    await expect(bot({}, () => page()).track()).rejects.toMatchObject({ kind: 'challenge' });
    await expect(bot({ 2: [page] }).track()).rejects.toMatchObject({ kind: 'challenge' });
    await expect(bot({}, () => new Response('<html>403 ERROR</html>', { status: 403, headers: { 'Content-Type': 'text/html' } })).track())
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps malformed replies apart from a missing parcel', async () => {
    await expect(bot({ 2: [() => new Response('not json', { headers: { 'Content-Type': 'application/json' } })] }).track())
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(bot({}, () => json({ Success: true })).track()).rejects.toMatchObject({ kind: 'schema' });
    await expect(bot({}, () => json({ data: { Success: false } })).track()).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(bot({ [NUMBER]: [() => json({ ...replies.found, Status: 'SessionEnd' })] }).track()).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps HTTP failures out of not-found', async () => {
    for (const status of [404, 410]) {
      await expect(bot({}, () => json({}, { status })).track()).rejects.toMatchObject({ kind: 'transport' });
      await expect(bot({ 1: [() => json({}, { status })] }).track()).rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(bot({}, () => json({}, { status: 429, headers: { 'Retry-After': '120' } })).track())
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    await expect(bot({ 2: [() => json({}, { status: 500 })] }).track()).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(bot({}, () => json({}, { status: 502 })).track()).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('starts nothing for a cancelled lookup and stops at the caller\'s signal or the budget', async () => {
    const { fetcher, track } = bot();
    await expect(track(NUMBER, { signal: AbortSignal.abort(new Error('caller cancelled')) })).rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();

    const hanging = vi.fn<typeof fetch>((_, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = adapter(environment(hanging)).track({ number: NUMBER }, { signal: controller.signal });
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow();
    expect(hanging).toHaveBeenCalledTimes(1);

    await expect(adapter(environment(hanging)).track({ number: NUMBER }, { budgetMs: 30 })).rejects.toMatchObject({ kind: 'budget' });
  });
});
