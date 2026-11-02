import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LA_POSTE_BURKINA_FASO_ITEM, LaPosteBurkinaFasoTracker } from './adapter.js';
import { laPosteBurkinaFasoItemUrl, normalizeLaPosteBurkinaFasoNumber, parseLaPosteBurkinaFasoItem } from './parser.js';
import { laPosteBurkinaFasoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const OUTBOUND = 'ZZ000000014BF';
// Mail from abroad keeps the sending post's code.
const INBOUND = 'ZZ000000028FR';
const UNKNOWN = 'ZZ000000045BF';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// One row of the page's history, as the page writes it.
const row = (clock: string, country: string, office: string, event: string, extra = '') => `<tr class="tabl1">
<td align="center" width="10%">${clock}</td><td align="center" width="10%">${country}</td><td align="center" width="10%">${office}</td>
<td align="center" width="15%">${event}</td><td align="center" width="10%">A</td><td align="center" width="15%"> </td>
<td align="center" width="15%">${extra}</td><td align="center" width="10%"> </td></tr>`;
// The outbound item's page with these rows instead of its own.
const withRows = (rows: string) => page('outbound-delivered').replace(/(Extra Information<\/td>[\s\S]*?<\/tr>)[\s\S]*?(<\/tbody>)/, `$1${rows}$2`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

describe('La Poste Burkina Faso tracking adapter', () => {
  it('opens the page for the whole code once, as the tracker\'s form does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('outbound-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LaPosteBurkinaFasoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 bf ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LA_POSTE_BURKINA_FASO_ITEM}?itemid=${OUTBOUND}&Submit=Submit`);
    expect(String(url)).toBe(laPosteBurkinaFasoItemUrl(OUTBOUND));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'la-poste-burkina-faso', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an item delivered abroad newest first, Burkina Faso\'s scans on Ouagadougou\'s clock and the French ones on their own', () => {
    const result = parseLaPosteBurkinaFasoItem(page('outbound-delivered'), OUTBOUND);
    // The delivery abroad has no offset, so it gives no delivery instant.
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item (Inb)', last_update: null, last_update_local: '2026-03-11T12:14:00', expected_delivery: null,
      destination_country: 'FR', events: expect.any(Array) });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      // Who signed, the image and the office's postcode are dropped.
      ['2026-03-11T12:14:00', 'SAMPLE DELIVERY OFFICE, France', 'Deliver item (Inb)', 'delivered'],
      // An office named by its number alone gives only its country.
      ['2026-03-11T06:00:00', 'France', 'Receive item at delivery office (Inb)', 'in_transit'],
      ['2026-03-11T00:00:00', 'France', 'Send item out for physical delivery (Inb)', 'out_for_delivery'],
      ['2026-03-09T17:35:00', 'France', 'Receive item at sorting centre (Inb)', 'in_transit'],
      ['2026-03-09T07:00:00', 'SAMPLE INWARD OFFICE, France', 'Return item from customs (Inb)', 'in_transit'],
      // The scan the page lists twice is kept once.
      ['2026-03-09T07:00:00', 'SAMPLE INWARD OFFICE, France', 'Receive item at office of exchange (Inb)', 'in_transit'],
      ['2026-03-03T14:18:37+00:00', 'SAMPLE EXCHANGE OFFICE, Burkina Faso', 'Insert item into bag (Otb)', 'in_transit'],
      ['2026-03-03T12:29:53+00:00', 'SAMPLE EXCHANGE OFFICE, Burkina Faso', 'Receive item at office of exchange (Otb)', 'in_transit'],
      ['2026-03-02T09:12:41+00:00', 'SAMPLE TOWN, Burkina Faso', 'Receive item from customer (Otb)', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.filter((event) => event.local_time).every((event) => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|showImagePopup|sample\.jpg|99000|TOWN 0001/);
  });

  it('reads mail from abroad held after a failed attempt in Burkina Faso, with the reason and the measure', async () => {
    const result = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('inbound')))).track({ number: INBOUND });
    expect(result).toEqual({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Unsuccessful item delivery attempt (Inb): Addressee absent; Item held at the delivery office',
      last_update: '2026-04-28T16:20:05+00:00', expected_delivery: null, destination_country: 'BF', events: [
        { time: '2026-04-28T16:20:05+00:00', location: 'SAMPLE TOWN, Burkina Faso',
          description: 'Unsuccessful item delivery attempt (Inb): Addressee absent; Item held at the delivery office', stage: 'failed_attempt',
          stage_source: 'carrier_map' },
        { time: '2026-04-27T08:15:00+00:00', location: 'SAMPLE TOWN, Burkina Faso', description: 'Receive item at delivery office (Inb)',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-24T11:40:10+00:00', location: 'SAMPLE EXCHANGE OFFICE, Burkina Faso', description: 'Send item to domestic location (Inb)',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-24T10:02:44+00:00', location: 'SAMPLE EXCHANGE OFFICE, Burkina Faso',
          description: 'Receive item at office of exchange (Inb)', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-04-20T21:05:00', location: 'SAMPLE SORTING CENTRE, France', description: 'Send item abroad (EDI-received)',
          stage: 'in_transit', stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toContain('SAMPLE PERSON');
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('inbound')))).recognize!(INBOUND))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-04-28T16:20:05.000Z' });
  });

  it('gives a delivery in Burkina Faso its instant, and leaves new wording unstaged', () => {
    const delivered = parseLaPosteBurkinaFasoItem(withRows([
      row('05/05/2026 08:00:00', 'Burkina Faso', 'SAMPLE TOWN', 'Receive item at delivery office (Inb)'),
      row('05/05/2026 10:31:07', 'Burkina Faso', 'SAMPLE TOWN', 'Deliver item (Inb)', 'Signatory : SAMPLE PERSON'),
    ].join('')), OUTBOUND);
    expect(delivered).toMatchObject({ status: 'delivered', delivered_at: '2026-05-05T10:31:07+00:00', last_update: '2026-05-05T10:31:07+00:00',
      destination_country: 'BF' });
    expect(delivered).not.toHaveProperty('last_update_local');
    const unknown = parseLaPosteBurkinaFasoItem(withRows([
      row('05/05/2026 08:00:00', 'Burkina Faso', 'SAMPLE TOWN', 'Receive item from customer (Otb)'),
      row('06/05/2026 09:00:00', 'Burkina Faso', 'SAMPLE TOWN', 'Sample counter scan (Otb)', 'Sample note : kept out'),
    ].join('')), OUTBOUND);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Sample counter scan (Otb)' });
    expect(unknown.events![0]).toEqual({ time: '2026-05-06T09:00:00+00:00', location: 'SAMPLE TOWN, Burkina Faso', description: 'Sample counter scan (Otb)' });
    expect(parseLaPosteBurkinaFasoItem(withRows(row('05/05/2026 09:00:00', 'Burkina Faso', 'SAMPLE TOWN', 'Item returned to sender')), OUTBOUND))
      .toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    // A country named alone, one in ISO's style, and one without a code.
    expect(parseLaPosteBurkinaFasoItem(withRows(row('05/05/2026 09:00:00', 'Burkina Faso', 'BURKINA FASO', 'Insert item into bag (Otb)')),
      OUTBOUND).events![0]).toMatchObject({ location: 'Burkina Faso' });
    expect(parseLaPosteBurkinaFasoItem(withRows(row('05/05/2026 09:00:00', 'Netherlands (the)', '-', 'Receive item at office of exchange (Inb)')),
      OUTBOUND)).toMatchObject({ destination_country: 'NL', events: [{ local_time: '2026-05-05T09:00:00', location: 'Netherlands' }] });
    expect(parseLaPosteBurkinaFasoItem(withRows(row('05/05/2026 09:00:00', 'Sample Land', '-', 'Receive item at office of exchange (Inb)')),
      OUTBOUND)).not.toHaveProperty('destination_country');
    expect(() => parseLaPosteBurkinaFasoItem(withRows(''), OUTBOUND)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the page\'s notice for a code it holds nothing for as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('no-information')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(laPosteBurkinaFasoItemUrl(UNKNOWN));
  });

  it('reads block pages as challenges and changed pages as schema failures, never as a missing item', async () => {
    const lookup = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: OUTBOUND });
    await expect(lookup(BLOCKED)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body><div class="g-recaptcha"></div></body></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(page('no-information').replace('No information', 'No data'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(page('no-information').replace('Item Events', 'Item Tracking'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the page to the whole requested code and rejects a changed history', () => {
    expect(() => parseLaPosteBurkinaFasoItem(page('outbound-delivered'), 'ZZ000000059BF'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'La Poste Burkina Faso answered for a different item' }));
    expect(() => parseLaPosteBurkinaFasoItem(page('outbound-delivered').replace(OUTBOUND, `${OUTBOUND}X`), OUTBOUND))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'La Poste Burkina Faso answered for a different item' }));
    const outbound = page('outbound-delivered');
    for (const changed of [
      outbound.replace('ITEM&nbsp;n&deg;', 'ITEM'),
      outbound.replace('<td class="tabmen" width="10%">Mail Category</td>', ''),
      outbound.replace('Local Date and Time', 'Date and Time'),
      outbound.replace('>Insert item into bag (Otb)<', '><'),
      outbound.replace('>03/03/2026 14:18:37<', '>2026-03-03 14:18<'),
      outbound.replace('>03/03/2026 14:18:37<', '>3/3/2026 2:18:37 PM<'),
      outbound.replace('>03/03/2026 14:18:37<', '>31/02/2026 14:18:37<'),
      outbound.replace('>03/03/2026 14:18:37<', '>03/13/2026 14:18:37<'),
      outbound.replace('>03/03/2026 14:18:37<', '>03/03/2026 24:18:37<'),
      outbound.replace('<td align="center" width="10%">A</td>', ''),
      outbound.replace(/<table id="200"[\s\S]*?<\/table>/, (table) => `${table}${table}`),
    ]) {
      expect(() => parseLaPosteBurkinaFasoItem(changed, OUTBOUND)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const oversized = withRows(Array.from({ length: 501 }, () => row('05/05/2026 09:00:00', 'Burkina Faso', 'SAMPLE TOWN', 'Insert item into bag (Otb)')).join(''));
    expect(() => parseLaPosteBurkinaFasoItem(oversized, OUTBOUND)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015BF', 'ZZ00000001BF', 'ZZ000000014BFX', '00000000001', 'SAMPLETRACKING', `ZZ${'0'.repeat(70)}BF`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLaPosteBurkinaFasoNumber(' zz-000 000 028 fr ')).toBe(INBOUND);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [301, 'transport'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('no-information'), status, { Location: LA_POSTE_BURKINA_FASO_ITEM }));
      await expect(carrier(fetcher).track({ number: OUTBOUND })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(OUTBOUND)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('outbound-delivered')));
    await expect(carrier(flaky).track({ number: OUTBOUND })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('outbound-delivered')));
    await expect(carrier(immediate).track({ number: OUTBOUND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: OUTBOUND }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: OUTBOUND }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(carrier(large).track({ number: OUTBOUND })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under La Poste Burkina Faso to the adapter and reads the tracker\'s addresses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('inbound')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: INBOUND, carrier: 'la-poste-burkina-faso' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'la-poste-burkina-faso', source: 'la-poste-burkina-faso', result: { current_stage: 'failed_attempt' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(LA_POSTE_BURKINA_FASO_ITEM))).toBe(true);
    for (const link of [laPosteBurkinaFasoItemUrl(OUTBOUND), `http://webtracking.sonapost.bf/webtracking/IPSWeb_item_events.aspx?itemid=${OUTBOUND}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: OUTBOUND, carrier: 'la-poste-burkina-faso', source: 'link' });
    }
  });
});

describe('La Poste Burkina Faso status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'la-poste-burkina-faso', description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(laPosteBurkinaFasoStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // A scan's details after its event name do not change its stage.
    expect(statusMap.stage(null, 'unsuccessful item delivery attempt (inb): unclaimed; item returned to sender')).toBe('failed_attempt');
    for (const wording of ['constructor', 'toString', 'Sample counter scan']) expect(statusMap.stage(null, wording), wording).toBeUndefined();
    expect(statusMap.stage('A', 'deliver item')).toBeUndefined();
  });
});
