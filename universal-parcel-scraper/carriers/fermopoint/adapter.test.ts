import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FERMOPOINT_BOOKING, FermopointTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeFermopointNumber, parseFermopoint } from './parser.js';
import { fermopointStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'A0000AA000001';
const IN_TRANSIT = 'A0000AA000002';
const UNKNOWN = 'A0000AA000003';
const SHIPMENT = 'S0000AA000004';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
/** The page with its steps, newest first as the page writes them, replaced by these. */
const withSteps = (page: string, steps: [string, string][]) => page.replace(/(<\/tr>)(\s*<tr>[\s\S]*<\/tr>)/, (_all, end: string) =>
  `${end}${steps.map(([clock, wording]) => `\n<tr><td class="nowrap">${clock}</td><td>${wording}</td></tr>`).join('')}`);
const invalidCode = `/errore/404?msg=${encodeURIComponent('Il codice Fermoticket inserito non è valido.')}`;

describe('Fermopoint HTTP adapter', () => {
  it('reads the booking page for the whole code once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FermopointTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' a0000 aa000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FERMOPOINT_BOOKING}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fermopoint', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a collected Fermoticket on Rome’s clock, without the copy of the current step', () => {
    const result = parseFermopoint(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Pacco ritirato', last_update: '2025-10-28T18:42:07+01:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2025-10-28T18:42:07+01:00', 'Pacco ritirato', 'delivered'],
      ['2025-10-27T11:05:31+01:00', 'Arrivato al negozio', 'ready_for_pickup'],
      // The hour Rome's clocks repeat reads as its first occurrence.
      ['2025-10-26T02:30:00+02:00', 'In consegna', 'in_transit'],
      // Steps of one second keep the page's order.
      ['2025-10-24T09:12:44+02:00', 'In Preparazione', 'registered'],
      ['2025-10-24T09:12:44+02:00', 'Ritiro prenotato', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Stato corrente');
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('reads a Fermoticket on its way to the shop as in transit, not out for delivery', () => {
    const result = parseFermopoint(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In consegna',
      last_update: '2026-03-03T15:20:09+01:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['In consegna', 'In Preparazione', 'Ritiro prenotato']);
  });

  it('reads a parcel sent from a shop', () => {
    const result = parseFermopoint(fixture('shipment'), SHIPMENT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Pacco ritirato dal destinatario',
      last_update: '2026-05-14T12:31:02+02:00' });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Pacco ritirato dal destinatario', 'delivered'],
      ['Ritirato dal corriere', 'in_transit'],
      ['Consegnato al point di partenza', 'accepted'],
      ['Spedizione prenotata', 'registered'],
    ]);
  });

  it('orders the steps newest first, keeps a wall clock Rome skips and drops a repeated step', () => {
    const page = withSteps(fixture('in-transit'), [['02/03/2026 08:47:51', 'In Preparazione'], ['29/03/2026 02:30:00', 'In consegna'],
      ['02/03/2026 08:47:51', 'Ritiro prenotato'], ['02/03/2026 08:47:51', 'Ritiro prenotato']]);
    const result = parseFermopoint(page, IN_TRANSIT);
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description])).toEqual([
      ['2026-03-29T02:30:00', 'In consegna'],
      ['2026-03-02T08:47:51+01:00', 'In Preparazione'],
      ['2026-03-02T08:47:51+01:00', 'Ritiro prenotato'],
    ]);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: null, last_update_local: '2026-03-29T02:30:00' });
  });

  it('leaves a step no rule knows without a stage, and the parcel at its newest staged step', () => {
    const result = parseFermopoint(fixture('in-transit').replace('<td>In consegna</td>', '<td>Nota sintetica</td>'), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ description: 'Nota sintetica' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'registered', last_status_text: 'Nota sintetica' });
  });

  it('reads the page’s not-active notice as not found and a booking without steps as no history', () => {
    expect(() => parseFermopoint(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = fixture('in-transit').replace(/<tr[\s\S]*<\/tr>/, '');
    expect(() => parseFermopoint(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a page only when its heading names the code asked', () => {
    expect(() => parseFermopoint(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Fermopoint answered for another code' }));
    expect(() => parseFermopoint(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed page', () => {
    const page = fixture('in-transit');
    for (const changed of [
      '<html><title>Fermopoint</title><body><div class="body-content"><p>Benvenuto</p></div></body></html>',
      page.replace('Fermoticket n. <b>', 'Ordine <b>'),
      page.replace('<table class="table">', '<table class="grid">'),
      page.replace('03/03/2026 15:20:09</td>\n', '2026-03-03 15:20</td>\n'),
      page.replace('03/03/2026 15:20:09</td>\n', '31/02/2026 15:20:09</td>\n'),
      page.replace('<td>In consegna</td>', '<td> </td>'),
      page.replace('<td>In consegna</td>', '<td>In consegna</td><td>Sintetico</td>'),
      page.replace('<h4 class="font-base bold">Note</h4>', '<p>L\'ordine che stai cercando non ci risulta essere attivo.</p>'),
      page.replace(/(<tr>\s*<td class="nowrap">02\/03\/2026[\s\S]*?<\/tr>)/, (row: string) => row.repeat(201)),
    ]) {
      expect(() => parseFermopoint(changed, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown code, a refused code, a moved route, a block page, an empty page and a broken page apart', async () => {
    await expect(lookup(fixture('not-found'), {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    // The page answers a code it does not know itself: a 404 or another redirect is a moved route.
    await expect(lookup('', { status: 302, headers: { Location: invalidCode } })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('', { status: 302, headers: { Location: `https://www.fermopoint.it${invalidCode}` } })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('', { status: 302, headers: { Location: '/errore/500' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: '/accedi?returnUrl=%2Fprenotazione' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><h1>The request is blocked.</h1></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>Fermopoint</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a page over its size limit', async () => {
    await expect(lookup('x', { headers: { 'Content-Length': String(2_000_000) } })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects codes Fermopoint does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000000001', '00000AA000001', 'A0000A0000001', 'A0000AA00001', 'A0000AA0000001', 'A0000AAA00001', 'A0000AA00000A']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFermopointNumber('a0000-aa000002')).toBe(IN_TRANSIT);
  });

  it('recognizes a code it finds and not one it holds no booking for', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(fixture(String(url).endsWith(UNKNOWN) ? 'not-found' : 'delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0000000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('routes a code filed under Fermopoint to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'fermopoint' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'fermopoint', source: 'fermopoint', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(FERMOPOINT_BOOKING))).toBe(true);
  });
});

describe('Fermopoint numbers', () => {
  it('accepts every public code its rule offers, and the rule offers each', () => {
    for (const record of numbers.records) {
      expect(normalizeFermopointNumber(record.number), record.number).toBe(record.number);
      expect(detectCarrierMatch(record.number).candidates, record.number).toContain('fermopoint');
    }
  });
});

describe('Fermopoint status vocabulary', () => {
  it('records every step wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(fermopointStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'fermopoint', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'fermopoint', description: 'Nota sintetica' })).toEqual({ kind: 'unknown' });
    // A wording the map does not know falls to the shared wording rules.
    expect(fermopointStage('Nota sintetica')).toBeNull();
  });
});
