import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition, carrierRequirements, requirementSatisfied } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InputRequiredError, InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ARROW_XL_TRACKING, ArrowXlTracker, arrowXlTrackingUrl } from './adapter.js';
import { normalizeArrowXlNumber, normalizeArrowXlPostcode, parseArrowXl } from './parser.js';
import { arrowXlStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '8ZZZ00000001A';
const LABEL = `${NUMBER}001`;
const UNKNOWN = '8ZZZ00000000A';
const POSTCODE = 'ZZ1 1ZZ';
const MARCH = Date.parse('2026-03-20T12:00:00Z');
const NEW_YEAR = Date.parse('2026-01-03T10:00:00Z');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const failure = (pending: Promise<unknown>) => pending.then(() => undefined, (error: unknown) => error as Record<string, unknown>);
const urlFor = (number: string, postcode = 'ZZ1+1ZZ') => `${ARROW_XL_TRACKING}?upi=${number}&postcode=${postcode}`;

describe('ArrowXL HTTP adapter', () => {
  it('asks the tracking form once with the whole reference and the postcode, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ArrowXlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => MARCH })
      .fetch(' 8zzz 0000 0001a 001 ', ' zz1   1zz ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(urlFor(LABEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'arrow-xl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered history newest first on its wall clocks, without the hub placeholder or the repeated row', () => {
    const result = normalizeCarrierResult(parseArrowXl(fixture('delivered'), NUMBER, MARCH));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Success Electronic Signature Captured', last_update: null,
      last_update_local: '2026-03-12T11:27:00', expected_delivery: null });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-03-12T11:27:00', 'Delivery Success Electronic Signature Captured', null, 'delivered'],
      ['2026-03-12T07:43:00', 'Out For Delivery', null, 'out_for_delivery'],
      ['2026-03-12T07:40:00', 'Loaded Onto Delivery Van', null, 'out_for_delivery'],
      ['2026-03-12T05:44:00', 'Stock Received In Delivery Site', null, 'in_transit'],
      ['2026-03-11T17:08:00', 'Route Planned For 12-MAR-2026', null, null],
      ['2026-03-09T00:02:00', 'Customer Booked 12-MAR-2026', null, null],
      ['2026-03-08T18:42:00', 'Unable To Deliver - No-One Home - Carded', null, 'failed_attempt'],
      ['2026-03-08T10:16:00', 'Loaded Onto Delivery Van', null, 'out_for_delivery'],
      ['2026-03-08T08:19:00', 'Stock Received In Delivery Site', 'Sampleton', 'in_transit'],
      ['2026-03-07T17:12:00', 'Route Planned For 08-MAR-2026', null, null],
      ['2026-03-06T18:16:00', 'Stock Received Into Network', 'Sampleton', 'accepted'],
      ['2026-03-05T10:41:00', 'Order Data Created', null, 'registered'],
    ]);
    expect(result.events!.every((event) => !event.time)).toBe(true);
  });

  it('dates a history across the new year and expects the booked day', () => {
    const result = parseArrowXl(fixture('in-transit'), NUMBER, NEW_YEAR);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Route Planned For 05-JAN-2026',
      last_update_local: '2026-01-02T17:06:00', expected_delivery: '2026-01-05' });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null])).toEqual([
      ['2026-01-02T17:06:00', null], ['2026-01-02T09:30:00', null], ['2025-12-31T14:05:00', null], ['2025-12-30T20:05:00', 'in_transit'],
      ['2025-12-29T22:10:00', null], ['2025-12-29T13:02:00', 'registered'], ['2025-12-29T13:02:00', 'registered'],
    ]);
    expect(result.events![0]).toMatchObject({ location: 'Exampleford' });
    // A booked day that has passed the newest scan, or one an attempt came after, is no estimate.
    expect(parseArrowXl(fixture('in-transit').replace('Route Planned For 05-JAN-2026', 'Route Planned For 01-JAN-2026'), NUMBER, NEW_YEAR))
      .toMatchObject({ expected_delivery: null });
    expect(parseArrowXl(fixture('in-transit').replace('Customer Contact - Details Updated', 'Unable To Deliver - Unable To Reach Property')
      .replace('Route Planned For 05-JAN-2026', 'Out For Delivery'), NUMBER, NEW_YEAR)).toMatchObject({ current_stage: 'out_for_delivery',
      expected_delivery: null });
  });

  it('reads the older pages, oldest row first with the year in each clock', () => {
    const rows = [...fixture('in-transit').matchAll(/(\d{2})-(Dec|Jan)&nbsp;(\d{2}:\d{2})/g)];
    const older = fixture('in-transit').replace(/<tbody>[\s\S]*<\/tbody>/, (body) => {
      const trs = body.match(/<tr[\s\S]*?<\/tr>/g)!.reverse();
      return `<tbody>\n${trs.join('\n')}\n</tbody>`;
    }).replace(/(\d{2})-(Dec|Jan)&nbsp;(\d{2}:\d{2})/g, (_, day: string, month: string, clock: string) =>
      `${day}-${month}-${month === 'Dec' ? 2025 : 2026}&nbsp;&nbsp;&nbsp;&nbsp;${clock}`);
    expect(rows).toHaveLength(7);
    const result = parseArrowXl(older, NUMBER, Date.parse('2026-06-01T00:00:00Z'));
    expect(result.events!.map((event) => event.local_time)).toEqual(parseArrowXl(fixture('in-transit'), NUMBER, NEW_YEAR)
      .events!.map((event) => event.local_time));
    expect(result.events!.at(-1)!.description).toBe('Order Data Created');
  });

  it('follows a collection to the retailer’s returns site', () => {
    const result = parseArrowXl(fixture('collection'), NUMBER, MARCH);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Despatched To Client Return Site',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.description, event.stage ?? null])).toEqual([
      ['Despatched To Client Return Site', 'returned'], ['Collection Success', 'accepted'], ['Out For Collection', 'registered'],
      ['Route Planned For 12-MAR-2026', null], ['Collection Data Created', 'registered'], ['Order Data Received', 'registered'],
    ]);
  });

  it('reads the crew’s page on the day as out for delivery, without the crew, the stops, the window or the van', () => {
    const result = normalizeCarrierResult(parseArrowXl(fixture('crew'), NUMBER, MARCH));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery',
      expected_delivery: '2026-03-20', summary_only: true, events: [] });
    const kept = JSON.stringify(result);
    for (const value of ['Alex', 'Sam', '11:00', '10:15', '52.0', 'SYNTHETIC-MAPS-KEY']) expect(kept, value).not.toContain(value);
    // The day is the UK's: just after midnight in summer it is already the next day.
    expect(parseArrowXl(fixture('crew'), NUMBER, Date.parse('2026-06-30T23:30:00Z'))).toMatchObject({ expected_delivery: '2026-07-01' });
    expect(parseArrowXl(fixture('crew').replace('Your delivery crew', 'Your collection crew'), NUMBER, MARCH))
      .toMatchObject({ current_stage: 'registered', last_status_text: 'On the Road', expected_delivery: null });
    expect(() => parseArrowXl(fixture('crew').replace('Your delivery crew', 'Your crew'), NUMBER, MARCH))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the progress bar alone when no row is listed, and settles a delivery whose success row is missing', () => {
    const empty = fixture('in-transit').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody>\n</tbody>');
    expect(parseArrowXl(empty, NUMBER, NEW_YEAR)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'With us',
      summary_only: true, events: [] });
    expect(() => parseArrowXl(empty.replace(/<img class="progress-image"[^>]*>/, ''), NUMBER, NEW_YEAR)).toThrow(NoHistoryError);
    const settled = parseArrowXl(fixture('delivered').replace(/[\s\S]{0,400}Delivery Success Electronic Signature Captured[\s\S]*?<\/tr>/, '<tr>'),
      NUMBER, MARCH);
    expect(settled).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Successfully Delivered' });
  });

  it('reads the notice as inconclusive, since a wrong postcode gets it too, once it echoes the reference asked', async () => {
    const lookup = (body: string, number = UNKNOWN, init?: ResponseInit) => failure(carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init)))
      .track({ number, postcode: POSTCODE }));
    expect(await lookup(fixture('not-found'))).toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // The notice for another reference, or the empty form, is not this one's.
    expect(await lookup(fixture('not-found'), NUMBER)).toMatchObject({ kind: 'indeterminate' });
    expect((await lookup(fixture('not-found'), NUMBER))!.reason).toBeFalsy();
    expect((await lookup(fixture('not-found').replace('value="8ZZZ00000000A"', 'value=""')))!.reason).toBeFalsy();
    expect(await lookup(fixture('not-found').replace('UPI number', 'Service'))).toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a block, a moved page and a changed reply apart from a missing parcel', async () => {
    const lookup = (body: string, init?: ResponseInit) => failure(carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init)))
      .track({ number: NUMBER, postcode: POSTCODE }));
    expect(await lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>')).toMatchObject({ kind: 'challenge' });
    expect(await lookup('<html><body><div class="g-recaptcha"></div></body></html>')).toMatchObject({ kind: 'challenge' });
    expect(await lookup('', { status: 302, headers: { Location: 'https://askaxl.co.uk/' } })).toMatchObject({ kind: 'transport' });
    // A missing page is a moved route, not a missing parcel.
    expect(await lookup('<html><title>404 - File or directory not found.</title></html>', { status: 404 })).toMatchObject({ kind: 'transport' });
    expect(await lookup('', { status: 410 })).toMatchObject({ kind: 'transport' });
    expect(await lookup('<html><body><p>Maintenance</p></body></html>')).toMatchObject({ kind: 'schema' });
    for (const change of [
      (html: string) => html.replace('is my delivery?', 'is my order?'),
      (html: string) => html.replace('12-Mar&nbsp;11:27', '12/03 11:27'),
      (html: string) => html.replace('12-Mar&nbsp;11:27', '31-Feb&nbsp;11:27'),
      (html: string) => html.replace('12-Mar&nbsp;11:27', '12-Mar&nbsp;24:10'),
      (html: string) => html.replace('Out For Delivery <span', '<span'),
      (html: string) => html.replace('<td class="keeping-track-bullet"><i class="fa fa-circle yellow-bullet"></i></td>', ''),
      (html: string) => html.replace(/<tr style=font-weight:bold>[\s\S]*?<\/tr>/, (row) => row.repeat(301)),
    ]) {
      expect(await lookup(change(fixture('delivered')))).toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s without the postcode in its details', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page('<html>synthetic</html>', { status, headers: { 'Retry-After': '30' } }));
      const error = await failure(carrier(fetcher).track({ number: NUMBER, postcode: POSTCODE }));
      expect(error).toMatchObject({ kind, status });
      expect(error!.request).toBeUndefined();
      expect(error!.diagnostics).toBeUndefined();
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 30_000 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps the postcode out of a failed connection and bounds the reply', async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await failure(carrier(down).track({ number: NUMBER, postcode: POSTCODE }));
    expect(error).toMatchObject({ kind: 'transport' });
    expect(error!.request).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('ZZ1');
    const large = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: NUMBER, postcode: POSTCODE })).rejects.toThrow('unexpectedly large');
  });

  it('asks nothing without the postcode, for a reference ArrowXL does not issue, or once the lookup is cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toBeInstanceOf(InputRequiredError);
    await expect(carrier(fetcher).track({ number: NUMBER, postcode: '  ' })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(carrier(fetcher).track({ number: NUMBER, postcode: 'ZZ1/1ZZ' })).rejects.toBeInstanceOf(InvalidInputError);
    for (const number of ['8ZZZ00000', '8ZZZ00000001A0012', 'ZZZZZZZZZZZZ', `8${'0'.repeat(80)}`]) {
      await expect(carrier(fetcher).track({ number, postcode: POSTCODE }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER, postcode: POSTCODE }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeArrowXlNumber('8zzz-0000 0001a')).toBe(NUMBER);
    expect(normalizeArrowXlPostcode(' zz1   1zz ')).toBe(POSTCODE);
    expect(arrowXlTrackingUrl(NUMBER, 'zz11zz')).toBe(urlFor(NUMBER, 'ZZ11ZZ'));
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('ends a hanging read inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER, postcode: POSTCODE }, { budgetMs: 40 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes an ArrowXL reference with its postcode to the adapter when the carrier is chosen', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: NUMBER, carrier: 'arrow-xl', postcode: 'zz1 1zz' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'arrow-xl', source: 'arrow-xl', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === urlFor(NUMBER))).toBe(true);
    await expect(tracker.track({ number: NUMBER, carrier: 'arrow-xl' }, { budgetMs: 3000 }))
      .rejects.toMatchObject({ attempts: [{ source: 'arrow-xl', kind: 'input_required' }] });
  });
});

