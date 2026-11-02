import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FOUR_SEVENTY_TWO_TRACEABILITY, fourSeventyTwoLookupUrl, FourSeventyTwoTracker } from './adapter.js';
import { normalizeFourSeventyTwoNumber, parseFourSeventyTwo } from './parser.js';
import { DIGITIZED, fourSeventyTwoMappedStage, fourSeventyTwoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RN000000014CO';
const RETURNED = 'YG000000005CO';
const INBOUND = 'RR000000005SG';
const UNKNOWN = 'MN000000005CO';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// The shipment's card for another guía and service.
const card = (number = DELIVERED, service = 'CORREO CERTIFICADO NACIONAL 2026') => text('search').split(DELIVERED).join(number)
  .replace('CORREO CERTIFICADO NACIONAL 2026', service);
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const routes = (search: string, events: string) => vi.fn<typeof fetch>().mockImplementation(async (url) =>
  reply(String(url).includes('/Traceability/Search?') ? search : events));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const row = (clock: string, centre: string, wording: string, remark = '') => `<tr><td>${clock}</td><td>${centre}</td><td>${wording}</td><td>${remark}</td></tr>`;
const table = (...rows: string[]) => text('events-empty').replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${rows.join('')}</tbody>`);

describe('4-72 tracking adapter', () => {
  it('asks the tracking page’s two routes for the whole guía, through the supplied transport', async () => {
    const fetcher = routes(text('search'), text('events-delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FourSeventyTwoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rn 000 000 014 co ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `${FOUR_SEVENTY_TWO_TRACEABILITY}/Events?guia=${DELIVERED}`, `${FOUR_SEVENTY_TWO_TRACEABILITY}/Search?guia=${DELIVERED}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init).not.toHaveProperty('body');
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: '4-72', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered letter newest first on wall clocks, without the document’s way back or the receiver', () => {
    const result = parseFourSeventyTwo(text('search'), text('events-delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Digitalizado', last_update: null, last_update_local: '2026-03-04T22:38:54', expected_delivery: null,
      service_name: 'CORREO CERTIFICADO NACIONAL' });
    expect(result).not.toHaveProperty('delivered_at');
    // The visit listed twice is kept once; the scans after the delivery that carry the signed document back are left out.
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-04T22:38:54', 'CD.SAMPLE', 'Digitalizado', undefined],
      ['2026-03-04T12:05:33', 'CD.SAMPLE', 'Entregado', 'delivered'],
      ['2026-03-04T07:50:50', 'CD.SAMPLE', 'Reasignado', 'in_transit'],
      ['2026-03-03T11:40:10', 'CD.SAMPLE', 'Envío no entregado', 'failed_attempt'],
      ['2026-03-03T05:27:00', 'CD.SAMPLE', 'En proceso', 'in_transit'],
      ['2026-03-03T04:07:04', 'CTP.CENTRO A', 'En proceso', 'in_transit'],
      ['2026-03-02T09:15:42', 'CTP.CENTRO A', 'Admitido', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
    // Nothing of the sender, recipient, receiver, postage or service order is read.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:SENDER|RECIPIENT|RECEIVER|STREET|AVENUE|TOWN)|0000000000|00000000|200,00/);
  });

  it('reads an item sent back to its sender, and mail from abroad kept for an unpaid duty', async () => {
    const returned = await carrier(routes(card(RETURNED, 'POSTEXPRESS'), text('events-returned'))).track({ number: RETURNED });
    expect(returned).toMatchObject({ current_stage: 'returned', last_status_text: 'Digitalizado', last_update_local: '2026-03-16T16:55:00',
      service_name: 'POSTEXPRESS' });
    expect(returned.events!.map(event => [event.description, event.stage])).toEqual([
      ['Digitalizado', undefined],
      ['devolución entregada a remitente', 'returned'],
      ['TRANSITO(DEV)', 'returned'],
      ['No reside - dev a remitente', 'returned'],
      ['En proceso', 'in_transit'],
      ['En proceso', 'in_transit'],
      ['Admitido', 'accepted'],
    ]);
    const inbound = parseFourSeventyTwo(card(INBOUND, 'CORREO CERTIFICADO INTERNACIONAL ENTRANTE'), text('events-inbound'), INBOUND);
    expect(inbound).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_update_local: '2026-04-30T15:24:22',
      last_status_text: 'Registro de entrega no exitosa: Otros: Pendiente pago de impuesto aduanero',
      service_name: 'CORREO CERTIFICADO INTERNACIONAL ENTRANTE' });
    // Same-clock scans keep the reply's order, the later one first.
    expect(inbound.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-04-30T15:24:22', 'COBOGC', 'Registro de entrega no exitosa: Otros: Pendiente pago de impuesto aduanero', 'failed_attempt'],
      ['2026-04-30T15:24:22', 'PO.SAMPLE', 'Envío no entregado', 'failed_attempt'],
      ['2026-04-30T14:49:17', 'PO.SAMPLE', 'En proceso', 'in_transit'],
      ['2026-04-28T13:30:12', 'COBOGC', 'En proceso', 'in_transit'],
      ['2026-04-17T10:08:43', 'COBOGC', 'Salida de aduana y transferencia entre oficinas', 'in_transit'],
      ['2026-04-17T10:08:43', 'COBOGC', 'Envío recibido de aduanas', 'in_transit'],
      ['2026-04-17T10:08:26', 'COBOGC', 'Envío Recibido en la oficina de cambio internacional', 'in_transit'],
    ]);
  });

  it('reads clocks, remarks, returns and unknown events the way the tracker writes them', () => {
    const parse = (...rows: string[]) => parseFourSeventyTwo(text('search'), table(...rows), DELIVERED);
    // Twelve o'clock on twelve hours, a day before a month, and the scans sorted by clock rather than by row.
    expect(parse(row('1/02/2026 12:00:00 a. m.', 'PO.SAMPLE', 'Admitido'), row('31/01/2026 12:30:00 p. m.', 'PO.SAMPLE', 'En proceso'))
      .events!.map(event => event.local_time)).toEqual(['2026-02-01T00:00:00', '2026-01-31T12:30:00']);
    // A return before a delivery is the item's; the delivery then stands. Another reason with a return order is a return.
    const back = parse(row('2/02/2026 08:00:00', 'PO.SAMPLE', 'En proceso de devoluci&#243;n a remitente'), row('3/02/2026 08:00:00', 'PO.SAMPLE', 'ENTREGADO'),
      row('4/02/2026 08:00:00', 'PO.SAMPLE', 'En proceso de devoluci&#243;n a remitente'));
    expect(back.events!.map(event => [event.description, event.stage])).toEqual([['ENTREGADO', 'delivered'], ['En proceso de devolución a remitente', 'returned']]);
    expect(parse(row('2/02/2026 08:00:00', 'PO.SAMPLE', 'Rehusado - dev. a remitente'))).toMatchObject({ current_stage: 'returned' });
    // A visit's own "Otros" reason did not deliver; a remark loses digit runs that could be a phone or ID number.
    const other = parse(row('2/02/2026 08:00:00', 'PO.SAMPLE', 'Otros: cerrado 1ra vez-cargar siguiente turno', 'Llamar al 000 000 0000'));
    expect(other.events![0]).toMatchObject({ description: 'Otros: cerrado 1ra vez-cargar siguiente turno: Llamar al', stage: 'failed_attempt' });
    // An event the map does not know falls to the shared wording rules, else keeps no stage.
    const unknown = parse(row('2/02/2026 08:00:00', 'PO.SAMPLE', 'Admitido'), row('3/02/2026 08:00:00', 'PO.SAMPLE', 'Evento de ejemplo'));
    expect(unknown).toMatchObject({ current_stage: 'accepted', last_status_text: 'Evento de ejemplo' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-02-03T08:00:00', location: 'PO.SAMPLE', description: 'Evento de ejemplo' });
    expect(parse(row('2/02/2026 08:00:00', '', 'Digitalizado'))).toEqual(expect.objectContaining({ status: 'unknown', events: [
      { local_time: '2026-02-02T08:00:00', description: 'Digitalizado' }] }));
    expect(parse(row('2/02/2026 08:00:00', 'PO.SAMPLE', 'En proceso'))).not.toHaveProperty('current_stage_source', 'none');
    // A service without a tariff year keeps its name; a card without one names none.
    expect(parseFourSeventyTwo(card(DELIVERED, 'NOTIEXPRESS'), text('events-delivered'), DELIVERED)).toMatchObject({ service_name: 'NOTIEXPRESS' });
    expect(parseFourSeventyTwo(card(DELIVERED, ''), text('events-delivered'), DELIVERED)).not.toHaveProperty('service_name');
  });

  it('reads an empty search with no scans as missing, and a card without scans as no history', async () => {
    expect(() => parseFourSeventyTwo('', text('events-empty'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFourSeventyTwo(' \r\n', text('events-empty'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Scans for a guía the search did not find, or a card without scans, prove nothing either way.
    expect(() => parseFourSeventyTwo('', text('events-delivered'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFourSeventyTwo(text('search'), text('events-empty'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lookup = (search: string, events: string, number = UNKNOWN) => carrier(routes(search, events)).track({ number });
    await expect(lookup('', text('events-empty'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(CHECK, text('events-empty'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', text('events-empty'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', '<h3>Error: [object Object]</h3>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('search')}`, text('events-delivered'), DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('rejects changed replies and answers for another guía', () => {
    const changed: Array<[string, string]> = [
      [card(UNKNOWN), text('events-delivered')],
      [card('RN000000014C'), text('events-delivered')],
      [text('search').replace(/<h3>Número de Guía[^<]*<\/h3>/, '<h3>Sample heading</h3>'), text('events-delivered')],
      [text('search'), text('events-delivered').replace('<th scope="col">Evento</th>', '<th scope="col">Estado</th>')],
      [text('search'), table('<tr><td>2/02/2026 08:00:00</td><td>PO.SAMPLE</td><td>Admitido</td></tr>')],
      [text('search'), table(row('2/02/2026 08:00:00', 'PO.SAMPLE', ' '))],
      [text('search'), table(...Array.from({ length: 501 }, () => row('2/02/2026 08:00:00', 'PO.SAMPLE', 'En proceso')))],
      ...['2026-02-02T08:00:00', '2/02/2026 08:00', '30/02/2026 08:00:00', '2/13/2026 08:00:00', '2/02/2026 24:00:00', '2/02/2026 13:00:00 p. m.',
        '2/02/2026 0:00:00 a. m.', '2/02/2026 08:60:00', '1/01/1999 08:00:00', ''].map((clock): [string, string] =>
        [text('search'), table(row(clock, 'PO.SAMPLE', 'Admitido'))]),
    ];
    for (const [search, events] of changed) {
      expect(() => parseFourSeventyTwo(search, events, DELIVERED), `${search.slice(0, 80)} ${events.slice(-160)}`)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'RN000000004CO', 'RN00000005CO', 'RN000000005COX', 'R0000000005CO', '0000000000000', 'SAMPLETRACKING',
      `RN${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFourSeventyTwoNumber(' rr-000-000-005 sg ')).toBe(INBOUND);
    expect(fourSeventyTwoLookupUrl('Search', INBOUND)).toBe(`${FOUR_SEVENTY_TWO_TRACEABILITY}/Search?guia=${INBOUND}`);
    expect(() => parseFourSeventyTwo('', text('events-empty'), 'MN000000004CO')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // Recognition sends nothing for a code the tracker does not take.
    await expect(carrier(fetcher).recognize!('SAMPLETRACKING', {})).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a guía the tracker holds, and not one its search does not find, with the same requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith(UNKNOWN)
      ? reply(String(url).includes('/Search?') ? '' : text('events-empty'))
      : reply(String(url).includes('/Search?') ? text('search') : text('events-delivered')));
    await expect(carrier(fetcher).recognize!(DELIVERED, { budgetMs: 3000 })).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN, { budgetMs: 3000 })).resolves.toEqual({ known: false });
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      fourSeventyTwoLookupUrl('Events', DELIVERED), fourSeventyTwoLookupUrl('Events', UNKNOWN),
      fourSeventyTwoLookupUrl('Search', DELIVERED), fourSeventyTwoLookupUrl('Search', UNKNOWN)].sort());
  });

  it('keeps the tracker’s rate limit with its retry window and cancels the other route', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => String(url).includes('/Search?')
      ? new Response('Too many requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } })
      : new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it.each([[400, 'transport'], [401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'],
    [405, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('/Events?')
        ? reply(text('events-delivered')) : reply(text('search'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/Search?'))).toHaveLength(1);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failed = false;
    const flaky = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (!failed) {
        failed = true;
        throw new TypeError('fetch failed');
      }
      return reply(String(url).includes('/Search?') ? text('search') : text('events-delivered'));
    });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.length).toBeLessThanOrEqual(4);
    const immediate = routes(text('search'), text('events-delivered'));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    // The first try's timeout and the budget's end come close together; either is a correct answer.
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(4);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under 4-72 to the adapter', async () => {
    const fetcher = routes(text('search'), text('events-delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: '4-72' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: '4-72', source: '4-72', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => [fourSeventyTwoLookupUrl('Search', DELIVERED), fourSeventyTwoLookupUrl('Events', DELIVERED)]
      .includes(String(url)))).toBe(true);
  });
});

describe('4-72 status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and leaves the document scan out on purpose', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(fourSeventyTwoMappedStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(stage);
      expect(statusMapAnswer({ carrier: '4-72', description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: statusMap.gaps[0]!.note });
    }
    expect(statusMapAnswer({ carrier: '4-72', description: 'Registro de entrega no exitosa: Otros: Sample' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMap.stage('SAMPLE', 'entregado')).toBeUndefined();
    expect(statusMap.gaps).toEqual([expect.objectContaining({ wording: DIGITIZED })]);
    expect(fourSeventyTwoStage('Entregado')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const wording of ['constructor', 'toString', 'Digitalizado', '']) expect(fourSeventyTwoMappedStage(wording), wording).toBeUndefined();
    expect(fourSeventyTwoStage('')).toBeNull();
  });
});
