import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, COURIER_CENTER_TRACKER, CourierCenterTracker, courierCenterTrackerUrl } from './adapter.js';
import { courierCenterWording, normalizeCourierCenterNumber, parseCourierCenter } from './parser.js';
import { courierCenterStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '013000000017';
const IN_TRANSIT = '013000000024';
const ELTA = '013000000031';
const BOX_NOW = '013000000048';
const UNKNOWN = '013000000055';

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
const ROWS = /(\t*<div class="tr(?: mobileapi)?">[\s\S]*?<\/div>\n {16}<\/div>\n)/g;
const withoutRows = (html: string) => html.replace(ROWS, '');

describe('Courier Center HTTP adapter', () => {
  it('opens the result page for the whole waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CourierCenterTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0130 0000 0024 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${COURIER_CENTER_TRACKER}?tracknr=${IN_TRANSIT}`);
    expect(courierCenterTrackerUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'courier-center', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan as a Greek wall clock, across the end of summer time, and stages it by its wording', () => {
    const result = parseCourierCenter(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Η αποστολή παραδόθηκε στον παραλήπτη', last_update: '2026-10-26T13:27:00+02:00', expected_delivery: null,
      delivered_at: '2026-10-26T13:27:00+02:00', service_name: '17:00 ΕΠΟΜΕΝΗ ΜΕΡΑ ΧΕΡΣΑΙΟ/ΝΗΣΙ' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-10-26T13:27:00+02:00', 'delivered', 'CC ΠΑΡΑΔΕΙΓΜΑ'],
      // A message to the recipient moves nothing and names no place the parcel is.
      ['2026-10-26T08:04:00+02:00', null, null],
      ['2026-10-26T07:05:00+02:00', 'out_for_delivery', 'CC ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-25T07:35:00+02:00', 'in_transit', 'CC ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-25T07:35:00+02:00', 'in_transit', 'CC ΠΑΡΑΔΕΙΓΜΑ'],
      ['2026-10-25T02:20:00+03:00', 'in_transit', 'CC HUB ΚΕΝΤΡΙΚΟ'],
      // The repeated bag scan is kept once.
      ['2026-10-24T23:36:00+03:00', 'in_transit', 'CC HUB ΚΕΝΤΡΙΚΟ'],
      ['2026-10-24T12:42:00+03:00', null, null],
      ['2026-10-24T12:40:00+03:00', 'accepted', 'CC ΠΡΟΤΥΠΟ'],
      // The web order names the web shop, not a place the parcel is.
      ['2026-10-24T12:34:00+03:00', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(result.events!.filter((event) => event.stage).every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.map((event) => event.description)).toContain('Εστάλη μήνυμα για την δυνατότητα αναδρομολόγησης σε Clever Point');
  });

  it('keeps no recipient, phone, link, reference, origin or destination', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT], ['elta', ELTA], ['box-now', BOX_NOW]] as const) {
      const text = JSON.stringify(parseCourierCenter(fixture(name), number));
      expect(text, name).not.toMatch(/ΔΕΙ\*|\*{3}|00000\]|2100000000|5550123|ΑΦΕΤΗΡΙΑ|ΠΡΟΟΡΙΣΜΟΣ|link\.example|https?:|@|SAMPLE-REF|ΔΙΟΙΚΗΣΗ|WEB STATION|ΤΗΛΕΦΩΝΟ|EMAIL|Ημ\/νια|Ειδοποίησης|99999|LOCKERS-ATH|ELTA COURIER/);
    }
  });

  it('reads a failed attempt and a parcel out again by their scans while the status has not settled', () => {
    const result = parseCourierCenter(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ', last_update: '2026-03-16T09:12:00+02:00', service_name: 'ΕΝΤΟΣ ΠΟΛΗΣ' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.stage ?? null, event.description])).toEqual([
      [null, 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ'],
      ['out_for_delivery', 'Ανάθεση αποστολής για παράδοση σε διανομέα'],
      ['failed_attempt', 'Αποτυχία παράδοσης, Αιτιολογία: Απουσία παραλήπτη'],
      ['out_for_delivery', 'Ανάθεση αποστολής για παράδοση σε διανομέα'],
      ['in_transit', 'Άφιξη τεμαχίου Νο. 013000000024 στο κατάστημα παραλαβής: CC ΠΑΡΑΔΕΙΓΜΑ'],
      ['in_transit', 'Αναχώρηση από κατάστημα'],
      ['in_transit', 'Το τεμάχιο Νο. 013000000024 εντάχθηκε στον σάκο'],
      ['accepted', 'Παραλαβή όλων των τεμαχίων της αποστολής στο κατάστημα παραλαβής: CC ΠΡΟΤΥΠΟ'],
    ]);
    // A settled status takes over from the scans; one still moving does not.
    expect(parseCourierCenter(changed('in-transit', (html) => html.replace('(18) BagAssigned', '(41) ReturnBackToShipper')), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ' });
    expect(parseCourierCenter(changed('in-transit', (html) => html.replace('(18) BagAssigned', '(87) CheckedInAtCleverPoint')), IN_TRANSIT))
      .toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(parseCourierCenter(changed('in-transit', (html) => html.replace('(18) BagAssigned', '(99) SyntheticStatus')), IN_TRANSIT))
      .toMatchObject({ current_stage: 'out_for_delivery' });
  });

  it('names the partner that took the parcel over and its number', () => {
    const elta = parseCourierCenter(fixture('elta'), ELTA);
    expect(elta).toMatchObject({ status: 'delivered', delivery_carrier: 'elta', delivery_tracking_number: 'XI000000014GR',
      delivered_at: '2026-10-13T08:11:00+03:00', last_status_text: 'ΠΑΡΑΔΟΘΗΚΕ' });
    // ELTA's offices lose their postcode.
    expect(elta.events!.slice(0, 3).map((event) => [event.stage, event.location])).toEqual([
      ['delivered', 'ΚΑΤΑΣΤΗΜΑ ΔΕΙΓΜΑΤΟΣ'], ['in_transit', 'ΚΑΤΑΣΤΗΜΑ ΔΕΙΓΜΑΤΟΣ'], ['in_transit', 'Κ.Δ. ΔΕΜΑΤΩΝ ΔΕΙΓΜΑΤΟΣ'],
    ]);
    const boxNow = parseCourierCenter(fixture('box-now'), BOX_NOW);
    expect(boxNow).toMatchObject({ status: 'delivered', delivery_carrier: 'box-now', delivery_tracking_number: '9900000001',
      delivered_at: '2026-10-14T10:37:00+03:00' });
    expect(boxNow.events!.slice(0, 3).map((event) => [event.stage, event.location ?? null])).toEqual([
      ['delivered', null], ['ready_for_pickup', null], ['in_transit', null],
    ]);
    // A second number that is neither an ELTA item code nor a BOX NOW id on BOX NOW's leg is not read.
    for (const html of [
      changed('elta', (text) => text.replace('XI000000014GR', 'XI000000015GR')),
      changed('elta', (text) => text.replace('XI000000014GR', 'SAMPLE0001')),
      changed('delivered', (text) => text.replace(`<span>${DELIVERED}</span>`, `<span>${DELIVERED} / 9900000001</span>`)),
    ]) {
      const result = parseCourierCenter(html, html.includes(ELTA) ? ELTA : DELIVERED);
      expect(result).not.toHaveProperty('delivery_carrier');
      expect(result).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads a padded day and a repeated hour as Greek clocks', () => {
    const repeated = changed('delivered', (html) => html.replace('class="td time">02:20<', 'class="td time">03:30<'));
    // The hour clocks go back over is read at its first occurrence, in summer time.
    expect(parseCourierCenter(repeated, DELIVERED).events!.find((event) => event.description === 'Αναχώρηση από κατάστημα'))
      .toMatchObject({ time: '2026-10-25T03:30:00+03:00' });
    // The English store pads the day and the month.
    const padded = changed('elta', (html) => html.replaceAll('>8/10/2026<', '>08/10/2026<').replaceAll('>9/10/2026<', '>09/10/2026<'));
    expect(parseCourierCenter(padded, ELTA).events!.at(-1)).toMatchObject({ time: '2026-10-08T11:12:00+03:00' });
  });

  it('takes people, phones, links and notice numbers out of the wording', () => {
    expect(courierCenterWording('Η αποστολή παραδόθηκε στον παραλήπτη: ΔΕΙΓΜΑ ΔΕΙΓΜΑΤΟΣ, Ημ/νια: 26/10/2026, Ώρα: 13:27'))
      .toBe('Η αποστολή παραδόθηκε στον παραλήπτη');
    expect(courierCenterWording('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ ΣΤΟ ΤΗΛΕΦΩΝΟ: [*******00000] ΜΕ ΘΕΜΑ: [Εστάλη μήνυμα για την δυνατότητα αναδρομολόγησης σε Clever Point με επιλογή σημείου μέσω https://link.example/sample0]'))
      .toBe('Εστάλη μήνυμα για την δυνατότητα αναδρομολόγησης σε Clever Point');
    expect(courierCenterWording('Msg_History_Entry_2|ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΑΦΙΞΗΣ ΑΠΟΣΤΟΛΗΣ ΣΤΟΝ ΠΑΡΑΛΗΠΤΗ ΣΤΟ EMAIL: sample@example.com'))
      .toBe('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΑΦΙΞΗΣ ΑΠΟΣΤΟΛΗΣ ΣΤΟΝ ΠΑΡΑΛΗΠΤΗ');
    expect(courierCenterWording('Αποτυχία παράδοσης, Αιτιολογία: Λάθος διεύθυνση, Αρ. Ειδοποίησης: 5550123'))
      .toBe('Αποτυχία παράδοσης, Αιτιολογία: Λάθος διεύθυνση');
    expect(courierCenterWording('ΑΙΤΗΜΑ ΑΝΑΔΡΟΜΟΛΟΓΗΣΗΣ ΑΠΟ ΠΑΡΑΛΗΠΤΗ ΣΕ CLEVER POINT: [ΔΕΙΓΜΑ 1] ΧΡΕΩΣΗ: 0,00'))
      .toBe('ΑΙΤΗΜΑ ΑΝΑΔΡΟΜΟΛΟΓΗΣΗΣ ΑΠΟ ΠΑΡΑΛΗΠΤΗ ΣΕ CLEVER POINT: [ΔΕΙΓΜΑ 1]');
    expect(courierCenterWording('Επικοινωνία στο 6900000000 ή +302100000000 ΠΛΗΡΟΦΟΡΙΕΣ ΕΔΩ https://link.example/x')).toBe('Επικοινωνία στο ή');
    // A piece number in brackets stays.
    expect(courierCenterWording('Το τεμάχιο Νο: [013000000017] εντάχθηκε στο σάκο')).toBe('Το τεμάχιο Νο: [013000000017] εντάχθηκε στο σάκο');
  });

  it('reads the "no waybill" notice for the number asked as not found, on either store', () => {
    expect(() => parseCourierCenter(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const english = changed('not-found', (html) => html.replace('Υπήρξε πρόβλημα με την αναζήτηση', 'There was an error processing your request')
      .replace('Δεν βρέθηκε φορτωτική με τον αριθμό', 'No shipments found with identifier'));
    expect(() => parseCourierCenter(english, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A notice for another number, or one without its usual wording, settles nothing.
    expect(() => parseCourierCenter(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Courier Center answered for another number' }));
    expect(() => parseCourierCenter(changed('not-found', (html) => html.replace(/Δεν βρέθηκε[^<]*/, 'Η υπηρεσία δεν είναι διαθέσιμη')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when its waybill is the number asked', () => {
    // The tracker also finds a shipment by a partner's number or a reference, under its own waybill.
    expect(() => parseCourierCenter(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Courier Center answered for another shipment' }));
    expect(() => parseCourierCenter(changed('elta', (html) => html.replace(`<span>${ELTA} / `, '<span>XI000000014GR / ')), ELTA))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCourierCenter(changed('delivered', (html) => html.replace('<div class="track-table">',
      '<p>Βρέθηκαν 2 φορτωτικές με αυτόν τον αριθμό</p><div class="track-table">')), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Courier Center found several shipments under the number' }));
  });

  it('reads a shipment without scans by its status alone, or as no history', () => {
    expect(parseCourierCenter(withoutRows(fixture('delivered')), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'DeliveryCompleted',
      provider_code: '29', last_update: null, expected_delivery: null, service_name: '17:00 ΕΠΟΜΕΝΗ ΜΕΡΑ ΧΕΡΣΑΙΟ/ΝΗΣΙ', summary_only: true, events: [],
    });
    // The page reads "(0) None" as the sender not having handed the parcel over yet.
    expect(parseCourierCenter(withoutRows(fixture('delivered')).replace('(29) DeliveryCompleted', '(0) None'), DELIVERED))
      .toMatchObject({ status: 'pending', current_stage: 'registered', provider_code: '0', summary_only: true });
    expect(() => parseCourierCenter(withoutRows(fixture('delivered')).replace('(29) DeliveryCompleted', '(99) SyntheticStatus'), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseCourierCenter(withoutRows(fixture('delivered')).replace('(29) DeliveryCompleted', ''), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed page', () => {
    const scan = '<div id="time"\t\tclass="td time">13:27</div>';
    for (const change of [
      (html: string) => html.replace('<div class="track-header">', '<div class="track-heading">'),
      (html: string) => html.replace('<div class="id">', '<div class="identifier">'),
      (html: string) => html.replace('<div class="status">', `<div class="id"><span>${DELIVERED}</span></div><div class="status">`),
      (html: string) => html.replace(scan, ''),
      (html: string) => html.replace(scan, '<div id="time"\t\tclass="td time">13:27:00</div>'),
      (html: string) => html.replace(scan, '<div id="time"\t\tclass="td time">24:00</div>'),
      (html: string) => html.replace('class="td date">26/10/2026</div>', 'class="td date">2026-10-26</div>'),
      (html: string) => html.replace('class="td date">26/10/2026</div>', 'class="td date">30/2/2026</div>'),
      (html: string) => html.replace('class="td action">Ανάθεση αποστολής για παράδοση σε διανομέα</div>', 'class="td action"> </div>'),
      (html: string) => html.replace('class="td action">Επιβεβαιωμένη παραγγελία</div>',
        'class="td action">Επιβεβαιωμένη παραγγελία</div><div class="td action">Επιβεβαιωμένη παραγγελία</div>'),
      (html: string) => html.replace(/(<div class="tr header">[\s\S]*?<\/div>\n\t{4}<\/div>\n)/, (header) => header
        + (/(\t*<div class="tr mobileapi">[\s\S]*?<\/div>\n {16}<\/div>\n)/.exec(html)![1]!).repeat(301)),
      () => '<html><head><title>Courier Center</title></head><body><p>Σφάλμα</p></body></html>',
      () => '',
    ]) {
      expect(() => parseCourierCenter(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page, a rate limit and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing waybill from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.courier.gr/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Cloudflare's browser check, with HTTP 200 or 403, and its plain refusal.
    await expect(lookup(fixture('challenge'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('challenge'), { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Courier Center answered with a block page' });
    await expect(lookup('<html><title>Attention Required! | Cloudflare</title><div id="cf-error-details">Sorry, you have been blocked</div></html>', { status: 403 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Courier Center refused the lookup' });
    // Cloudflare answers a burst of lookups with its rate limit page.
    await expect(lookup('error code: 1015', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Courier Center</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failure to reach Courier Center, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CourierCenterTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'courier-center', step: 'retry', outcome: 'ok' }));
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

  it('recognizes a known waybill and the "no waybill" notice, and asks nothing for a number Courier Center does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(fixture('delivered')))
      .mockResolvedValueOnce(page(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-26T11:27:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('JJD000000000000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Courier Center does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // DHL's parcel numbers it delivers stay with DHL, and BOX NOW's and ELTA's with them.
    for (const number of ['JJD000000000000000000', '9900000001', 'XI000000014GR', '01300000001', '0130000000170', 'SAMPLETRACKING', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCourierCenterNumber(' 0130-0000-0017 ')).toBe(DELIVERED);
  });

  it('routes a number filed under Courier Center to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'courier-center' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'courier-center', source: 'courier-center', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === courierCenterTrackerUrl(DELIVERED))).toBe(true);
  });
});

describe('Courier Center numbers', () => {
  it('claims no twelve-digit number, which other carriers issue too', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      const detected = detectCarrierMatch(number);
      expect(detected.carrier === 'courier-center' && detected.confidence === 'high', number).toBe(false);
    }
  });
});

describe('Courier Center status vocabulary', () => {
  // Stand-ins for the parts of a wording `statuses.json` leaves out.
  const filled = (wording: string) => wording.replace('ΤΗΛΕΦΩΝΟ: […]', 'ΤΗΛΕΦΩΝΟ: [*******00000]')
    .replace('ΘΕΜΑ: […]', 'ΘΕΜΑ: [Εστάλη μήνυμα ενημέρωσης για σημερινή παράδοση της αποστολής]')
    .replace('[…]', `[${DELIVERED}]`).replace('Νο: …', `Νο: ${DELIVERED}`).replaceAll('…', 'CC ΠΑΡΑΔΕΙΓΜΑ');

  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean; language: string }[]) {
      // A status name comes with its number; a scan without a code.
      const code = entry.language === 'en' ? entry.code ?? '99' : null;
      const description = courierCenterWording(filled(entry.wording));
      const answer = statusMapAnswer({ carrier: 'courier-center', providerCode: code, description });
      if (entry.unmapped) {
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      if (code === null) expect(courierCenterStage(description), entry.wording).toBe(entry.stage);
    }
  });

  it('reads either casing, and leaves an unknown scan or status unmapped', () => {
    expect(courierCenterStage('ΑΝΑΘΕΣΗ ΑΠΟΣΤΟΛΗΣ ΓΙΑ ΠΑΡΑΔΟΣΗ ΣΕ ΔΙΑΝΟΜΕΑ')).toBe('out_for_delivery');
    expect(courierCenterStage('παραδοθηκε.')).toBe('delivered');
    expect(courierCenterStage('Η αποστολή παραδόθηκε στον παραλήπτη: ΔΕΙΓΜΑ')).toBeUndefined();
    expect(statusMap.stage(null, 'synthetic scan')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'courier-center', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'courier-center', providerCode: '99', description: 'SyntheticStatus' })).toEqual({ kind: 'unknown' });
    // A status name is read only with its number, and a scan only without one.
    expect(statusMapAnswer({ carrier: 'courier-center', providerCode: null, description: 'DeliveryCompleted' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'courier-center', providerCode: '29', description: 'ΠΑΡΑΔΟΘΗΚΕ' })).toEqual({ kind: 'unknown' });
  });
});