describe('ArrowXL references and postcode', () => {
  it('claims no reference, since Yodel prints the same layout, and lets the form take a UK postcode beside one, or none', () => {
    expect(detectCarrierMatch(LABEL).candidates).not.toContain('arrow-xl');
    expect(carrierDefinition('arrow-xl').tracking).toMatchObject({ adapter: 'arrow-xl', localClocks: true });
    expect(carrierDefinition('arrow-xl').tracking).not.toHaveProperty('recognition');
    const [requirement] = carrierRequirements('arrow-xl', NUMBER);
    expect(requirement).toMatchObject({ field: 'postcode', validator: 'internationalPostcode', optional: true, autoComplete: 'postal-code' });
    expect(requirementSatisfied(requirement!, '  ')).toBe(true);
    for (const value of ['SW1A 1AA', 'sw1a1aa', 'M1 1AE', 'B33 8TH', 'DN55 1PT']) expect(requirementSatisfied(requirement!, value), value).toBe(true);
    for (const value of ['8000', '75001', 'SW1A 1AI', 'SW1A1']) expect(requirementSatisfied(requirement!, value), value).toBe(false);
    expect(() => new RegExp(requirement!.pattern!, 'v')).not.toThrow();
    expect(normalizeCarrierInputs('arrow-xl', NUMBER, '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(normalizeCarrierInputs('arrow-xl', LABEL, '', ' sw1a  1aa ')).toEqual({ trackingUrl: null, postcode: 'SW1A 1AA' });
  });
});

describe('ArrowXL status vocabulary', () => {
  it('records every wording seen with the stage the map gives it, and leaves bookings and notes without one', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      const wording = entry.wording.replace('…', '12-MAR-2026');
      if (entry.unmapped) {
        expect(arrowXlStage(wording), wording).toBeNull();
        expect(statusMap.stage(null, wording.toLowerCase()), wording).toBeUndefined();
        if (!entry.wording.includes('…')) {
          expect(statusMapAnswer({ carrier: 'arrow-xl', providerCode: null, description: wording }), wording)
            .toMatchObject({ kind: 'intentional_gap' });
        }
        continue;
      }
      expect(arrowXlStage(wording), wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'arrow-xl', providerCode: null, description: wording }), wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Wording the map does not know falls to the shared rules.
    expect(arrowXlStage('Delivered to neighbour')).toMatchObject({ stage: 'delivered' });
    expect(arrowXlStage('Synthetic note')).toBeNull();
  });
});
