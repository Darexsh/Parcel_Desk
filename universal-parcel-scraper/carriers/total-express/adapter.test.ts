import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TOTAL_EXPRESS_API, TotalExpressTracker } from './adapter.js';
import { normalizeTotalExpressNumber, parseTotalExpress, parseTotalExpressSearch, totalExpressWording } from './parser.js';
import { statusMap, totalExpressStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'TXAQ000000001TX';
const IN_TRANSIT = 'TXAS000000002TX';
const REDISPATCHED = 'AMZB000000003TX';
const UNKNOWN = 'TXAQ000000000TX';
const DETAIL = `${TOTAL_EXPRESS_API}/order-data?awb=`;

type Row = Record<string, unknown>;
type Milestone = Row & { listaStatus: Row[] };
type Shipment = Row & { cliente: Row };
type Reply = { data: { encomenda: Shipment; layouts: (Row & { etapas: Milestone[] })[] } };

const file = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(file(`${name}.json`)) as Reply;
const changed = (name: string, change: (shipment: Shipment, milestones: Milestone[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.encomenda, reply.data.layouts[0]!.etapas, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const SERVER_ERROR = () => reply({ message: 'Internal server error' }, { status: 500 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Total Express HTTP adapter', () => {
  it('reads a known AWB with one request to the tracking page’s API, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TotalExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' txaq 000000001-tx ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DETAIL}${DELIVERED}&language=pt`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'total-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and its status id, newest first across the milestones', () => {
    const result = parseTotalExpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGA REALIZADA', last_update: null, last_update_local: '2026-03-05T10:31:13', expected_delivery: null,
      sender_name: 'SAMPLE STORE STD' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2026-03-05T10:31:13', '1', 'delivered', 'ENTREGA REALIZADA'],
      // The repeated scan is kept once.
      ['2026-03-05T07:32:46', '104', 'out_for_delivery', 'PROCESSO DE ENTREGA'],
      // At the same second, the later milestone's scan comes first.
      ['2026-03-05T06:33:09', '105', 'in_transit', 'EM ROTA'],
      ['2026-03-05T06:33:09', '103', 'in_transit', 'RECEBIDO CD DE: XBB'],
      ['2026-03-05T05:20:00', '108', 'in_transit', 'DESCARREGADO'],
      ['2026-03-05T05:15:08', '79', 'in_transit', 'EMBARQUE RECEBIDO NO CD: XBB'],
      ['2026-03-05T04:37:56', '102', 'in_transit', 'TRANSFERENCIA PARA: XBB'],
      ['2026-03-05T03:54:07', '78', 'in_transit', 'EMBARCADO PARA: XBB'],
      ['2026-03-04T21:48:51', '132', 'in_transit', 'TRANSBORDO EM: XCC'],
      ['2026-03-04T20:50:14', '129', 'in_transit', 'Embarque em transbordo - XCC'],
      ['2026-03-03T15:22:30', '103', 'in_transit', 'RECEBIDO CD DE: HUB/MATRIZ'],
      ['2026-03-03T12:15:47', '102', 'in_transit', 'TRANSFERENCIA PARA'],
      ['2026-03-02T18:03:23', '101', 'in_transit', 'RECEBIDA E PROCESSADA NO CD - XAA'],
      // Waiting to be measured moves nothing.
      ['2026-03-02T18:03:23', '98', null, 'AGUARDANDO CUBAGEM'],
      ['2026-03-02T18:03:22', '69', 'in_transit', 'COLETA RECEBIDA COM NC NO CD DE'],
      ['2026-03-02T18:03:22', '84', 'accepted', 'COLETA REALIZADA C/ NÃO CONFORMIDADE'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('pickup_point');
    // The order and invoice numbers, the friendly messages and the milestone names are not kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-ORDER|1\*{4}|Boa notícia|Em posse da transportadora|0000-4000/);
  });

  it('keeps the estimate of a parcel on its way', () => {
    const result = parseTotalExpress(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'EM ROTA',
      last_update_local: '2026-04-15T02:55:35', expected_delivery: '2026-04-17', sender_name: 'SAMPLE OUTLET' });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['105', '103', '79', '131', '130', '78', '101', '68', '83']);
  });

  it('names Correios and its number for a parcel Total Express handed over', () => {
    const result = parseTotalExpress(fixture('redispatched'), REDISPATCHED);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Transferência para ECT',
      delivery_carrier: 'correios-br', delivery_tracking_number: 'AD000000005BR', expected_delivery: '2026-05-22' });
    expect(result.events![1]).toMatchObject({ provider_code: '38', description: 'REDESPACHADO CORREIO - AD000000005BR' });
    // A number whose check digit fails is no hand-off.
    const broken = parseTotalExpress(changed('redispatched', (shipment) => { shipment.redespachoNumero = 'AD000000006BR'; }), REDISPATCHED);
    expect(broken).not.toHaveProperty('delivery_carrier');
    expect(broken).not.toHaveProperty('delivery_tracking_number');
  });

  it('names the pickup point a parcel waits at', () => {
    const result = parseTotalExpress(changed('in-transit', (shipment, milestones) => {
      shipment.pudo = { pickUp: { nome: 'Sample Shop', endereco: 'Rua Exemplo', enderecoNumero: 100, complemento: '', bairro: 'Centro', cidade: 'Sample City' } };
      milestones[2]!.listaStatus.unshift({ ...milestones[2]!.listaStatus[0]!, statid: 144,
        statusDescricao: 'DISPONÍVEL PARA RETIRADA REDE PUDO', data: '2026-04-16', hora: '09:00:00' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'Sample Shop\nRua Exemplo, 100\nCentro\nSample City' });
  });

  it('reads milestones listed oldest first newest first', () => {
    const result = parseTotalExpress(changed('delivered', (_shipment, milestones) => {
      for (const milestone of milestones) milestone.listaStatus.reverse();
      milestones.reverse();
    }), DELIVERED);
    expect(result).toMatchObject({ last_update_local: '2026-03-05T10:31:13', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '84' });
  });

  it('stages a scan by its status id, else by its wording', () => {
    const latest = (statid: number, statusDescricao: string) => parseTotalExpress(changed('in-transit', (_shipment, milestones) => {
      milestones[2]!.listaStatus.unshift({ ...milestones[2]!.listaStatus[0]!, statid, statusDescricao, hora: '09:00:00' });
    }), IN_TRANSIT);
    expect(latest(21, 'CLIENTE AUSENTE/ ESTABELECIMENTO FECHADO')).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(latest(71, 'DEVOLUÇÃO EM ANDAMENTO PARA O REMETENTE')).toMatchObject({ current_stage: 'returned', expected_delivery: null });
    expect(latest(142, 'EXTRAVIO')).toMatchObject({ status: 'exception', current_stage: 'exception' });
    // Bookkeeping moves nothing: the newest scan with a stage decides.
    expect(latest(157, 'ARMAZENADO NO ENDEREÇO: A-01')).toMatchObject({ last_status_text: 'ARMAZENADO NO ENDEREÇO: A-01', current_stage: 'in_transit' });
  });

  it('tidies the separators around a base’s code', () => {
    expect(totalExpressWording('RECEBIDO CD DE: -  SGE')).toBe('RECEBIDO CD DE: SGE');
    expect(totalExpressWording('RECEBIDO CD DE: - : HUB/MATRIZ')).toBe('RECEBIDO CD DE: HUB/MATRIZ');
    expect(totalExpressWording('RECEBIDO CD DE: - - SGE')).toBe('RECEBIDO CD DE: SGE');
    expect(totalExpressWording('EMBARQUE RECEBIDO NO CD:  - ')).toBe('EMBARQUE RECEBIDO NO CD');
    expect(totalExpressWording('Embarque em ponto de passagem - VDQ')).toBe('Embarque em ponto de passagem - VDQ');
  });

  it('counts a shipment only when it names the AWB asked', () => {
    expect(() => parseTotalExpress(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Total Express answered for another shipment' }));
    expect(parseTotalExpress(changed('in-transit', (shipment) => { shipment.awb = IN_TRANSIT; }), IN_TRANSIT).events).toHaveLength(9);
    expect(() => parseTotalExpressSearch(JSON.parse(file('search-found.json')), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTotalExpressSearch(JSON.parse(file('search-empty.json')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTotalExpressSearch(JSON.parse(file('search-found.json')), DELIVERED)).not.toThrow();
  });

  it('reads a shipment without scans as no history and rejects a changed reply', () => {
    expect(() => parseTotalExpress(changed('in-transit', (_shipment, milestones) => {
      for (const milestone of milestones) milestone.listaStatus = [];
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const change of [
      (_shipment: Shipment, _milestones: Milestone[], body: Reply) => { delete (body as Partial<Reply>).data; },
      (_shipment: Shipment, _milestones: Milestone[], body: Reply) => { (body.data as Row).encomenda = null; },
      (shipment: Shipment) => { delete shipment.awb; },
      (_shipment: Shipment, _milestones: Milestone[], body: Reply) => { (body.data as Row).layouts = 'layouts'; },
      (_shipment: Shipment, milestones: Milestone[]) => { (milestones[0] as Row).listaStatus = null; },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus[0] = 'scan' as never; },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus = Array.from({ length: 501 }, () => milestones[0]!.listaStatus[0]!); },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus[0]!.data = '13/04/2026'; },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus[0]!.hora = '10:43'; },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus[0]!.hora = '24:00:00'; },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus[0]!.data = '2026-02-30'; },
      (_shipment: Shipment, milestones: Milestone[]) => { delete milestones[0]!.listaStatus[0]!.statid; },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus[0]!.statusDescricao = ['COLETA']; },
      (_shipment: Shipment, milestones: Milestone[]) => { milestones[0]!.listaStatus[0]!.statusDescricao = ' '; },
      (shipment: Shipment) => { shipment.redespachoNumero = 5; },
      (shipment: Shipment) => { shipment.pudo = 'pickup'; },
    ]) {
      expect(() => parseTotalExpress(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [{}, { data: null }, { data: ['row'] }]) {
      expect(() => parseTotalExpressSearch(payload, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks the search after a failed read, and takes only its empty answer as not found', async () => {
    const lookup = (search: Response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(SERVER_ERROR()).mockResolvedValueOnce(search);
      return { fetcher, answer: carrier(fetcher).track({ number: UNKNOWN }) };
    };
    const missing = lookup(reply(JSON.parse(file('search-empty.json'))));
    await expect(missing.answer).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing.fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${DETAIL}${UNKNOWN}&language=pt`,
      `${TOTAL_EXPRESS_API}/basic?code=${UNKNOWN}&limit=10&page=1`]);
    // The search knows the AWB the read failed on.
    const known = { ...JSON.parse(file('search-found.json')), data: [{ ...JSON.parse(file('search-found.json')).data[0], awb: 'txaq000000000tx' }] };
    await expect(lookup(reply(known)).answer).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    await expect(lookup(reply(JSON.parse(file('search-found.json')))).answer).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(SERVER_ERROR()).answer).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(html(file('access-denied.html'), 403)).answer).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps a block page, the site’s too-many-requests page, a moved route and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: IN_TRANSIT });
    await expect(lookup(html(file('access-denied.html'), 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html(file('access-denied.html')))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html(file('too-many.html'), 403))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The edge's answer to a client it does not take for a browser.
    await expect(lookup(reply({ status: 400, error: 'Bad Request', message: 'The \'User-Agent\' header is required.' }, { status: 400 })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply({ message: 'Bad Request' }, { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    // The tracker reads a missing parcel from its search: a 404 or a redirect is a moved route.
    await expect(lookup(reply({ message: 'Not Found' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 302, headers: { Location: 'https://totalconecta.totalexpress.com.br/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(html('<html><title>Total Express</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[401, 'challenge'], [429, 'rate_limited'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known AWB and the search’s unknown answer, and asks nothing for a number Total Express does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(SERVER_ERROR()).mockResolvedValueOnce(reply(JSON.parse(file('search-empty.json'))));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T10:31:13' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Total Express does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000000', 'TXAQ000000001', 'TXAQ00000001TX', 'TX000000001TX', `TXAQ${'0'.repeat(60)}TX`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTotalExpressNumber('amzb 000.000.003 tx')).toBe(REDISPATCHED);
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
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes an AWB filed under Total Express, or detected as one, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith(DETAIL)
      ? reply(fixture('delivered')) : new Response('', { status: 404 }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'total-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'total-express', source: 'total-express', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: 'txaq000000001tx' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'total-express', source: 'total-express' });
  });
});

describe('Total Express numbers', () => {
  it('claims its AWBs, with or without the TX in capitals', () => {
    for (const number of [DELIVERED, IN_TRANSIT, REDISPATCHED, 'txaq000000004tx']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'total-express', confidence: 'high' });
    }
    for (const number of ['TXAQ000000001', 'TXAQ0000000001TX', 'ABCD000000001TX', '0000000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('total-express');
    }
  });

  it('reads the AWB from the tracking page’s addresses', () => {
    for (const link of [
      `https://totalconecta.totalexpress.com.br/rastreamento/rastreamento/encomendas/${DELIVERED.toLowerCase()}`,
      `https://totalconecta.totalexpress.com.br/rastreamento?codigo=${DELIVERED}&op=BUSCAR`,
    ]) {
      const match = parseTrackingInput(link);
      expect(match, link).toMatchObject({ carrier: 'total-express', source: 'link' });
      expect(match.trackingNumber?.toUpperCase(), link).toBe(DELIVERED);
    }
    // The search field also takes order and invoice numbers, which name no carrier.
    expect(parseTrackingInput('https://totalconecta.totalexpress.com.br/rastreamento?codigo=12345678').carrier).not.toBe('total-express');
  });
});

describe('Total Express status vocabulary', () => {
  it('records every status id and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(totalExpressStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'total-express', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(totalExpressStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'total-express', providerCode: '104', description: 'PROCESSO DE ENTREGA' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'total-express', providerCode: '9999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(totalExpressStage('9999', 'Synthetic note')).toBeNull();
  });
});
