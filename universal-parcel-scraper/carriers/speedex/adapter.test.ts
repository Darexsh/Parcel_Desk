import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPEEDEX_TRACKER, SpeedexTracker } from './adapter.js';
import { normalizeSpeedexNumber, parseSpeedex } from './parser.js';
import { speedexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '700000000017';
const IN_TRANSIT = '050000000025';
const RETURNED = 'JJD000000000000000000';
const UNKNOWN = '700000000009';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scans = (number: string, name: string) => parseSpeedex(fixture(name), number).events!
  .map((event) => [event.local_time, event.description, event.stage ?? null, event.location ?? null]);

describe('Speedex HTTP adapter', () => {
  it('reads the tracker page for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpeedexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0500 0000 0025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SPEEDEX_TRACKER}?number=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'speedex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first on the branches’ wall clocks, without the recipient or the branches’ details', () => {
    const result = parseSpeedex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Η ΑΠΟΣΤΟΛΗ ΠΑΡΑΔΟΘΗΚΕ', last_update: null, last_update_local: '2026-03-04T11:30:00', expected_delivery: null });
    expect(scans(DELIVERED, 'delivered')).toEqual([
      ['2026-03-04T11:30:00', 'Η ΑΠΟΣΤΟΛΗ ΠΑΡΑΔΟΘΗΚΕ', 'delivered', 'ΝΕΑ ΔΟΚΙΜΗ'],
      // A message to the recipient moves nothing.
      ['2026-03-04T08:48:00', 'ΕΠΙΤΥΧΗΣ ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ (VIBER)', null, 'ΝΕΑ ΔΟΚΙΜΗ'],
      ['2026-03-04T08:48:00', 'ΠΡΟΣ ΠΑΡΑΔΟΣΗ', 'out_for_delivery', 'ΝΕΑ ΔΟΚΙΜΗ'],
      // The repeated routing is kept once; the cancelled shop scan moves nothing.
      ['2026-03-04T08:31:00', 'ΔΡΟΜΟΛΟΓΗΣΗ', 'in_transit', 'ΝΕΑ ΔΟΚΙΜΗ'],
      ['2026-03-04T08:31:00', 'ΑΝΑΚΛΗΣΗ ΕΙΣΑΓΩΓΗΣ ΣΕ ΚΑΤΑΣΤΗΜΑ', null, 'ΝΕΑ ΔΟΚΙΜΗ'],
      ['2026-03-04T08:25:00', 'ΔΡΟΜΟΛΟΓΗΣΗ', 'in_transit', 'ΝΕΑ ΔΟΚΙΜΗ'],
      ['2026-03-04T07:57:00', 'ΕΙΣΑΓΩΓΗ ΣΕ ΚΑΤΑΣΤΗΜΑ', 'in_transit', 'ΝΕΑ ΔΟΚΙΜΗ'],
      ['2026-03-04T05:43:00', 'ΕΞΑΓΩΓΗ ΑΠΌ Δ/Κ', 'in_transit', 'ΚΕΝΤΡΟ ΔΙΑΛΟΓΗΣ'],
      ['2026-03-03T20:18:00', 'ΕΙΣΑΓΩΓΗ ΣΕ Δ/Κ', 'in_transit', 'ΚΕΝΤΡΟ ΔΙΑΛΟΓΗΣ'],
      ['2026-03-03T16:48:00', 'ΕΞΑΓΩΓΗ ΑΠΟ ΚΑΤΑΣΤΗΜΑ', 'in_transit', 'ΔΕΙΓΜΑΤΟΥΠΟΛΗ'],
      ['2026-03-03T14:28:00', 'ΠΑΡΑΛΑΒΗ ΣΤΟ ΚΑΤΑΣΤΗΜΑ', 'accepted', 'ΔΕΙΓΜΑΤΟΥΠΟΛΗ'],
      // The voucher before the sender hands the parcel over names no place.
      ['2026-03-03T14:27:00', 'ΑΝΑΜΟΝΗ ΑΝΑΘΕΣΗΣ ΑΠΟ ΑΠΟΣΤΟΛΕΑ', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.time === undefined && !('point' in event))).toBe(true);
    expect(result.events![0]).toMatchObject({ stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/ΠΑΡΑΛΗΠΤΗ|ΔΟΚΙΜΗΣ 1|ΠΑΡΑΔΕΙΓΜΑΤΟΣ|210|Google|38\.0000/);
  });

  it('reads a parcel held at the branch after a missed delivery', () => {
    expect(parseSpeedex(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Η ΑΠΟΣΤΟΛΗ ΠΑΡΑΜΕΝΕΙ ΣΤΟ ΣΤΑΘΜΟ', last_update_local: '2026-02-10T16:06:00' });
    expect(scans(IN_TRANSIT, 'in-transit').slice(0, 4)).toEqual([
      ['2026-02-10T16:06:00', 'Η ΑΠΟΣΤΟΛΗ ΠΑΡΑΜΕΝΕΙ ΣΤΟ ΣΤΑΘΜΟ', 'in_transit', 'ΑΝΩ ΔΕΙΓΜΑ'],
      ['2026-02-10T12:17:00', 'ΑΠΩΝ', 'failed_attempt', 'ΑΝΩ ΔΕΙΓΜΑ'],
      ['2026-02-10T09:58:00', 'ΑΠΟΤΥΧΙΑ ΕΝΗΜΕΡΩΣΗΣ (VIBER)', null, 'ΑΝΩ ΔΕΙΓΜΑ'],
      ['2026-02-10T09:56:00', 'ΠΡΟΣ ΠΑΡΑΔΟΣΗ', 'out_for_delivery', 'ΑΝΩ ΔΕΙΓΜΑ'],
    ]);
    expect(scans(IN_TRANSIT, 'in-transit').at(-1)).toEqual(['2026-02-09T10:02:00', 'ΑΝΑΜΟΝΗ ΑΝΑΘΕΣΗΣ ΑΠΟ ΑΠΟΣΤΟΛΕΑ', 'registered', null]);
  });

  it('reads a partner’s parcel sent back, and keeps the order of scans in one minute', () => {
    expect(parseSpeedex(fixture('returned'), RETURNED)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(scans(RETURNED, 'returned').slice(0, 3)).toEqual([
      ['2026-01-26T12:06:00', 'ΕΠΙΣΤΡΟΦΗ ΑΠΑΡΑΔΟΤΟΥ', 'returned', 'ΝΕΑ ΔΟΚΙΜΗ'],
      ['2026-01-26T12:06:00', 'ΕΙΣΑΓΩΓΗ ΣΕ ΚΑΤΑΣΤΗΜΑ', 'in_transit', 'ΝΕΑ ΔΟΚΙΜΗ'],
      ['2026-01-26T12:06:00', 'ΕΙΣΑΓΩΓΗ ΣΕ ΚΑΤΑΣΤΗΜΑ', 'in_transit', 'RECEPTION.SAMPLE'],
    ]);
  });

  it('reads the "no results" notice for the number asked as not found, and nothing else', () => {
    expect(() => parseSpeedex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice, or a history, for another number proves nothing about this one.
    expect(() => parseSpeedex(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Speedex answered for another number' }));
    expect(() => parseSpeedex(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpeedex(fixture('not-found').replace('Δεν βρέθηκαν αποτελέσματα.', 'Παρουσιάστηκε σφάλμα.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture('not-found').replace(/<div class="container">\s*<div class="row justify-content-center">\s*<div class="col-md-4 text-center alert[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/,
      '<ul class="timeline"><li class="timeline-line"></li></ul>');
    expect(() => parseSpeedex(empty, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // The page echoes the number as it was typed.
    expect(parseSpeedex(fixture('returned').replace(`value="${RETURNED}"`, `value="${RETURNED.toLowerCase()} "`), RETURNED).events).toHaveLength(8);
  });

  it('tells a block page from a changed page', () => {
    expect(() => parseSpeedex('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSpeedex('<html><head><title>Speedex</title></head><body></body></html>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (page: string) => page.replace('id="TxtConsignmentNumber"', 'id="SearchField"'),
      (page: string) => page.replace('<section id="timeline"', '<section id="results"'),
      (page: string) => page.replace('04/03/2026 στις\n', '2026-03-04 στις\n'),
      (page: string) => page.replace(/04\/03\/2026(?= στις\s+11:30)/, '31/02/2026'),
      (page: string) => page.replace(/<h4 class="card-title">\s*ΔΡΟΜΟΛΟΓΗΣΗ\s*<\/h4>/, ''),
      (page: string) => page.replace(/<h4 class="card-title">\s*ΔΡΟΜΟΛΟΓΗΣΗ\s*<\/h4>/, '<h4 class="card-title"> </h4>'),
      (page: string) => page.replace('</ul>', `${'<li class="timeline-item"></li>'.repeat(300)}</ul>`),
    ]) {
      expect(() => parseSpeedex(change(fixture('delivered')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a block page and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(html(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/speedex/Error.aspx' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Speedex</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html('<html><body>Unavailable</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const flaky = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return html(fixture('delivered'));
    });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(down).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    expect(down).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 40.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const huge = vi.fn<typeof fetch>().mockResolvedValue(html('x'.repeat(1_000_001)));
    await expect(carrier(huge).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a known number and the not-found answer, and asks nothing for a number Speedex does not track', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture('delivered')))
      .mockResolvedValueOnce(html(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T11:30:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('70000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Speedex does not track and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['70000000001', '7000000000171', '70000000001A', 'JJD00000000000000000', 'SAMPLETRACKING', '']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpeedexNumber('7000-0000-0017')).toBe(DELIVERED);
    expect(normalizeSpeedexNumber('jjd 000000000000000000')).toBe(RETURNED);
  });

  it('routes a number filed under Speedex to the adapter, and leaves twelve digits to the user', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'speedex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'speedex', source: 'speedex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(SPEEDEX_TRACKER))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('speedex');
  });
});

describe('Speedex status vocabulary', () => {
  it('stages every wording the current page shows as recorded, and leaves the rest without a stage on purpose', () => {
    const current = (statuses.entries as { wording: string; stage?: string; unmapped?: boolean; note?: string }[])
      .filter((entry) => !entry.note?.includes('Older tracker page'));
    for (const entry of current) {
      const wording = normalizeStatusWording(entry.wording);
      if (entry.unmapped) {
        expect(speedexStage(entry.wording), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'speedex', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(speedexStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'speedex', providerCode: null, description: 'ΠΡΟΣ ΠΑΡΑΔΟΣΗ' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'speedex', providerCode: null, description: 'ΣΥΝΘΕΤΙΚΟ ΣΗΜΕΙΩΜΑ' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage('X1', normalizeStatusWording('ΠΡΟΣ ΠΑΡΑΔΟΣΗ'))).toBeUndefined();
  });
});
