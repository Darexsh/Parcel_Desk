import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DEXPRESS_PAGE, DexpressTracker } from './adapter.js';
import { normalizeDexpressNumber, parseDexpress } from './parser.js';
import { dexpressMappedStage, dexpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ0000000001';
const IN_TRANSIT = 'ZZ0000000002';
const UNKNOWN = 'ZZ0000000003';

type Row = { statusTime: string; statusValue: string };
type Reply = Record<string, unknown> & { shipmentCode: string; htmlTable: string; historyStatuses: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
/** A summary line of the fixture's HTML replaced, as `<dt>label:</dt>` followed by its value. */
const field = (reply: Reply, label: string, value: string) => {
  reply.htmlTable = reply.htmlTable.replace(new RegExp(`(<dt>${label}:</dt>\\s*<dd>)[^<]*`), `$1${value}`);
};
// The page answers JSON as text/html.
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('D Express HTTP adapter', () => {
  it('posts the whole code in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DexpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 0000-000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'failed_attempt' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DEXPRESS_PAGE);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body))))
      .toEqual({ ajax: 'yes', task: 'search', 'data[package_tracking_search]': IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'd-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan’s wall clock in Belgrade, newest first, and stages it by its wording', () => {
    const result = parseDexpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Pošiljka je isporučena primaocu', last_update: '2026-10-26T11:42:07+01:00', delivered_at: '2026-10-26T11:42:07+01:00' });
    expect(result.events!.map((event) => [event.time, event.stage, event.description])).toEqual([
      ['2026-10-26T11:42:07+01:00', 'delivered', 'Pošiljka je isporučena primaocu'],
      ['2026-10-26T08:03:15+01:00', 'out_for_delivery', 'Pošiljka zadužena za isporuku'],
      // Before the clocks went back.
      ['2026-10-24T08:12:40+02:00', 'out_for_delivery', 'Pošiljka zadužena za isporuku'],
      // Two scans on one second keep the reply's order, the later one newer.
      ['2026-10-23T14:05:31+02:00', 'registered', 'Čeka na preuzimanje'],
      ['2026-10-23T14:05:31+02:00', 'accepted', 'Pošiljka je preuzeta od pošiljaoca'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    // The recipient, the town, the parcel count and the centre's phone stay out.
    expect(JSON.stringify(result)).not.toMatch(/Sam\*|Sample|000-000|Broj|Grad|Primalac/);
  });

  it('puts the centre holding the shipment on the current scan', () => {
    const result = parseDexpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Ponovni pokušaj isporuke, nema nikoga na adresi', last_update: '2026-03-03T16:02:03+01:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.stage, event.location ?? null])).toEqual([
      ['failed_attempt', 'Sample Town'], ['out_for_delivery', null], ['accepted', null], ['registered', null],
    ]);
    const courier = parseDexpress(changed('in-transit', (body) => field(body, 'Lokacija', 'Kod kurira centra: Sample Town')), IN_TRANSIT);
    expect(courier.events![0]).toMatchObject({ location: 'Sample Town' });
    // Only a centre's name, and only when the newest scan is the current status.
    for (const change of [
      (body: Reply) => field(body, 'Lokacija', 'U magacinu centra: 000-000-0000'),
      (body: Reply) => field(body, 'Lokacija', 'Pošiljka isporučena'),
      (body: Reply) => field(body, 'Vreme statusa', '03.03.2026 16:02:04'),
      (body: Reply) => body.historyStatuses.pop(),
    ]) {
      expect(parseDexpress(changed('in-transit', change), IN_TRANSIT).events!.every((event) => !event.location)).toBe(true);
    }
  });

  it('takes the current status’s stage, and the newest staged scan when the status moves nothing', () => {
    const returned = parseDexpress(changed('in-transit', (body) => {
      body.historyStatuses.splice(3, 1, { statusTime: '04.03.2026 09:00:00', statusValue: 'Pošiljka se vraća pošiljaocu' },
        { statusTime: '05.03.2026 12:30:45', statusValue: 'Pošiljka je vraćena pošiljaocu' });
      field(body, 'Trenutni status', 'Pošiljka je vraćena pošiljaocu');
      field(body, 'Vreme statusa', '05.03.2026 12:30:45');
      field(body, 'Lokacija', 'Pošiljka vraćena pošiljaocu');
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Pošiljka je vraćena pošiljaocu' });
    expect(returned.events!.slice(0, 2).map((event) => event.stage)).toEqual(['returned', 'returned']);

    const redirected = parseDexpress(changed('in-transit', (body) => {
      body.historyStatuses.splice(2, 2, { statusTime: '03.03.2026 07:46:50', statusValue: 'Preusmerena na paketomat' });
      field(body, 'Trenutni status', 'Preusmerena na paketomat');
      field(body, 'Vreme statusa', '03.03.2026 07:46:50');
    }), IN_TRANSIT);
    expect(redirected).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Preusmerena na paketomat', last_update: '2026-03-03T07:46:50+01:00' });
    expect(redirected.events![0]).not.toHaveProperty('stage');

    // A scan the reply lists twice is kept once.
    const repeated = parseDexpress(changed('delivered', (body) => body.historyStatuses.push(body.historyStatuses.at(-1)!)), DELIVERED);
    expect(repeated.events).toHaveLength(5);
  });

  it('keeps a current status without scans as a summary, and nothing at all as no history', () => {
    const summary = parseDexpress(changed('in-transit', (body) => { body.historyStatuses = []; }), IN_TRANSIT);
    expect(summary).toMatchObject({ summary_only: true, current_stage: 'failed_attempt', last_update: '2026-03-03T16:02:03+01:00', events: [] });
    expect(parseDexpress(changed('delivered', (body) => { delete (body as Record<string, unknown>).historyStatuses; }), DELIVERED))
      .toMatchObject({ summary_only: true, current_stage: 'delivered', delivered_at: '2026-10-26T11:42:07+01:00' });
    expect(() => parseDexpress(changed('in-transit', (body) => {
      body.historyStatuses = [];
      field(body, 'Trenutni status', '-');
      field(body, 'Vreme statusa', '-');
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the page’s not-found notice as not found, and other refusals as inconclusive', () => {
    expect(() => parseDexpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDexpress({ flag: false, info: 'Neophodno je uneti ID pošiljke.' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDexpress({ flag: false }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps only the reply that names the whole code asked', () => {
    expect(() => parseDexpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'D Express answered for another shipment' }));
    expect(() => parseDexpress(changed('in-transit', (body) => { body.shipmentCode = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDexpress(changed('in-transit', (body) => { body.shipmentCode = `${IN_TRANSIT}0`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.flag; },
      (body: Reply) => { body.flag = 'true'; },
      (body: Reply) => { delete (body as Record<string, unknown>).shipmentCode; },
      (body: Reply) => { delete (body as Record<string, unknown>).htmlTable; },
      (body: Reply) => { body.htmlTable = '<div class="shipment-track"></div>'; },
      (body: Reply) => { body.htmlTable += body.htmlTable; },
      (body: Reply) => { body.historyStatuses = 'scans' as never; },
      (body: Reply) => { body.historyStatuses = Array.from({ length: 201 }, () => body.historyStatuses[0]!); },
      (body: Reply) => { body.historyStatuses[0] = 'scan' as never; },
      (body: Reply) => { body.historyStatuses[0]!.statusValue = ' '; },
      (body: Reply) => { body.historyStatuses[0]!.statusValue = ['Čeka na preuzimanje'] as never; },
      (body: Reply) => { body.historyStatuses[0]!.statusTime = '2026-03-02 09:15:22'; },
      (body: Reply) => { body.historyStatuses[0]!.statusTime = '02.03.2026 09:15'; },
      (body: Reply) => { body.historyStatuses[0]!.statusTime = '02.03.2026 24:00:00'; },
      (body: Reply) => { body.historyStatuses[0]!.statusTime = '30.02.2026 09:15:22'; },
      (body: Reply) => { delete (body.historyStatuses[0] as Partial<Row>).statusTime; },
      (body: Reply) => field(body, 'Vreme statusa', '03.03.2026'),
    ]) {
      expect(() => parseDexpress(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown code, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers every code with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.dexpress.rs/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Praćenje pošiljaka | Dexpress</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known code with its last scan, the not-found answer, and asks nothing for a code D Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-26T10:42:07.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ZZ000000000%')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses what D Express does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The tracker's search is looser than the form: only whole codes are sent.
    for (const number of ['ZZ000000000', 'ZZ00000000000', 'Z00000000001', '000000000001', 'ZZ000000000_', 'ZZ%', 'ZZ0000000001,ZZ0000000002', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDexpressNumber(' zz 0000-000-001 ')).toBe(DELIVERED);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a code filed under D Express, or opened from its tracker link, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'd-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'd-express', source: 'd-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === DEXPRESS_PAGE)).toBe(true);
    for (const link of [`https://www.dexpress.rs/rs/pracenje-posiljaka/${DELIVERED}`, `https://www.dexpress.rs/en/track-and-trace/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'd-express' });
    }
  });
});

describe('D Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(dexpressStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'd-express', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMapAnswer({ carrier: 'd-express', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(dexpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown wording to the shared rules', () => {
    expect(statusMap.stage(null, 'sample note')).toBeUndefined();
    expect(dexpressMappedStage('Pošiljka je isporučena primaocu')).toBeUndefined();
    expect(dexpressMappedStage('pošiljka je isporučena primaocu')).toBe('delivered');
    expect(dexpressStage('  POŠILJKA   je isporučena primaocu ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(dexpressStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(dexpressStage('Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'd-express', providerCode: null, description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
