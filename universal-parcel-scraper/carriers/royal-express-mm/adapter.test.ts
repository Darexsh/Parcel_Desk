import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ROYAL_EXPRESS_TRACKING, RoyalExpressTracker } from './adapter.js';
import { normalizeRoyalExpressNumber, parseRoyalExpress, royalExpressFormToken } from './parser.js';
import { royalExpressMappedStage, royalExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'YGN00000001MDY';
const IN_TRANSIT = 'AAA000001';
const UNKNOWN = 'YGN00000000MDY';
const TOKEN = 'SyntheticFormToken0000000000000000000000';
const SESSION = 'royal_express_session=SyntheticSession0000000000000000%3D%3D';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const page = () => html(fixture('page'), { headers: { 'Set-Cookie': `${SESSION}; expires=Thu, 12 Feb 2026 10:00:00 GMT; Max-Age=7200; path=/; httponly; samesite=lax` } });
/** The page, then the given answer to its form. */
const flow = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? answer() : page()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Royal Express HTTP adapter', () => {
  it('reads the page’s token and session, then posts the waybill with them, through the supplied transport', async () => {
    const fetcher = flow(() => html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RoyalExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ygn 00000001 mdy ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [formUrl, formInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([String(pageUrl), String(formUrl)]).toEqual([ROYAL_EXPRESS_TRACKING, ROYAL_EXPRESS_TRACKING]);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(formInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: SESSION, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(formInit.body)))).toEqual({ _token: TOKEN, 'waybill-number': DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'royal-express-mm', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first, with the office as each scan’s location and wall clocks kept local', () => {
    const result = parseRoyalExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'အောင်မြင်စွာ ပို့ဆောင်ပြီးပါပြီ။', last_update: null, last_update_local: '2026-02-12T15:06:38', expected_delivery: null,
    });
    expect(result.events!.map(({ local_time: local, provider_code: code, stage }) => [local, code, stage])).toEqual([
      ['2026-02-12T15:06:38', 'delivery-completed', 'delivered'],
      ['2026-02-12T14:56:36', 'delivery-ongoing', 'out_for_delivery'],
      ['2026-02-12T09:09:45', 'delivery-accepted', 'in_transit'],
      ['2026-02-11T13:34:24', 'delivery-reattempted', 'in_transit'],
      ['2026-02-11T12:44:35', 'delivery-rejected', 'failed_attempt'],
      ['2026-02-11T09:04:18', 'delivery-accepted', 'in_transit'],
      ['2026-02-10T12:36:45', 'transit-inbound received', 'in_transit'],
      ['2026-02-10T09:33:29', 'transit-inbound received', 'in_transit'],
      ['2026-02-09T19:59:48', 'transit-outbound received', 'in_transit'],
      ['2026-02-09T13:39:15', 'transit-outbound collected', 'accepted'],
      ['2026-02-09T11:02:10', 'pickup-completed', 'accepted'],
    ]);
    expect(result.events![0]).toEqual({ local_time: '2026-02-12T15:06:38', location: 'MDY-C9', description: 'အောင်မြင်စွာ ပို့ဆောင်ပြီးပါပြီ။',
      provider_code: 'delivery-completed', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.map((event) => event.location)).toEqual([
      'MDY-C9', 'MDY-C9', 'MDY-C9', 'MDY-C9', 'MDY-C9', 'MDY-C9', 'MDY-C9', 'MDY-ST9', 'YGN-HB9 (ရန်ကုန်)',
      'YGN-C9 (ရန်ကုန် (အရှေ့ပိုင်း))', 'YGN-C9',
    ]);
    // No offset is known, the sender, receiver and recipient are not kept, and a scan the page repeats counts once.
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Shop|Example|EXAMPLE|Yangon|Mandalay/);
  });

  it('reads a history still on its way, under a member waybill shown without its sender or receiver', () => {
    expect(parseRoyalExpress(fixture('in-transit'), IN_TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'စာဝင်လက်ခံရရှိပါသည်။', last_update: null, last_update_local: '2026-03-02T08:27:14', expected_delivery: null,
      events: [
        { local_time: '2026-03-02T08:27:14', location: 'YGN-C8 (ရန်ကုန် (မြောက်ပိုင်း))', description: 'စာဝင်လက်ခံရရှိပါသည်။',
          provider_code: 'transit-inbound received', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-28T13:32:51', location: 'YGN-HB9 (ရန်ကုန်)', description: 'စာဝင်လက်ခံရရှိပါသည်။',
          provider_code: 'transit-outbound received', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-02-28T10:00:35', location: 'YGN-C9 (ရန်ကုန် (အရှေ့ပိုင်း))', description: 'စာဝင်လက်ခံရရှိပါသည်။',
          provider_code: 'transit-outbound collected', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps a scan whose code it does not know without a stage, staging the parcel by its newest staged scan', () => {
    const changed = fixture('in-transit').replace('class="text-danger">Transit</span>\n                                    -<span class="fw-semibold">inbound received',
      'class="text-danger">return</span>\n                                    -<span class="fw-semibold">accepted');
    const result = parseRoyalExpress(changed, IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: 'return-accepted', description: 'စာဝင်လက်ခံရရှိပါသည်။' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'စာဝင်လက်ခံရရှိပါသည်။' });
    // A sentence without an office keeps its whole wording and no location.
    const officeless = parseRoyalExpress(fixture('in-transit').replace('YGN-C8(ရန်ကုန် (မြောက်ပိုင်း)) ရုံးမှ ', ''), IN_TRANSIT);
    expect(officeless.events![0]).toMatchObject({ description: 'စာဝင်လက်ခံရရှိပါသည်။', provider_code: 'transit-inbound received' });
    expect(officeless.events![0]).not.toHaveProperty('location');
    // Phone numbers are dropped from a sentence.
    const phone = parseRoyalExpress(fixture('in-transit').replace('ရုံးမှ စာဝင်', 'ရုံးမှ ၀၉ ၀၀၀ ၀၀၀ ၀၀၀ စာဝင်'), IN_TRANSIT);
    expect(phone.events![0]!.description).toBe('စာဝင်လက်ခံရရှိပါသည်။');
  });

  it('reads the tracker’s line for the waybill asked as not found, and nothing else', async () => {
    expect(() => parseRoyalExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRoyalExpress(fixture('not-found'), 'yGN00000000mdy')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRoyalExpress(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRoyalExpress(fixture('page'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRoyalExpress(CHALLENGE, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(carrier(flow(() => html(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a parcel for another waybill, without its waybill, scans or a valid clock', () => {
    expect(() => parseRoyalExpress(fixture('delivered'), 'YGN00000002MDY')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRoyalExpress(fixture('delivered').replace(` ${DELIVERED}</span>`, '</span>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRoyalExpress(fixture('in-transit').replace(/<li class="event"[\s\S]*<\/li>/, ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const clock of ['2026-02-30 08:27:14', '2026-03-02 24:00:00', '02/03/2026 08:27:14', '2026-03-02']) {
      expect(() => parseRoyalExpress(fixture('in-transit').replace('2026-03-02 08:27:14', clock), IN_TRANSIT), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps blocks, rate limits, moved routes and a refused form apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(flow(answer)).track({ number: DELIVERED });
    await expect(lookup(() => html(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Too Many Requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('Page Expired', { status: 419 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: ROYAL_EXPRESS_TRACKING } }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html('<html><body><h1>Royal Express</h1></body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html('Server Error', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('needs the page’s form and session before it posts', async () => {
    const without = (first: Response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(first);
      return { fetcher, lookup: carrier(fetcher).track({ number: DELIVERED }) };
    };
    const noSession = without(html(fixture('page')));
    await expect(noSession.lookup).rejects.toMatchObject({ kind: 'schema' });
    const noForm = without(html('<html><body>Maintenance</body></html>', { headers: { 'Set-Cookie': `${SESSION}; path=/` } }));
    await expect(noForm.lookup).rejects.toMatchObject({ kind: 'schema' });
    const blocked = without(html(CHALLENGE));
    await expect(blocked.lookup).rejects.toMatchObject({ kind: 'challenge' });
    const moved = without(html('', { status: 301, headers: { Location: 'https://royalx.net/' } }));
    await expect(moved.lookup).rejects.toMatchObject({ kind: 'transport' });
    for (const { fetcher } of [noSession, noForm, blocked, moved]) expect(fetcher).toHaveBeenCalledTimes(1);
    expect(royalExpressFormToken(fixture('page'))).toBe(TOKEN);
  });

  it('starts again with a new page once when Royal Express cannot be reached, inside the caller’s budget', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return init?.method === 'POST' ? html(fixture('delivered')) : page();
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new RoyalExpressTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET', 'POST']);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('rejects what is not a Royal Express waybill, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '00000000000000', 'AAA00000', 'AAA000000000000', 'AA0000000MDY', 'YGN00000000MD', 'YGN0000000TKI/AAA000000',
      `YGN${'0'.repeat(70)}`, 'YGN00000000MDÝ']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRoyalExpressNumber(' aaa-000 001 ')).toBe(IN_TRANSIT);
    expect(normalizeRoyalExpressNumber('YGN00000000000MDY')).toBe('YGN00000000000MDY');
    expect(normalizeRoyalExpressNumber('YGN0000000TKI')).toBe('YGN0000000TKI');
  });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for a number Royal Express does not issue', async () => {
    const answers = [fixture('delivered'), fixture('not-found')];
    const fetcher = flow(() => html(answers.shift()!));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-12T15:06:38' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('00000000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const blocked = flow(() => html('', { status: 429 }));
    await expect(carrier(blocked).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('answers a waybill filed under Royal Express, and leaves its shapes unclaimed', async () => {
    const fetcher = flow(() => html(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'royal-express-mm' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'royal-express-mm', source: 'royal-express-mm', result: { current_stage: 'delivered' } });
    for (const number of [DELIVERED, IN_TRANSIT, 'YGN00000000000MDY']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('royal-express-mm');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('royal-express-mm');
    }
  });
});

describe('Royal Express status vocabulary', () => {
  it('maps every recorded code to the stage it records', () => {
    const entries = statuses.entries as { code: string; wording: string; stage: string; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live')).toHaveLength(entries.length);
    for (const entry of entries) {
      expect(royalExpressMappedStage(entry.code), entry.code).toBe(entry.stage);
      expect(royalExpressStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'royal-express-mm', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'royal-express-mm', providerCode: 'return-accepted', description: 'စာဝင်လက်ခံရရှိပါသည်။' }))
      .toEqual({ kind: 'unknown' });
    expect(royalExpressStage('return-accepted', 'စာဝင်လက်ခံရရှိပါသည်။')).toBeNull();
  });
});
