import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EASY_MAIL_TRACKER, EasyMailTracker, easyMailTrackerUrl } from './adapter.js';
import { normalizeEasyMailNumber, parseEasyMail } from './parser.js';
import { easyMailStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '19000000011';
const IN_TRANSIT = '19000000028';
const UNKNOWN = '19000000035';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, change: (html: string) => string) => {
  const html = fixture(name);
  const next = change(html);
  if (next === html) throw new Error(`The change left ${name} as it was`);
  return next;
};
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The rows of the scan table, without its header.
const ROWS = /\t*<tr>\n\t+<th scope="row">0\d{11}<\/th>\n\t+<th scope="row"><\/th>[\s\S]*?<\/tr>\n/g;

describe('Easy Mail HTTP adapter', () => {
  it('opens the tracker for the whole voucher once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    // The twelve-digit form the tracker prints asks for the same voucher.
    await expect(new EasyMailTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0190 0000 0028 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${EASY_MAIL_TRACKER}${IN_TRANSIT}`);
    expect(easyMailTrackerUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'easy-mail', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan as a Greek wall clock, across the end of summer time, and stages it by its wording', () => {
    const result = parseEasyMail(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Παραδόθηκε', last_update: '2026-10-27T12:45:00+02:00', expected_delivery: null,
      delivered_at: '2026-10-27T12:45:00+02:00' });
    expect(result.events!.map((event) => [event.time, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-10-27T12:45:00+02:00', 'delivered', 'ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-27T08:31:09+02:00', 'out_for_delivery', 'ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-26T17:12:44+02:00', 'in_transit', 'ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-26T16:10:00+02:00', 'failed_attempt', 'ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-26T08:40:12+02:00', 'out_for_delivery', 'ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-26T08:05:30+02:00', 'in_transit', 'ΠΑΡΑΔΕΙΓΜΑ'],
      // The hour the clocks go back over is read at its first occurrence, in summer time.
      ['2026-10-25T03:30:00+03:00', 'in_transit', 'ΚΔ ΔΕΙΓΜΑΤΟΣ'],
      ['2026-10-24T23:20:05+03:00', 'in_transit', 'ΚΔ ΔΕΙΓΜΑΤΟΣ'],
      // The departure listed twice is kept once.
      ['2026-10-23T18:02:45+03:00', 'in_transit', 'ΠΡΟΤΥΠΟ'],
      ['2026-10-23T15:40:11+03:00', 'accepted', 'ΠΡΟΤΥΠΟ'],
      ['2026-10-23T15:40:11+03:00', 'accepted', 'ΠΡΟΤΥΠΟ'],
      ['2026-10-23T10:15:20+03:00', 'registered', 'ΠΡΟΤΥΠΟ'],
      ['2026-10-23T10:15:20+03:00', 'registered', 'ΠΡΟΤΥΠΟ'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(result.events!.filter((event) => event.stage).every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events![3]!.description).toBe('Καταχωρήθηκε Αιτία μη Παράδοσης, ΚΑΤΟΠΙΝ ΣΥΝΕΝΝΟΗΣΗΣ');
  });

  it('reads a parcel out again after a non-delivery reason, and a parcel waiting at its store', () => {
    const result = parseEasyMail(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Προς παράδοση', last_update: '2026-06-12T07:47:14+03:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.stage ?? null, event.description])).toEqual([
      ['out_for_delivery', 'Προς παράδοση'],
      ['failed_attempt', 'Καταχωρήθηκε Αιτία μη Παράδοσης'],
      ['in_transit', 'Αφίχθει στο κατάστημα παράδοσης'],
      ['in_transit', 'Αναχώρηση για το Κατάστημα Παράδοσης'],
      ['in_transit', 'Αφίχθη στο κέντρο διαλογής'],
      ['in_transit', 'Αναχώρηση για το Κατάστημα Παράδοσης'],
      // Brought to the store by the sender: the arrival comes with the pickup mark.
      ['accepted', 'Χαρακτηρισμός ώς Παρελήφθη'],
      ['accepted', 'Αφίχθη στο κατάστημα παραλαβής'],
      ['registered', 'Καταχώρηση αποστολής από τον αποστολέα'],
    ]);
    const store = changed('in-transit', (html) => html.replace(/<td>12\/06\/2026 {2}7:47:14 AM<\/td>\n\t+<td>Προς παράδοση<\/td>/g,
      '<td>12/06/2026  7:47:14 AM</td>\n<td>Καταχωρήθηκε Αιτία μη Παράδοσης, ΠΑΡΑΛΑΒΗ ΑΠΌ ΚΑΤΑΣΤΗΜΑ</td>'));
    expect(parseEasyMail(store, IN_TRANSIT)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
  });

  it('keeps no recipient, store phone or address, and no store named after a partner', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const text = JSON.stringify(parseEasyMail(fixture(name), number));
      expect(text, name).not.toMatch(/\*{3}|2100000000|Τηλέφωνο|Διεύθυνση|Δείγματος 1|store\//);
    }
    const partner = changed('delivered', (html) => html.replaceAll('ΠΑΡΑΔΕΙΓΜΑ', 'SPEEDEX'));
    expect(parseEasyMail(partner, DELIVERED).events!.slice(0, 6).map((event) => event.location ?? null)).toEqual(Array(6).fill(null));
    const phone = changed('delivered', (html) => html.replace(/<td>Παραδόθηκε<\/td>(\n\t+<td {2}class)/, '<td>Παραδόθηκε, 6900000000 sample@example.com</td>$1'));
    expect(parseEasyMail(phone, DELIVERED).events![0]).toMatchObject({ description: 'Παραδόθηκε', stage: 'delivered' });
  });

  it('reads the "not found" notice as not found, and another notice as inconclusive', () => {
    expect(() => parseEasyMail(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEasyMail(changed('not-found', (html) => html.replace(/Δεν βρέθηκε[^<]*/, 'Η υπηρεσία δεν είναι διαθέσιμη')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when every row names the voucher asked', () => {
    expect(() => parseEasyMail(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Easy Mail answered for another shipment' }));
    expect(() => parseEasyMail(changed('delivered', (html) => html.replace('<th scope="row">019000000011</th>\n\t\t\t\t\t\t\t\t<th></th>',
      '<th scope="row">019000000028</th>\n\t\t\t\t\t\t\t\t<th></th>')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEasyMail(changed('delivered', (html) => html.replace(/(<th scope="row">)019000000011(<\/th>\n\t+<th scope="row"><\/th>\n\t+<td>23\/10\/2026 10:15:20)/,
      '$1019000000028$2')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The eleven-digit form of a row's voucher binds too.
    expect(parseEasyMail(fixture('delivered').replaceAll('019000000011', DELIVERED), `0${DELIVERED}`)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a shipment without scans as no history', () => {
    expect(() => parseEasyMail(fixture('delivered').replace(ROWS, ''), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const [index, change] of [
      (html: string) => html.replace('Αναλυτικά Στοιχεία Αποστολής', 'Ιστορικό'),
      (html: string) => html.replace("id='trackntraceform'", "id='search'"),
      (html: string) => html.replace('<th scope="row"></th>\n\t\t\t\t\t\t\t\t<td>27/10/2026 12:45:00 PM</td>', '<td>27/10/2026 12:45:00 PM</td>'),
      (html: string) => html.replaceAll('<td>27/10/2026 12:45:00 PM</td>', '<td>2026-10-27 12:45</td>'),
      (html: string) => html.replaceAll('<td>27/10/2026 12:45:00 PM</td>', '<td>27/10/2026 12:45 PM</td>'),
      (html: string) => html.replaceAll('<td>27/10/2026 12:45:00 PM</td>', '<td>30/02/2026 12:45:00 PM</td>'),
      (html: string) => html.replaceAll('<td>27/10/2026 12:45:00 PM</td>', '<td>27/10/2026 13:45:00 PM</td>'),
      (html: string) => html.replace(/<td>Παραδόθηκε<\/td>(\n\t+<td {2}class)/, '<td> </td>$1'),
      (html: string) => html.replace(/(<th scope="row">)019000000011(<\/th>\n\t+<th scope="row"><\/th>\n\t+<td>23\/10\/2026 10:15:20)/, '$1SAMPLE$2'),
      (html: string) => html.replace('<h2>Αναλυτικά Στοιχεία Αποστολής</h2>', '<h2>Αναλυτικά Στοιχεία Αποστολής</h2><h2>Αναλυτικά Στοιχεία Αποστολής</h2><table></table>'),
      (html: string) => html.replace(/(<tbody>\n)(\t*<tr>\n\t+<th scope="row">019000000011<\/th>\n\t+<th scope="row"><\/th>[\s\S]*?<\/tr>\n)/,
        (_, open: string, row: string) => open + row.repeat(301)),
      () => '<html><head><title>Easymail Track-n-Trace</title></head><body><p>Σφάλμα</p></body></html>',
      () => '',
    ].entries()) {
      expect(() => parseEasyMail(changed('delivered', change), DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // The bare tracker page, without a notice or a shipment, is not an answer either.
    expect(() => parseEasyMail(fixture('not-found').replace(/\t*<div class="row">\n\t*<div class="col">\n\t*<div class='cus-alert[\s\S]*?<\/div>\n\t*<\/div>\n\t*<\/div>\n/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown voucher, a moved route, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker reads a missing voucher from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.easymail.gr/' } })).rejects.toMatchObject({ kind: 'transport' });
    // A server bot check, with HTTP 200 or 403, and a plain refusal.
    await expect(lookup(fixture('challenge'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('challenge'), { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Easy Mail answered with a block page' });
    await expect(lookup('<html><title>Access denied</title><p>Access denied by Imunify360 bot-protection.</p></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Easy Mail refused the lookup' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '10' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Easymail Track-n-Trace</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"error":true}', { headers: { 'Content-Type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    });

  it('tries once more after a failure to reach Easy Mail, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EasyMailTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'easy-mail', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects vouchers Easy Mail does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1900000001', '119000000011', '0019000000011', 'SAMPLETRACKING', 'GR000000000GR', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEasyMailNumber(' 190-0000-0011 ')).toBe(DELIVERED);
    expect(normalizeEasyMailNumber(`0${DELIVERED}`)).toBe(DELIVERED);
  });

  it('declares no recognition, since no detection rule offers Easy Mail', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a voucher filed under Easy Mail to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: `0${DELIVERED}`, carrier: 'easy-mail' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'easy-mail', source: 'easy-mail', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === easyMailTrackerUrl(DELIVERED))).toBe(true);
  });
});

describe('Easy Mail numbers', () => {
  it('claims no eleven- or twelve-digit number, which other carriers issue too', () => {
    for (const number of [DELIVERED, `0${DELIVERED}`, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('easy-mail');
    }
  });
});

describe('Easy Mail status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'easy-mail', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(easyMailStage(entry.wording), entry.wording).toBe(entry.stage);
    }
  });

  it('reads either casing, and leaves an unknown scan or a coded one unmapped', () => {
    expect(easyMailStage('ΠΑΡΑΔΟΘΗΚΕ')).toBe('delivered');
    expect(easyMailStage('Καταχωρήθηκε αιτία μη παράδοσης, ΑΠΟΥΣΙΑ ΠΑΡΑΛΗΠΤΗ')).toBe('failed_attempt');
    expect(easyMailStage('Παραδόθηκε στον γείτονα')).toBeUndefined();
    expect(statusMap.stage('1', 'παραδόθηκε')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'easy-mail', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});
