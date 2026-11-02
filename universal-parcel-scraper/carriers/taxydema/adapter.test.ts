import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TAXYDEMA_API, TaxydemaTracker, taxydemaLookupUrl } from './adapter.js';
import { normalizeTaxydemaNumber, parseTaxydema, taxydemaWording } from './parser.js';
import { statusMap, taxydemaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '400000000017';
const IN_TRANSIT = '400000000024';
const UNKNOWN = '400000000031';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
interface Shipment { tt_code?: unknown; verticalStatus?: unknown[]; horizontalInfo?: Record<string, unknown> }
const fixture = (name: string): { result: Shipment } => JSON.parse(text(name));
/** A fixture with its `result` changed in place by `change`. */
const changed = (name: string, change: (result: Shipment) => void) => {
  const payload = fixture(name);
  change(payload.result);
  return payload;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Taxydema HTTP adapter', () => {
  it('asks the tracking page\'s lookup for the whole waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TaxydemaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 4000 0000 0024 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TAXYDEMA_API}${IN_TRANSIT}`);
    expect(taxydemaLookupUrl(IN_TRANSIT)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'taxydema', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan as a Greek wall clock, across the end of summer time, and stages it by its wording', () => {
    const result = parseTaxydema(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ', last_update: '2026-10-26T13:58:27+02:00', expected_delivery: null,
      delivered_at: '2026-10-26T13:27:05+02:00' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.stage ?? null, event.location ?? null, event.description])).toEqual([
      // A message to the recipient moves nothing and names no place the parcel is.
      ['2026-10-26T13:58:27+02:00', null, null, 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ'],
      ['2026-10-26T13:27:05+02:00', 'delivered', 'ΠΑΡΑΔΕΙΓΜΑ ΤΧ', 'Η αποστολή παραδόθηκε στον παραλήπτη'],
      ['2026-10-26T08:47:45+02:00', null, null, 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ'],
      ['2026-10-26T08:11:41+02:00', 'out_for_delivery', 'ΠΑΡΑΔΕΙΓΜΑ ΤΧ', 'Ανάθεση αποστολής για παράδοση σε διανομέα'],
      ['2026-10-26T07:15:04+02:00', 'in_transit', 'ΠΑΡΑΔΕΙΓΜΑ ΤΧ', 'Άφιξη τεμαχίου στο Σταθμό Παράδοσης ΠΑΡΑΔΕΙΓΜΑ ΤΧ'],
      ['2026-10-26T07:15:04+02:00', 'in_transit', 'ΠΑΡΑΔΕΙΓΜΑ ΤΧ', `Άφιξη τεμαχίου Νο: ${DELIVERED} στο κατάστημα`],
      // The hour clocks go back over is read at its first occurrence, in summer time; the repeated row is kept once.
      ['2026-10-25T03:30:00+03:00', 'in_transit', 'HUB ΚΕΝΤΡΙΚΟ ΤΧ', 'Αναχώρηση από κατάστημα'],
      ['2026-10-24T07:51:59+03:00', null, null, 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ'],
      ['2026-10-24T07:44:18+03:00', 'accepted', 'HUB ΠΡΟΤΥΠΟ ΤΧ', 'Παραλαβή όλων των τεμαχίων της αποστολής στο κατάστημα παραλαβής: HUB ΚΕΝΤΡΙΚΟ ΤΧ'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(result.events!.filter((event) => event.stage).every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps no recipient, phone, link, sender, origin or destination', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const result = JSON.stringify(parseTaxydema(fixture(name), number));
      expect(result, name).not.toMatch(/ΔΕΙΓΜΑΤΟΣ|\*{3}|00000\]|link\.example|example\.com|https?:|EvaluationLink|SAMPLE SENDER|ΘΕΜΑ|ΑΦΕΤΗΡΙΑ|ΠΡΟΟΡΙΣΜΟΣ|ΔΙΟΙΚΗΣΗ|ΤΗΛΕΦΩΝΟ|Ημ\/νια/);
    }
  });

  it('reads a parcel on its way by its newest scan with a stage', () => {
    const result = parseTaxydema(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ', last_update: '2026-03-13T07:31:10+02:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.stage ?? null)).toEqual([null, 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'accepted']);
  });

  it('settles a delivery or a return from the progress rail\'s last step', () => {
    // The rail's dated last step for a parcel going back is its return to the sender.
    expect(parseTaxydema(changed('delivered', (result) => { result.horizontalInfo!.returnToSender = true; }), DELIVERED))
      .toMatchObject({ status: 'exception', current_stage: 'returned' });
    const returned = parseTaxydema(changed('delivered', (result) => { result.horizontalInfo!.returnToSender = true; }), DELIVERED);
    expect(returned).not.toHaveProperty('delivered_at');
    // A delivery the rail dates without a delivery scan.
    const railOnly = changed('in-transit', (result) => { result.horizontalInfo!.delivered = '2026-03-13 11:05:00'; });
    expect(parseTaxydema(railOnly, IN_TRANSIT)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-13T11:05:00+02:00' });
    // A return still to come, without a date, leaves the scans to decide.
    expect(parseTaxydema(changed('in-transit', (result) => { result.horizontalInfo!.returnToSender = true; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    expect(parseTaxydema(changed('in-transit', (result) => { delete result.horizontalInfo; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('takes people, phones, links and notice numbers out of the wording', () => {
    expect(taxydemaWording('Η αποστολή παραδόθηκε στον παραλήπτη: ΔΕΙΓΜΑ ΔΕΙΓΜΑΤΟΣ, Ημ/νια: 26/10/2026, Ώρα: 13:27'))
      .toBe('Η αποστολή παραδόθηκε στον παραλήπτη');
    expect(taxydemaWording('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ ΣΤΟ ΤΗΛΕΦΩΝΟ: [*******00000] ΜΕ ΘΕΜΑ: [ΕΧΕΤΕ ΔΕΜΑ ΑΠΟ SAMPLE ΕΔΩ: link.example/x]'))
      .toBe('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ');
    expect(taxydemaWording('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΑΦΙΞΗΣ ΣΤΟ EMAIL: sample@example.com')).toBe('ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΑΦΙΞΗΣ');
    expect(taxydemaWording('Αποτυχία παράδοσης, Αιτιολογία: Λάθος διεύθυνση, Αρ. Ειδοποίησης: 5550123'))
      .toBe('Αποτυχία παράδοσης, Αιτιολογία: Λάθος διεύθυνση');
    expect(taxydemaWording('Επικοινωνία στο 6900000000 ή +302100000000 εδώ short.example/abc ή https://link.example/x {{Link}}'))
      .toBe('Επικοινωνία στο ή εδώ ή');
    // A full stop between words and a branch's slash stay.
    expect(taxydemaWording('Παραλαβή από σταθμό εξαγωγής.Κτχ Πάγκου-Διαδικασία χρέωσης')).toBe('Παραλαβή από σταθμό εξαγωγής.Κτχ Πάγκου-Διαδικασία χρέωσης');
    expect(taxydemaWording('Αφιξη σε Κ/Δ ΠΑΡΑΔΕΙΓΜΑ')).toBe('Αφιξη σε Κ/Δ ΠΑΡΑΔΕΙΓΜΑ');
  });

  it('names a message\'s station never, even when its subject holds a separator', () => {
    const payload = changed('in-transit', (result) => {
      result.verticalStatus![0] = '2026-03-13 07:31:10 - ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ ΣΤΟ ΤΗΛΕΦΩΝΟ: [*******00000] ΜΕ ΘΕΜΑ: [ΔΕΙΓΜΑ - ΚΕΙΜΕΝΟ';
    });
    expect(parseTaxydema(payload, IN_TRANSIT).events![0]).toEqual({ time: '2026-03-13T07:31:10+02:00', description: 'ΑΠΟΣΤΟΛΗ ΕΝΗΜΕΡΩΣΗΣ ΠΑΡΑΛΗΠΤΗ' });
  });

  it('counts a shipment only when its waybill is the number asked', () => {
    expect(() => parseTaxydema(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Taxydema answered for another shipment' }));
    expect(() => parseTaxydema(changed('delivered', (result) => { result.tt_code = `${DELIVERED}1`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTaxydema(changed('delivered', (result) => { result.tt_code = `${DELIVERED}${' '.repeat(60)}9`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseTaxydema(changed('delivered', (result) => { result.tt_code = ` ${DELIVERED} `; }), DELIVERED)).toMatchObject({ status: 'delivered' });
  });

  it('reads a shipment without scans as no history', () => {
    expect(() => parseTaxydema(changed('delivered', (result) => { result.verticalStatus = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseTaxydema(changed('delivered', (result) => { delete result.verticalStatus; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const payload of [
      {},
      { result: null },
      { result: [] },
      changed('delivered', (result) => { delete result.tt_code; }),
      changed('delivered', (result) => { result.tt_code = Number(DELIVERED); }),
      changed('delivered', (result) => { Object.assign(result, { verticalStatus: 'none' }); }),
      changed('delivered', (result) => { result.verticalStatus![1] = { title: 'Παραδόθηκε' }; }),
      changed('delivered', (result) => { result.verticalStatus![1] = 'Η αποστολή παραδόθηκε στον παραλήπτη  - ΠΑΡΑΔΕΙΓΜΑ ΤΧ'; }),
      changed('delivered', (result) => { result.verticalStatus![1] = '26/10/2026 13:27 - Η αποστολή παραδόθηκε στον παραλήπτη  - ΠΑΡΑΔΕΙΓΜΑ ΤΧ'; }),
      changed('delivered', (result) => { result.verticalStatus![1] = '2026-10-26 24:00:00 - Η αποστολή παραδόθηκε στον παραλήπτη  - ΠΑΡΑΔΕΙΓΜΑ ΤΧ'; }),
      changed('delivered', (result) => { result.verticalStatus![1] = '2026-02-30 13:27:05 - Η αποστολή παραδόθηκε στον παραλήπτη  - ΠΑΡΑΔΕΙΓΜΑ ΤΧ'; }),
      changed('delivered', (result) => { result.verticalStatus![1] = '2026-10-26 13:27:05 - .  - ΠΑΡΑΔΕΙΓΜΑ ΤΧ'; }),
      changed('delivered', (result) => { result.verticalStatus = Array.from({ length: 301 }, () => result.verticalStatus![1]); }),
      changed('delivered', (result) => { Object.assign(result, { horizontalInfo: 'delivered' }); }),
      changed('delivered', (result) => { result.horizontalInfo!.delivered = '26/10/2026 13:27'; }),
      changed('delivered', (result) => { result.horizontalInfo!.delivered = 1793021225000; }),
    ]) {
      expect(() => parseTaxydema(payload, DELIVERED), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The page reads a missing parcel from HTTP 404 with its error.
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // The same error with HTTP 200 is not the page's answer, and another error with 404 settles nothing.
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"error":"Σφάλμα"}', { status: 404 })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The server's own page for a route it does not have, a gone route and a redirect.
    await expect(lookup('<!DOCTYPE html><html><pre>Cannot GET /api/track-request/</pre></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.taxydema.gr/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The site refuses some clients' names; a CDN's browser check could come with HTTP 200.
    await expect(lookup(text('forbidden'), { status: 403 })).rejects.toMatchObject({ kind: 'challenge', message: 'Taxydema refused the lookup' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>Taxydema</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 206 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failure to reach Taxydema, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TaxydemaTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'taxydema', step: 'retry', outcome: 'ok' }));
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

  it('recognizes a known waybill and the not-found reply, and asks nothing for a number Taxydema does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered')))
      .mockResolvedValueOnce(reply(text('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-26T11:58:27.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('CV000000000GR')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Taxydema does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['40000000001', '4000000000170', 'CV000000000GR', 'SAMPLETRACKING', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTaxydemaNumber(' 4000-0000-0017 ')).toBe(DELIVERED);
  });

  it('routes a number filed under Taxydema to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'taxydema' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'taxydema', source: 'taxydema', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === taxydemaLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Taxydema numbers', () => {
  it('claims no twelve-digit number, which other carriers issue too', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      const detected = detectCarrierMatch(number);
      expect(detected.carrier === 'taxydema' && detected.confidence === 'high', number).toBe(false);
    }
  });
});

describe('Taxydema status vocabulary', () => {
  // Stand-ins for the parts of a wording `statuses.json` leaves out.
  const filled = (wording: string) => wording.replace('ΤΗΛΕΦΩΝΟ: […]', 'ΤΗΛΕΦΩΝΟ: [*******00000]')
    .replace('ΘΕΜΑ: […]', 'ΘΕΜΑ: [ΕΧΕΤΕ ΔΕΜΑ ΑΠΟ SAMPLE SENDER]').replace('Νο: …', `Νο: ${DELIVERED}`).replaceAll('…', 'HUB ΠΑΡΑΔΕΙΓΜΑ ΤΧ');

  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      const description = taxydemaWording(filled(entry.wording));
      const answer = statusMapAnswer({ carrier: 'taxydema', providerCode: null, description });
      if (entry.unmapped) {
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(taxydemaStage(description), entry.wording).toBe(entry.stage);
    }
  });

  it('reads either casing, and leaves an unknown scan unmapped', () => {
    expect(taxydemaStage('ΑΝΑΘΕΣΗ ΑΠΟΣΤΟΛΗΣ ΓΙΑ ΠΑΡΑΔΟΣΗ ΣΕ ΔΙΑΝΟΜΕΑ')).toBe('out_for_delivery');
    expect(taxydemaStage('η αποστολη παραδοθηκε στον παραληπτη.')).toBe('delivered');
    expect(taxydemaStage('Η αποστολή παραδόθηκε στον παραλήπτη: ΔΕΙΓΜΑ')).toBeUndefined();
    expect(statusMap.stage(null, 'synthetic scan')).toBeUndefined();
    expect(statusMap.stage('1', 'Αναχώρηση από κατάστημα')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'taxydema', providerCode: null, description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});
