import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PROMPT_XPRESS_PORTAL, PromptXpressTracker } from './adapter.js';
import { normalizePromptXpressNumber, parsePromptXpress } from './parser.js';
import { promptXpressMappedStage, promptXpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RP00000011';
const IN_TRANSIT = 'MC00000022';
const UNKNOWN = 'RP00000099';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The receiver's note and the proof of delivery.
const PRIVATE = /SAMPLE|SYNTHETICPROOF|base64|Proof of delivery/i;
const CLOCK = '<p>Oct 14, 2026 9:20 AM</p>';
const withClock = (html: string, clock: string) => html.replace(CLOCK, `<p>${clock}</p>`);
const STATUS = /(<div class="visibility-status">\s*<span class="dot"><\/span>)\s*In Transit\s*(<\/div>)/;
const withStatus = (html: string, status: string) => html.replace(STATUS, `$1${status}$2`);
const BRANCH = '<strong>Kurunegala</strong>';
const NOTICE = `<div class="feedback info">No tracking data was found for <strong>${UNKNOWN}</strong>.</div>`;

describe('Prompt Xpress tracking adapter', () => {
  it('opens the portal once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PromptXpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` rp 0000-0011 `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://web.promptxpress.lk/PublicTracking/TrackingStatus?trackingNo=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'prompt-xpress', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a completed consignment as delivered, its newest movement as a wall clock, and drops the proof', () => {
    const result = parsePromptXpress(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Consignment Completed',
      last_update: null, last_update_local: '2026-10-12T16:05:00', expected_delivery: null, summary_only: true,
      events: [{ local_time: '2026-10-12T16:05:00', location: 'Matara', description: 'Consignment Completed', stage: 'delivered', stage_source: 'carrier_map' }],
    });
    // The branch that closed the consignment is no delivery time.
    expect(result).not.toHaveProperty('delivered_at');
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parsePromptXpress(page(name), number)), name).not.toMatch(PRIVATE);
    }
  });

  it('reads a parcel on its way, and its status alone when the portal has no clock or branch for it', () => {
    const result = parsePromptXpress(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'In Transit', last_update: null, last_update_local: '2026-10-14T09:20:00', summary_only: true,
      events: [{ local_time: '2026-10-14T09:20:00', location: 'Kurunegala', description: 'In Transit', stage: 'in_transit' }] });
    const placeless = parsePromptXpress(page('in-transit').replace(BRANCH, '<strong>-</strong>'), IN_TRANSIT);
    expect(placeless.events).toEqual([{ local_time: '2026-10-14T09:20:00', description: 'In Transit', stage: 'in_transit', stage_source: 'wording:language' }]);
    const undated = parsePromptXpress(withClock(page('in-transit'), 'No timestamp available yet.'), IN_TRANSIT);
    expect(undated).toMatchObject({ status: 'in_transit', last_status_text: 'In Transit', last_update: null, summary_only: true, events: [] });
    expect(undated).not.toHaveProperty('last_update_local');
    // Wording neither the map nor the shared rules know stays without a stage.
    const unknown = parsePromptXpress(withStatus(page('in-transit'), 'Manifest Prepared'), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Manifest Prepared', events: [{ description: 'Manifest Prepared' }] });
    expect(unknown).not.toHaveProperty('current_stage');
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('reads the portal’s twelve-hour clock without inventing its zone, and rejects any other', () => {
    const scan = (clock: string) => parsePromptXpress(withClock(page('in-transit'), clock), IN_TRANSIT).events![0]!;
    const at = (clock: string) => scan(clock).local_time;
    expect(at('Oct 2, 2026 12:05 AM')).toBe('2026-10-02T00:05:00');
    expect(at('Oct 02, 2026 12:30 PM')).toBe('2026-10-02T12:30:00');
    expect(at('Dec 31, 2026 11:59 PM')).toBe('2026-12-31T23:59:00');
    expect(scan('Dec 31, 2026 11:59 PM')).not.toHaveProperty('time');
    for (const clock of ['Feb 30, 2026 9:20 AM', 'Foo 14, 2026 9:20 AM', 'Oct 14, 2026 13:20 PM', 'Oct 14, 2026 0:20 AM', 'Oct 14, 2026 9:75 AM',
      'Oct 14, 2026 09:20', '14/10/2026 9:20 AM', 'Oct 14, 2026', '']) {
      expect(() => at(clock), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the page to the requested number', () => {
    expect(() => parsePromptXpress(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const delivered = page('delivered');
    for (const html of [
      // The field, the result, the summary's badge or the proof's reference names another number.
      delivered.replace(`value="${DELIVERED}"`, `value="${IN_TRANSIT}"`),
      delivered.replace(`value="${DELIVERED}"`, `value="${DELIVERED}${','.repeat(60)}${IN_TRANSIT}"`),
      delivered.replace(`<div class="tracking-main">${DELIVERED}</div>`, `<div class="tracking-main">${DELIVERED}0</div>`),
      delivered.replace(`<span class="tracking-badge">${DELIVERED}</span>`, `<span class="tracking-badge">${IN_TRANSIT}</span>`),
      delivered.replace(`<strong>${DELIVERED}</strong>`, `<strong>${IN_TRANSIT}</strong>`),
      // The page did not get the number.
      delivered.replace(`value="${DELIVERED}"`, 'value=""').replace(`<div class="tracking-main">${DELIVERED}</div>`, '<div class="tracking-main">Ready for lookup</div>'),
    ]) {
      expect(() => parsePromptXpress(html, DELIVERED), html.length.toString()).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('reads only the portal’s notice naming the number as a missing parcel, and a block page as a challenge', () => {
    expect(() => parsePromptXpress(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice for another number is inconclusive, and so is any other notice.
    expect(() => parsePromptXpress(page('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of [
      page('not-found').replace(`<strong>${UNKNOWN}</strong>.`, `<strong>${DELIVERED}</strong>.`),
      page('not-found').replace(NOTICE, `${NOTICE}${NOTICE}`),
      page('not-found').replace(NOTICE, '<div class="feedback error">The tracking service is not available right now.</div>'),
    ]) {
      expect(() => parsePromptXpress(html, UNKNOWN), html.length.toString()).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const malformed: [string, string][] = [
      // A shipment under the notice.
      [page('not-found').replace('</main>', `<section class="page-content"><span class="tracking-badge">${UNKNOWN}</span></section></main>`), UNKNOWN],
      // A page without its status, or with the not-found page's placeholders and no notice.
      [page('not-found').replace(NOTICE, ''), UNKNOWN],
      [withStatus(page('in-transit'), ''), IN_TRANSIT],
      // A figure missing or repeated, or the result laid out otherwise.
      [page('in-transit').replace('<div class="mini-label">Current Branch</div>', '<div class="mini-label">Branch</div>'), IN_TRANSIT],
      [page('in-transit').replace('<div class="mini-label">Visibility Depth</div>', '<div class="mini-label">Current Branch</div>'), IN_TRANSIT],
      [page('in-transit').replace('<div class="visibility-board">', '<div class="board">'), IN_TRANSIT],
      [page('in-transit').replace('class="search-panel"', 'class="search"'), IN_TRANSIT],
      ['<html><body>Maintenance</body></html>', IN_TRANSIT],
      ['{"status":"Delivered"}', IN_TRANSIT],
    ];
    for (const [html, number] of malformed) {
      expect(() => parsePromptXpress(html, number), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><body><div class="cf-turnstile" data-sitekey="SYNTHETIC"></div></body></html>']) {
      expect(() => parsePromptXpress(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes Prompt Xpress’s layouts and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['RP1234567', 'RP123456789', 'SP1234567', 'SP1234567890', 'XX12345678', '1234567890', `${DELIVERED},${IN_TRANSIT}`, 'R'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePromptXpressNumber('nc 1000-0000')).toBe('NC10000000');
    expect(normalizePromptXpressNumber('SP10000000')).toBe('SP10000000');
    expect(normalizePromptXpressNumber('SP100000000')).toBe('SP100000000');
  });

  it('recognizes a known parcel and the not-found notice, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-10-14T09:20:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/Home/Error' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps empty pages and oversized replies apart from missing parcels', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"status":"Delivered"}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(UNKNOWN), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(4 * 1024 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Prompt Xpress to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('in-transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: IN_TRANSIT, carrier: 'prompt-xpress' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'prompt-xpress', source: 'prompt-xpress', result: { current_stage: 'in_transit' },
      attempts: [{ source: 'prompt-xpress', kind: 'ok' }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${PROMPT_XPRESS_PORTAL}?trackingNo=${IN_TRANSIT}`);
  });
});

describe('Prompt Xpress numbers', () => {
  it('suggests the published layouts at low confidence, and not SP with eight digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT, 'NC10000000', 'SP100000000']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['prompt-xpress']) });
    }
    expect(detectCarrierMatch('SP10000000').candidates).not.toContain('prompt-xpress');
  });

  it('reads the number from a portal link', () => {
    for (const link of [`https://web.promptxpress.lk/PublicTracking/TrackingStatus?trackingNo=${DELIVERED}`,
      `https://web.promptxpress.lk/publictracking/trackingstatus?trackingNo=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'prompt-xpress', source: 'link' });
    }
  });
});

describe('Prompt Xpress status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(promptXpressMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(promptXpressMappedStage('  CONSIGNMENT   completed ')).toBe('delivered');
    for (const wording of ['constructor', 'toString', 'Consignment', 'Consignment Completed later', 'Status unavailable']) {
      expect(promptXpressMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'consignment completed')).toBeUndefined();
    // Other wording goes to the shared rules, and wording they do not know either stays without a stage.
    expect(promptXpressStage('Consignment Completed')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(promptXpressStage('Out for Delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(promptXpressStage('Manifest Prepared')).toBeNull();
    expect(statusMapAnswer({ carrier: 'prompt-xpress', description: 'Consignment Completed' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
