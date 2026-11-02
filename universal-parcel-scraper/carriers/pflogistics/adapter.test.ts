import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { carrierErrorKind, UpstreamHttpError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PFLOGISTICS_RESULT, PflogisticsTracker, pflogisticsUrl } from './adapter.js';
import { pflogisticsNumber } from './number.js';
import { parsePflogistics, PFLOGISTICS_MAX_BYTES } from './parser.js';
import { pflogisticsMappedStage, pflogisticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'NEXAU1000000017YQ';
const TRANSIT = 'NEXAU2000000017YQ';
const ABSENT = 'NEXAU1000000025YQ';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Parcel Freight Logistics adapter', () => {
  it('requests one whole parcel in UTC through the supplied transport and records its step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PflogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(' nexau 1000 0000 17 yq ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PFLOGISTICS_RESULT}?tracking=${DELIVERED}&timezone=UTC`);
    expect(String(url)).toBe(pflogisticsUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pflogistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest scan and complete expanded history, with specific wording and UTC clocks', () => {
    const result = parsePflogistics(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been left at a safe place (ATL)', last_update: '2026-03-11T05:31:48Z',
      delivered_at: '2026-03-11T05:31:48Z', expected_delivery: null, timezone: 'UTC' });
    expect(result.events!.map(event => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-11T05:31:48Z', 'Your parcel has been left at a safe place (ATL)', 'Sampleton', 'delivered'],
      ['2026-03-11T01:02:27Z', 'Our driver has your parcel onboard for delivery', undefined, 'out_for_delivery'],
      ['2026-03-10T23:09:13Z', 'Your parcel has arrived at Sample Hub depot', 'Sample Hub', 'in_transit'],
      ['2026-03-10T21:21:52Z', 'Your parcel has been picked up', 'Sample Hub', 'accepted'],
      ['2026-03-10T20:45:12Z', 'Import Customs Handover', undefined, 'in_transit'],
      ['2026-03-10T19:46:52Z', 'Import Customs Clearance Success', undefined, 'in_transit'],
    ]);
    expect(result.events!.every(event => event.stage_source === 'carrier_map' && !event.local_time && !event.provider_code)).toBe(true);
    expect(result.summary_only).toBeUndefined();
    expect(result.history_truncated).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC RECIPIENT|Example Road|example\.invalid|NEXAU|Next delivery/);
  });

  it('distinguishes pre-advice, pickup and depot processing beneath the same heading', () => {
    const result = parsePflogistics(fixture('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-07-09T06:15:03Z' });
    expect(result.events!.map(event => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.delivered_at).toBeUndefined();
    const $ = load(fixture('in-transit'));
    $('.grey-border.extra-padding').first().remove();
    expect(parsePflogistics($.html(), TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Your Parcel has been processed at facilty' });
    $('.grey-border.extra-padding').first().remove();
    expect(parsePflogistics($.html(), TRANSIT)).toMatchObject({ current_stage: 'accepted' });
    $('.grey-border.extra-padding').first().remove();
    expect(parsePflogistics($.html(), TRANSIT)).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('preserves stated offsets and keeps same-clock order while sorting distinct clocks', () => {
    const $ = load(fixture('delivered'));
    const rows = $('.grey-border.extra-padding');
    rows.eq(0).find('.res-right p').text('2026-03-11 13:31:48+08:00');
    rows.eq(1).find('.res-right p').text('2026-03-11 05:31:48Z');
    const result = parsePflogistics($.html(), DELIVERED);
    expect(result.events!.slice(0, 2).map(event => event.time)).toEqual(['2026-03-11T13:31:48+08:00', '2026-03-11T05:31:48Z']);
    expect(result.delivered_at).toBe('2026-03-11T13:31:48+08:00');
    const older = load(fixture('in-transit'));
    older('.grey-border.extra-padding').get().reverse().forEach(row => older('.result-box').last().append(row));
    expect(parsePflogistics(older.html(), TRANSIT).events).toEqual(parsePflogistics(fixture('in-transit'), TRANSIT).events);
  });

  it('requires the whole result reference and rejects ambiguous or changed notices', () => {
    expect(parsePflogistics(fixture('delivered').replace(`>${DELIVERED}<`, '> nexau 1000 0000 17 yq <'), DELIVERED).events).toHaveLength(6);
    for (const identity of [ABSENT, `${DELIVERED}0`, `${DELIVERED}${' '.repeat(200)}X`]) {
      expect(() => parsePflogistics(fixture('delivered').replace(`>${DELIVERED}<`, `>${identity}<`), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parsePflogistics(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePflogistics(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePflogistics(fixture('not-found').replace("We couldn't find your tracking number", 'Please try again later'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const duplicate = load(fixture('delivered'));
    duplicate('body').append(duplicate('#res-shadow-box').clone());
    expect(() => parsePflogistics(duplicate.html(), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects malformed rows and clocks without turning them into a missing parcel', () => {
    for (const clock of ['2026-02-30 12:00:00', '2026-03-11 24:00:00', '2026-03-11 05:31:48+08:99', '2026-03-11', 'now']) {
      const $ = load(fixture('delivered'));
      $('.res-right p').first().text(clock);
      expect(() => parsePflogistics($.html(), DELIVERED), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const selector of ['#tracking-number', '.res-right p', '.res-mid p', '.res-left p', '[id="main-status"]']) {
      const $ = load(fixture('delivered'));
      $(selector).first().remove();
      expect(() => parsePflogistics($.html(), DELIVERED), selector).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = load(fixture('delivered'));
    empty('.grey-border.extra-padding').remove();
    expect(() => parsePflogistics(empty.html(), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePflogistics('<p>We couldn\'t find your tracking number</p>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePflogistics('x'.repeat(PFLOGISTICS_MAX_BYTES + 1), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('deduplicates identical rows and marks bounded output as truncated', () => {
    const $ = load(fixture('in-transit'));
    const row = $('.grey-border.extra-padding').first();
    $('#expand-box').append(row.clone());
    expect(parsePflogistics($.html(), TRANSIT).events).toHaveLength(4);
    for (let i = 0; i < 100; i++) {
      const copy = row.clone();
      copy.find('.res-left p').text(`Parcel scan ${i}`);
      $('#expand-box').append(copy);
    }
    expect(parsePflogistics($.html(), TRANSIT)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parsePflogistics($.html(), TRANSIT).events).toHaveLength(100);
    for (let i = 0; i < 100; i++) $('#expand-box').append(row.clone());
    expect(() => parsePflogistics($.html(), TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recognizes a dated parcel and the exact unknown notice through HTTP only', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-11T05:31:48.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${PFLOGISTICS_RESULT}?tracking=NEXAU`))).toBe(true);
  });

  it('routes a recent whole-reference history through HTTP recognition with providers disabled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-12T12:00:00Z'));
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
        if (new URL(String(input)).hostname !== 'pflogistics.com.au') throw new Error('Synthetic transport refuses other hosts');
        return reply(fixture('delivered'));
      });
      const answer = await createTracker({ fetcher, providers: [], env: {}, trawlUrl: '', chromiumPath: '' }).track({ number: DELIVERED });
      expect(answer).toMatchObject({ carrier: 'pflogistics', source: 'pflogistics', result: { current_stage: 'delivered' } });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('accepts only the existing NEXAU family without claiming other forwarding prefixes', async () => {
    expect(pflogisticsNumber('nexau-1000000017-yq')).toBe(DELIVERED);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['NEXUS1000000017YQ', 'ABCAU1000000017YQ', 'NEXAU1000000017', 'NEXAU10000000170YQ', '123456789012', 'x'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps HTTP failures, redirects and block pages distinct from the carrier absence notice', async () => {
    const cases: [() => Response, string][] = [
      [() => reply(fixture('not-found')), 'not_found'],
      [() => new Response(null, { status: 302, headers: { Location: '/tracking' } }), 'indeterminate'],
      [() => reply('Not Found', 404), 'transport'],
      [() => reply('', 200), 'indeterminate'],
      [() => new Response(null, { status: 204 }), 'indeterminate'],
      [() => reply('<title>Just a moment...</title><p>Challenge</p>'), 'challenge'],
      [() => reply('<title>Access Denied</title>'), 'challenge'],
      [() => reply('<title>Server error</title><p>We couldn\'t find your tracking number</p>'), 'schema'],
      [() => reply('Busy', 429), 'rate_limited'],
      [() => reply('Unavailable', 503), 'maintenance'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('retries only network failures within the shared budget and keeps recovery provenance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PflogisticsTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'transport' }));
    const controller = new AbortController();
    const slow = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const pending = carrier(slow).track({ number: DELIVERED }, { signal: controller.signal, budgetMs: 1000 });
    controller.abort(new Error('Synthetic cancellation'));
    expect(carrierErrorKind(await pending.catch((error: unknown) => error))).toBe('transport');
    expect(slow).toHaveBeenCalledTimes(1);
    const hanging = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(hanging).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(hanging.mock.calls.length).toBeLessThanOrEqual(2);
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s failure metadata without recipient details in errors or telemetry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${fixture('delivered')}<p>Too many requests</p>`, {
        status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '23', 'X-Request-ID': 'synthetic-request' },
      }));
      const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
      const error: unknown = await new PflogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
        .fetch(DELIVERED).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UpstreamHttpError);
      expect(error).toMatchObject({ kind, provider: 'Parcel Freight Logistics', status, retryAfterMs: 23_000,
        diagnostics: { content_type: 'text/html', body_read: 'complete', body_signals: ['rate_limit_message'],
          request_ids: { 'x-request-id': 'synthetic-request' }, body_excerpt: undefined },
        request: { url: pflogisticsUrl(DELIVERED), method: 'GET', headers: { accept: 'text/html', 'user-agent': 'SyntheticHost/1.0' } },
      });
      expect(error).not.toHaveProperty('cause');
      expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: kind, error }));
      expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ finalStep: 'direct', outcome: kind, attempts: 1, error }));
      expect(inspect([error, recorder.step.mock.calls, recorder.lookup.mock.calls], { depth: 15 }))
        .not.toMatch(/SYNTHETIC RECIPIENT|Example Road|private-note@example\.invalid/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

describe('Parcel Freight Logistics status vocabulary', () => {
  it('maps recorded wording and lets detail refine broad headings', () => {
    for (const entry of statuses.entries) {
      expect(pflogisticsMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
    }
    expect(pflogisticsStage('Received and ready for processing', 'Your parcel has been picked up')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(pflogisticsStage('Delivered', 'Delivery attempt unsuccessful')).toMatchObject({ stage: 'failed_attempt' });
    expect(pflogisticsStage('In Transit', 'Parcel damaged')).toMatchObject({ stage: 'exception' });
    expect(pflogisticsStage('Unfamiliar heading', 'Unfamiliar wording')).toBeNull();
    expect(statusMap.stage('X', 'Delivered')).toBeUndefined();
    for (const wording of ['constructor', 'toString', 'Your parcel has arrived at Sample depot then left']) {
      expect(pflogisticsMappedStage(wording)).toBeUndefined();
    }
  });
});
