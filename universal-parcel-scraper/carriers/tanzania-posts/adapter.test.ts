import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TANZANIA_POSTS_LOOKUP, TanzaniaPostsTracker } from './adapter.js';
import { normalizeTanzaniaPostsNumber, parseTanzaniaPostsPanel, parseTanzaniaPostsReply } from './parser.js';
import { statusMap, tanzaniaPostsStage, tanzaniaPostsWordingStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'EE000000014TZ';
const MOVING = 'RR000000005TZ';
const UNKNOWN = 'AA000000005TZ';
const UNPAID = 'CP000000005TZ';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// The lookup's reply: JSON after a few blank characters, the panel as HTML in `temp`.
const reply = (temp: string) => ` \n\n${JSON.stringify({ status: 'Success', temp })}`;
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status,
  headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const panels: Record<string, string> = { [DELIVERED]: fixture('delivered.html'), [MOVING]: fixture('in-transit.html') };
/** The tracker's lookup: the panel for a code it holds, its notices otherwise. */
const site = (answer?: (number: string) => Response | Promise<Response>) => vi.fn<typeof fetch>(async (_input, init) => {
  const number = new URLSearchParams(String(init?.body)).get('code') ?? '';
  if (answer) return answer(number);
  if (panels[number]) return html(reply(panels[number]));
  return html(fixture(number === UNPAID ? 'unpaid.json' : 'not-found.json'));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const edited = (name: string, change: (html: string) => string) => change(fixture(name));
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const PHP_ERROR = '<div style="border:1px solid #990000;"><h4>A PHP Error was encountered</h4><p>Severity: Notice</p></div>';
const MISSING_ROUTE = '<html><head><title> Posta Tracking System | 404 </title></head><body>Sample page</body></html>';

describe('Tanzania Posts Corporation tracking adapter', () => {
  it('posts the whole code to the search form’s lookup, as the page does', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TanzaniaPostsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ee 000 000 014 tz ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TANZANIA_POSTS_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `code=${DELIVERED}` });
    const headers = new Headers(init!.headers);
    expect(headers.get('user-agent')).toBe('SyntheticHost/1.0');
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
    expect(headers.has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tanzania-posts', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered item newest first on Dar es Salaam’s clock, without anyone’s details', async () => {
    const result = await carrier(site()).track({ number: DELIVERED });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-05T07:30:00+03:00', expected_delivery: null, weight_kg: 0.25,
      destination_country: 'TZ' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('summary_only');
    // The scan listed twice is kept once, and the counter scan's office is its place.
    expect(result.events!.map((event) => [event.time, event.location ?? null, event.description, event.stage])).toEqual([
      ['2026-03-05T07:30:00+03:00', null, 'Received at Destination office', 'in_transit'],
      ['2026-03-04T16:10:45+03:00', null, 'On Transit to destination region (Dodoma)', 'in_transit'],
      ['2026-03-04T15:20:30+03:00', null, 'Received at Office of Dispatch', 'in_transit'],
      ['2026-03-02T12:40:00+03:00', null, 'On Transit to destination region (Arusha)', 'in_transit'],
      ['2026-03-02T09:05:10+03:00', 'Sample Hpo', 'Acceptance', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    // The sender, the addressee, who took delivery, their phone numbers, addresses and identity document, and the delivery day are not read.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE SENDER|SAMPLE ADDRESSEE|SAMPLE SIGNER|SAMPLE ID|0000000000|Friday|Document|Sample GPO/);
  });

  it('reads an item on its way by its newest scan', async () => {
    const result = await carrier(site()).track({ number: MOVING });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'On Transit to destination region (Dar es Salaam)', last_update: '2026-03-10T18:02:09+03:00', weight_kg: 1.5,
      destination_country: 'TZ' });
    expect(result.events!.map((event) => [event.time, event.description])).toEqual([
      ['2026-03-10T18:02:09+03:00', 'On Transit to destination region (Dar es Salaam)'],
      ['2026-03-10T11:15:00+03:00', 'Acceptance'],
    ]);
  });

  it('keeps the wall clocks of an item that does not stay in Tanzania', () => {
    const abroad = parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace('Dodoma - Branch: Sample GPO', 'Kenya')), DELIVERED);
    expect(abroad).toMatchObject({ last_update: null, last_update_local: '2026-03-05T07:30:00', destination_country: 'KE' });
    expect(abroad.events!.every((event) => !event.time && typeof event.local_time === 'string')).toBe(true);
    expect(abroad.events!.at(-1)).toMatchObject({ local_time: '2026-03-02T09:05:10' });
    // An origin or destination the page does not name, or names as a place that is no region, keeps the wall clocks too.
    const unnamed = parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace('Arusha - Branch: Sample Hpo', '')
      .replace('Dodoma - Branch: Sample GPO', 'Sample Place - Branch: Sample Office')), DELIVERED);
    expect(unnamed).toMatchObject({ last_update: null, last_update_local: '2026-03-05T07:30:00' });
    expect(unnamed).not.toHaveProperty('destination_country');
    const zanzibar = parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace('Dodoma - Branch', 'Mjini Magharibi - Branch')), DELIVERED);
    expect(zanzibar).toMatchObject({ last_update: '2026-03-05T07:30:00+03:00', destination_country: 'TZ' });
  });

  it('reads the clock’s hour as the page prints it', () => {
    const newest = (clock: string) => parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace('Thursday 5 March 2026, 07:30:00 AM', clock)),
      DELIVERED).events![0]!.time;
    expect(newest('Thursday 5 March 2026, 12:05:00 PM')).toBe('2026-03-05T12:05:00+03:00');
    expect(newest('Thursday 5 March 2026, 00:05:00 AM')).toBe('2026-03-05T00:05:00+03:00');
    // A 12-hour clock gives the same hours.
    expect(newest('Thursday 5 March 2026, 03:05:00 PM')).toBe('2026-03-05T15:05:00+03:00');
    expect(newest('Thursday 5 March 2026, 12:05:00 AM')).toBe('2026-03-05T00:05:00+03:00');
    for (const clock of ['Thursday 5 March 2026, 15:05:00 AM', 'Thursday 5 March 2026, 00:05:00 PM', 'Thursday 5 March 2026, 24:00:00 PM',
      'Friday 5 March 2026, 07:30:00 AM', 'Monday 30 February 2026, 07:30:00 AM', 'Thursday 5 March 2026, 07:30 AM', '2026-03-05 07:30:00',
      'Thursday 5 Sample 2026, 07:30:00 AM', '']) {
      expect(() => newest(clock), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a panel without scans as a summary, and one without a status or scans as no history', () => {
    const history = /<div class='table-responsive'>[\s\S]*<\/table>/;
    const summary = parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace(history, '')), DELIVERED);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: null,
      summary_only: true, events: [] });
    const unknown = parseTanzaniaPostsPanel(edited('in-transit.html', (text) => text.replace(history, '').replace('On Transit </p>', 'Sample status</p>')), MOVING);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample status', summary_only: true });
    expect(unknown).not.toHaveProperty('current_stage');
    expect(() => parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace(history, '').replace('>Delivered</p>', '></p>')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A status the map does not settle leaves the newest scan's stage; a weight the page leaves blank is none.
    const scanned = parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace('>Delivered</p>', '>Sample status</p>')
      .replace('<td> 0.25  </td>', '<td>  </td>')), DELIVERED);
    expect(scanned).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received at Destination office' });
    expect(scanned).not.toHaveProperty('weight_kg');
  });

  it('reads the tracker’s notice for a code it does not hold as missing, and an unpaid charge as withheld', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const error = await carrier(site()).track({ number: UNPAID }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'indeterminate', reason: 'tracking_withheld' });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/TZS|000000000000|Control/);
  });

  it('never reads a block page, an error page or another reply as a missing item', async () => {
    const outcomes: [string, Response, string][] = [
      ['block page', html(CHECK), 'challenge'],
      ['PHP error before the reply', html(`${PHP_ERROR}${fixture('not-found.json')}`), 'schema'],
      ['error page with 500', html(PHP_ERROR, 500), 'schema'],
      ['failure with 500', html('<html><body>Sample failure</body></html>', 500), 'indeterminate'],
      ['missing route page', html(MISSING_ROUTE), 'schema'],
      ['search page', html('<html><head><title>Posta Tracking System | PTS </title></head><body>Sample</body></html>'), 'schema'],
      ['empty reply', html(''), 'schema'],
      ['another notice', html(JSON.stringify({ status: 'Error', msg: 'Sample notice' })), 'schema'],
      ['notice without wording', html(JSON.stringify({ status: 'Error' })), 'schema'],
      ['another status', html(JSON.stringify({ status: 'Sample', temp: fixture('delivered.html') })), 'schema'],
      ['success without the panel', html(JSON.stringify({ status: 'Success' })), 'schema'],
      ['panel without the item', html(reply('<table><tr><td>Sample</td></tr></table>')), 'schema'],
      ['array', html('[]'), 'schema'],
    ];
    for (const [name, response, kind] of outcomes) {
      const fetcher = site(() => response.clone());
      await expect(carrier(fetcher).track({ number: DELIVERED }), name).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects a panel for another item and a changed panel', () => {
    expect(() => parseTanzaniaPostsReply(reply(fixture('delivered.html')), MOVING)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The tracker may store a code in lower case, which still names the item.
    expect(parseTanzaniaPostsPanel(edited('delivered.html', (text) => text.replace('EE000000014TZ', 'ee000000014tz')), DELIVERED).status)
      .toBe('delivered');
    const changed = [
      edited('delivered.html', (text) => text.replace('Barcode: EE000000014TZ', 'Barcode:  ')),
      edited('delivered.html', (text) => text.replace('Barcode: EE000000014TZ', 'Barcode: EE000000014TZX')),
      edited('delivered.html', (text) => text.replace('</table></div>', '<tr><td>Barcode: EE000000014TZ</td></tr></table></div>')),
      edited('delivered.html', (text) => text.replace('</table></div>', '<tr><td>Origin:</td><td>Arusha</td></tr></table></div>')),
      edited('delivered.html', (text) => text.replace('<th> Weight Kgs</th>', '<th> Sample</th>')),
      edited('delivered.html', (text) => text.replace('<td> Document </td>', '')),
      edited('delivered.html', (text) => text.replace('<td> Document </td>', '<td> Document </td></tr><tr><td>Document</td><td>1</td><td>Delivered</td>')),
      edited('delivered.html', (text) => text.replace('<td>Received at Destination office</td>', '<td> </td>')),
      edited('delivered.html', (text) => text.replace('<td>6</td>', '')),
      edited('delivered.html', (text) => text.replace("<div class='table-responsive'>", `<div class='table-responsive'><table><tr><th>S/N</th><th>Description</th><th>Created at</th></tr></table>`)),
    ];
    for (const panel of changed) expect(() => parseTanzaniaPostsPanel(panel, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const rows = '<tr><td>1</td><td>Received at Office of Dispatch</td><td>Monday 2 March 2026, 09:05:10 AM</td></tr>'.repeat(501);
    expect(() => parseTanzaniaPostsPanel(fixture('delivered.html').replace('        </table>', `${rows}</table>`), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'EE000000004TZ', 'EE00000005TZ', 'EE000000005TZX', 'E0000000005TZ', '0000000000000', 'SAMPLETRACKING',
      `EE${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTanzaniaPostsNumber(' ee-000-000-014 tz ')).toBe(DELIVERED);
    expect(normalizeTanzaniaPostsNumber('CP000000005DE')).toBe('CP000000005DE');
    expect(() => parseTanzaniaPostsReply(reply(fixture('delivered.html')), 'EE000000004TZ')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // A lookup tells known from unknown, but it is slower than recognition's budget.
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('keeps the tracker’s rate limit with its retry window', async () => {
    const fetcher = site(() => new Response('Too many requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[400, 'transport'], [403, 'challenge'], [302, 'transport'], [404, 'transport'], [410, 'transport'], [502, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = site(() => html('<html><body>Unavailable</body></html>', status));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const flaky = site((number) => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return html(reply(panels[number]!));
    });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(down).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(2);
    const immediate = site();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = site(() => new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under Tanzania Posts Corporation to the adapter', async () => {
    const fetcher = site();
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'tanzania-posts' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tanzania-posts', source: 'tanzania-posts', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([TANZANIA_POSTS_LOOKUP]);
  });
});

describe('Tanzania Posts Corporation status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(tanzaniaPostsWordingStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'tanzania-posts', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The region in brackets does not change the stage.
    expect(statusMapAnswer({ carrier: 'tanzania-posts', description: 'On Transit to destination region (Sample)' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMap.stage('1', 'delivered')).toBeUndefined();
    expect(tanzaniaPostsStage(' RECEIVED AT DESTINATION OFFICE ')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Sample event', 'On Transit', '']) expect(tanzaniaPostsWordingStage(wording), wording).toBeUndefined();
    expect(tanzaniaPostsStage('')).toBeNull();
  });
});
