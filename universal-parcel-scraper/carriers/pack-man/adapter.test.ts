import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PACK_MAN_SEARCH, PackManTracker, packManSearchUrl } from './adapter.js';
import { normalizePackManNumber } from './number.js';
import { parsePackMan } from './parser.js';
import { isPackManBilling, packManStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'A-00000017';
const IN_TRANSIT = 'A-00000024';
const UNKNOWN = 'A-00000031';

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
// The scans of the timeline.
const ITEMS = /[ \t]*<li class="tl-item[\s\S]*?<\/li>\n/g;

describe('Pack-Man HTTP adapter', () => {
  it('opens the search page for the whole voucher once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    // The normalized number, without its hyphen, asks for the same voucher.
    await expect(new PackManTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' a0000 0024 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PACK_MAN_SEARCH}?code=${IN_TRANSIT}`);
    expect(packManSearchUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pack-man', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan at its stated instant across the end of summer time, and stages it by its wording', () => {
    const result = parsePackMan(fixture('delivered'), DELIVERED);
    // The invoicing steps after the delivery are left out, so the delivery is the newest scan.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Παραδόθηκε στον Παραλήπτη', last_update: '2026-10-26T12:53:39+02:00', expected_delivery: null,
      delivered_at: '2026-10-26T12:53:39+02:00' });
    expect(result.events!.map((event) => [event.time, event.stage ?? null, event.description])).toEqual([
      ['2026-10-26T12:53:39+02:00', 'delivered', 'Παραδόθηκε στον Παραλήπτη'],
      // Its offset does not read the shown clock in Athens, so the shown clock is read there.
      ['2026-10-26T09:52:00+02:00', 'out_for_delivery', 'Εγινε Ανάθεση σε Οδηγό'],
      ['2026-10-26T07:30:25+02:00', 'in_transit', 'Έχει δρομολογηθεί για παράδοση'],
      // The collection listed twice is kept once.
      ['2026-10-23T19:19:32+03:00', 'accepted', 'Εγινε Παραλαβή Από Pack-man Courier'],
      ['2026-10-23T15:10:00+03:00', 'registered', 'Εκκρεμεί (προς Παραλαβή)'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
    expect(result.events!.filter((event) => event.stage).every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps the offset that settles the repeated hour, reads it first without one, and keeps a scan without a clock', () => {
    const repeated = (attribute: string) => changed('delivered', (html) => html.replace(
      '<time datetime="2026-10-26T07:30:25+02:00">26/10/2026 · 07:30</time>', `<time datetime="${attribute}">25/10/2026 · 03:30</time>`));
    expect(parsePackMan(repeated('2026-10-25T03:30:12+02:00'), DELIVERED).events![2]!.time).toBe('2026-10-25T03:30:12+02:00');
    expect(parsePackMan(repeated('2026-10-25T03:30:12+03:00'), DELIVERED).events![2]!.time).toBe('2026-10-25T03:30:12+03:00');
    expect(parsePackMan(repeated(''), DELIVERED).events![2]!.time).toBe('2026-10-25T03:30:00+03:00');
    expect(parsePackMan(repeated('2026-10-25T03:30:12'), DELIVERED).events![2]!.time).toBe('2026-10-25T03:30:00+03:00');
    const timeless = changed('in-transit', (html) => html.replace(
      /<p class="tl-time mono">\s*<time datetime="2026-06-15T10:05:00\+03:00">15\/06\/2026 · 10:05<\/time>\s*<\/p>/, ''));
    expect(parsePackMan(timeless, IN_TRANSIT).events!.at(-1)).toEqual({ description: 'Εκκρεμεί (προς Παραλαβή)', stage: 'registered',
      stage_source: 'carrier_map' });
  });

  it('leaves the invoicing steps out of the history, in either spelling, wherever the page puts them', () => {
    const text = JSON.stringify(parsePackMan(fixture('delivered'), DELIVERED));
    expect(text).not.toMatch(/[Ττ]ιμολ/);
    // An invoicing step in capitals, between two scans, is left out too.
    const between = changed('in-transit', (html) => html.replace('<p class="tl-status">Έχει δρομολογηθεί για παράδοση</p>',
      '<p class="tl-status">ΠΡΟΣ ΤΙΜΟΛΟΓΗΣΗ</p>'));
    expect(parsePackMan(between, IN_TRANSIT).events!.map((event) => event.description)).toEqual([
      'Εγινε Ανάθεση σε Οδηγό', 'Εγινε Παραλαβή Από Pack-man Courier', 'Εκκρεμεί (προς Παραλαβή)',
    ]);
    // A timeline of invoicing steps alone has no history.
    const billed = changed('in-transit', (html) => html.replace(/<p class="tl-status">[^<]*<\/p>/g, '<p class="tl-status">Τιμολογημένη</p>'));
    expect(() => parsePackMan(billed, IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(isPackManBilling('Τιμολογημένη')).toBe(true);
    expect(isPackManBilling('Παραδόθηκε στον Παραλήπτη')).toBe(false);
  });

  it('reads a parcel with a driver in summer time', () => {
    const result = parsePackMan(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Εγινε Ανάθεση σε Οδηγό', last_update: '2026-06-16T09:58:44+03:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.stage])).toEqual([
      ['2026-06-16T09:58:44+03:00', 'out_for_delivery'],
      ['2026-06-16T07:31:02+03:00', 'in_transit'],
      ['2026-06-15T18:40:51+03:00', 'accepted'],
      ['2026-06-15T10:05:00+03:00', 'registered'],
    ]);
    // A wording the map does not know has no stage, and the newest known one stands.
    const unknown = changed('in-transit', (html) => html.replace('Εγινε Ανάθεση σε Οδηγό</p>', 'Συνθετικό βήμα</p>'));
    expect(parsePackMan(unknown, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Συνθετικό βήμα' });
  });

  it('keeps no remark, recipient or phone', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const text = JSON.stringify(parsePackMan(fixture(name), number));
      expect(text, name).not.toMatch(/Δείγμα|6900000000|Μαζική Αλλαγή|Προγραμματισμένο|auto|pack-man\.gr\/t\//);
    }
  });

  it('reads the "not found" notice as not found, a format notice as invalid input, and another notice as inconclusive', () => {
    expect(() => parsePackMan(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePackMan(changed('not-found', (html) => html.replace(/Δεν βρέθηκε[^<]*/, 'Ο κωδικός δεν έχει σωστή μορφή. Έλεγξέ τον και δοκίμασε ξανά.')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parsePackMan(changed('not-found', (html) => html.replace(/Δεν βρέθηκε[^<]*/, 'Η υπηρεσία δεν είναι διαθέσιμη')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when it names the voucher asked', () => {
    expect(() => parsePackMan(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pack-Man answered for another shipment' }));
    expect(() => parsePackMan(changed('delivered', (html) => html.replace(`track-code mono">${DELIVERED}`, 'track-code mono">A-00000018')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The voucher without its hyphen is another code to the page.
    expect(() => parsePackMan(changed('delivered', (html) => html.replace(`track-code mono">${DELIVERED}`, 'track-code mono">A00000017')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePackMan(changed('delivered', (html) => html.replace(`track-code mono">${DELIVERED}`, 'track-code mono"> a-00000017 ')), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a shipment without scans as no history', () => {
    expect(() => parsePackMan(changed('delivered', (html) => html.replace(ITEMS, '')), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    for (const [index, change] of [
      (html: string) => html.replace('id="trackForm"', 'id="search"'),
      (html: string) => html.replace('id="result"', 'id="answer"'),
      (html: string) => html.replace('class="track-result"', 'class="result"'),
      (html: string) => html.replace(`<p class="track-code mono">${DELIVERED}</p>`, ''),
      (html: string) => html.replace('<ol class="timeline">', '<ol class="steps">'),
      (html: string) => html.replace('<p class="tl-status">Τιμολογημένη</p>', '<p class="tl-status"> </p>'),
      (html: string) => html.replace('>30/10/2026 · 16:41</time>', '>2026-10-30 16:41</time>'),
      (html: string) => html.replace('>30/10/2026 · 16:41</time>', '>30/10/2026 · 16:41:06</time>'),
      (html: string) => html.replace('>30/10/2026 · 16:41</time>', '>31/02/2026 · 16:41</time>'),
      (html: string) => html.replace('>30/10/2026 · 16:41</time>', '>30/10/2026 · 24:41</time>'),
      (html: string) => html.replace('>30/10/2026 · 16:41</time>', '></time>'),
      (html: string) => html.replace(/<time datetime="2026-10-30T16:41:06\+02:00">30\/10\/2026 · 16:41<\/time>/, '30/10/2026 · 16:41'),
      (html: string) => html.replace(/(<li class="tl-item is-done tl-pending">[\s\S]*?<\/li>\n)/, (item: string) => item.repeat(301)),
      () => '<html><head><title>Αναζήτηση αποστολής | Pack-Man</title></head><body><p>Σφάλμα</p></body></html>',
      () => '',
    ].entries()) {
      expect(() => parsePackMan(changed('delivered', change), DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown voucher, a moved route, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing voucher from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://pack-man.gr/' } })).rejects.toMatchObject({ kind: 'transport' });
    // A bot check, with HTTP 200 or 403, and a plain refusal.
    await expect(lookup(fixture('challenge'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('challenge'), { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Pack-Man answered with a block page' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Pack-Man refused the lookup' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '10' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Pack-Man</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"error":true}', { headers: { 'Content-Type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
    });

  it('tries once more after a failure to reach Pack-Man, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PackManTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pack-man', step: 'retry', outcome: 'ok' }));
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

  it('rejects vouchers Pack-Man does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['A-0000001', 'A-000000170', 'AB-00000017', '00000017', '1-00000017', 'GR000000000GR', `A-${'0'.repeat(63)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePackManNumber(' a-0000 0017 ')).toBe(DELIVERED);
    expect(normalizePackManNumber('A00000017')).toBe(DELIVERED);
    expect(normalizePackManNumber('Z-12345678')).toBe('Z-12345678');
  });

  it('recognizes a voucher the page knows, and not one it does not know or Pack-Man does not issue', async () => {
    const answer = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init)));
    await expect(answer(fixture('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-26T10:53:39.000Z' });
    await expect(answer(fixture('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(answer(fixture('challenge')).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('AB12345678')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a voucher filed under Pack-Man to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pack-man' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pack-man', source: 'pack-man', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === packManSearchUrl(DELIVERED))).toBe(true);
  });
});

describe('Pack-Man numbers and links', () => {
  it('claims no letter and eight digits, which other carriers issue too', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, 'A00000017']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('pack-man');
    }
  });

  it('reads the search page, the share link and the former voucher search as links', () => {
    for (const link of [
      `https://pack-man.gr/anazitisi-apostolis.html?code=${DELIVERED}`,
      `https://pack-man.gr/t/${DELIVERED}`,
      `https://www.courier.pack-man.gr/pegasus/courier04/search00.php?pcode=SEARCHVOUCHER&r18p01=${DELIVERED}`,
    ]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'pack-man', source: 'link' });
    }
  });
});

describe('Pack-Man status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and the invoicing steps it leaves out as gaps', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      const answer = statusMapAnswer({ carrier: 'pack-man', providerCode: null, description: entry.wording });
      expect(answer, entry.wording).toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : expect.objectContaining({ kind: 'intentional_gap' }));
      expect(packManStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(isPackManBilling(entry.wording), entry.wording).toBe(!entry.stage);
    }
  });

  it('reads either casing and accent, and leaves an unknown scan or a coded one unmapped', () => {
    expect(packManStage('ΠΑΡΑΔΟΘΗΚΕ ΣΤΟΝ ΠΑΡΑΛΗΠΤΗ')).toBe('delivered');
    expect(packManStage('Έγινε Ανάθεση σε Οδηγό')).toBe('out_for_delivery');
    expect(packManStage('Παραδόθηκε στον γείτονα')).toBeUndefined();
    expect(statusMap.stage('1', 'παραδόθηκε στον παραλήπτη')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'pack-man', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});
