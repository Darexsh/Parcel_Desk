import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SPX_BR_API, SpxBrTracker } from './adapter.js';
import { normalizeSpxBrNumber, parseSpxBr, spxBrPlacedText, spxBrWording } from './parser.js';
import { spxBrStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BR2600000000011';
const IN_TRANSIT = 'BR260000000002X';
const UNKNOWN = 'BR2600000000003';

type Row = Record<string, unknown>;
type Tracking = Row & { records: Row[] };
type Reply = Row & { data: Row & { sls_tracking_info: Tracking } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (tracking: Tracking, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.sls_tracking_info, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SPX Express Brazil HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number once, in the page’s language, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SpxBrTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' br 2600-0000-0002x ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SPX_BR_API}?spx_tn=${IN_TRANSIT}&language_code=pt`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'spx-br', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the scans of a delivery once, as instants, without the recipient or the seller’s town', () => {
    const result = parseSpxBr(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Pedido entregue', last_update: '2026-05-19T12:53:20Z', delivered_at: '2026-05-19T12:53:20Z' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-05-19T12:53:20Z', 'F980', 'delivered', null],
      ['2026-05-19T08:26:40Z', 'F600', 'out_for_delivery', null],
      // The page hides the arrival at the last-mile hub.
      ['2026-05-19T03:43:20Z', 'F599', 'in_transit', 'Porto Modelo - RJ'],
      // A departure names its centre only in its wording.
      ['2026-05-18T16:46:40Z', 'F540', 'in_transit', 'Vila Amostra - SP'],
      ['2026-05-17T19:33:20Z', 'F515', 'in_transit', 'Vila Amostra - SP'],
      // The repeated sorting scan is kept once.
      ['2026-05-17T16:46:40Z', 'F510', 'in_transit', 'Vila Amostra - SP'],
      ['2026-05-17T14:00:00Z', 'F450', 'in_transit', 'Cidade Exemplo - SP'],
      ['2026-05-17T03:26:40Z', 'F440', 'in_transit', 'Cidade Exemplo - SP'],
      // The pickup names the seller's town, which is not kept.
      ['2026-05-17T01:06:40Z', 'F100', 'accepted', null],
      // A pickup that collected nothing, which the page hides; its bookkeeping stays out.
      ['2026-05-16T22:20:00Z', 'F001', 'registered', null],
      ['2026-05-16T14:00:00Z', 'F000', 'registered', null],
    ]);
    expect(result.events![7]).toMatchObject({ point: { latitude: -23.5, longitude: -46.6 },
      description: 'Seu pedido chegou ao centro logístico' });
    expect(result.events![3]).not.toHaveProperty('point');
    expect(result.events!.every((event) => !('local_time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Pessoa Exemplo|Recebido|Vendedor|Rua |Avenida|R101|1000000000000000001/);
  });

  it('files a parcel from abroad under customs, newest scan first by its clock', () => {
    const result = parseSpxBr(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Pedido em inspeção na alfândega de importação', last_update: '2026-05-24T14:13:20Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['F380', 'customs', null],
      ['F366', 'customs', null],
      ['F360', 'in_transit', 'Aeroporto Internacional Exemplo'],
      // The customs check the reply lists after this later departure.
      ['F355', 'in_transit', 'Aeroporto de Trânsito'],
      ['F380', 'customs', null],
      ['F350', 'in_transit', 'Aeroporto de Trânsito'],
      ['F341', 'in_transit', 'Aeroporto Amostra'],
      ['F339', 'in_transit', 'Aeroporto Amostra'],
      ['F300', 'in_transit', 'Aeroporto Amostra'],
      ['F299', 'in_transit', 'Origem'],
      ['F200', 'in_transit', 'Origem'],
      ['F099', 'accepted', null],
      ['F000', 'registered', null],
    ]);
    expect(result.events![4]!.description).toBe('Pedido em inspeção na alfândega de importação: RFB - Descrição insuficiente/incompleta');
    // A scan without a Portuguese line keeps its English tracking name.
    expect(result.events![11]!.description).toBe('Pickup From Cross Border Seller');
    expect(result.events!.some((event) => event.point)).toBe(false);
  });

  it('reads a return, a refused import and a code it does not know', () => {
    const returned = parseSpxBr(changed('delivered', (tracking) => {
      Object.assign(tracking.records[0]!, { tracking_code: 'F999', tracking_name: 'Returned to Sender', description: 'Pedido devolvido' });
    }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Pedido devolvido' });
    expect(returned).not.toHaveProperty('delivered_at');
    const refused = parseSpxBr(changed('in-transit', (tracking) => {
      tracking.records.unshift({ ...tracking.records[0]!, tracking_code: 'F979', actual_time: 1_780_000_000,
        description: 'O pacote não pôde ser importado, será retornado ou confiscado pela alfândega ' });
    }), IN_TRANSIT);
    expect(refused).toMatchObject({ status: 'exception', current_stage: 'exception' });
    const unmapped = parseSpxBr(changed('in-transit', (tracking) => {
      tracking.records.unshift({ ...tracking.records[0]!, tracking_code: 'F777', actual_time: 1_780_000_000, description: 'Aviso sintético' });
    }), IN_TRANSIT);
    // A scan nothing stages leaves the stage to the newest scan that has one.
    expect(unmapped.events![0]).not.toHaveProperty('stage');
    expect(unmapped).toMatchObject({ last_status_text: 'Aviso sintético', current_stage: 'customs' });
  });

  it('reads the way back of a return the page hides, before the return it shows', () => {
    const hidden = (code: string, time: number, description: string) =>
      ({ tracking_code: code, tracking_name: 'Hidden', description, actual_time: time, display_flag: 0 });
    const result = parseSpxBr(changed('delivered', (tracking) => {
      tracking.records = tracking.records.slice(3);
      tracking.records.unshift(hidden('F677', 1_779_160_000, 'Pedido de devolução está a caminho .'),
        hidden('F674', 1_779_150_000, 'Parcel has been loaded to truck, to leave   soon'),
        hidden('F671', 1_779_140_000, 'Pedido de devolução chegou no centro logístico: Cidade Exemplo - SP'),
        hidden('F370', 1_779_130_000, 'Pedido está sendo processado pela alfândega de importação'));
    }), DELIVERED);
    expect(result.events!.slice(0, 4).map((event) => [event.provider_code, event.stage, event.description, event.location ?? null])).toEqual([
      ['F677', 'returned', 'Pedido de devolução está a caminho.', null],
      ['F671', 'returned', 'Pedido de devolução chegou no centro logístico', 'Cidade Exemplo - SP'],
      ['F370', 'customs', 'Pedido está sendo processado pela alfândega de importação', null],
      ['F540', 'in_transit', 'Seu pedido saiu do centro logístico', 'Vila Amostra - SP'],
    ]);
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Pedido de devolução está a caminho.' });
  });

  it('reads the centre, origin or port a wording names as its place, and keeps a row stored with it in the wording', () => {
    expect(parseSpxBr(fixture('delivered'), DELIVERED).events!.slice(2, 8).map((event) => [event.description, event.location])).toEqual([
      ['Seu pedido chegou ao último centro logístico', 'Porto Modelo - RJ'],
      ['Seu pedido saiu do centro logístico', 'Vila Amostra - SP'],
      ['O pedido está em separação no centro logístico, novas atualizações em até 1 dia.', 'Vila Amostra - SP'],
      ['O pedido chegou ao centro e segue para a próxima etapa.', 'Vila Amostra - SP'],
      ['Seu pedido saiu do centro logístico', 'Cidade Exemplo - SP'],
      ['Seu pedido chegou ao centro logístico', 'Cidade Exemplo - SP'],
    ]);
    // The reply's place stands over the town the wording names.
    expect(parseSpxBr(fixture('in-transit'), IN_TRANSIT).events!.filter((event) => /^F3(?:41|50|55)$/.test(event.provider_code!))
      .map((event) => [event.description, event.location])).toEqual([
      ['Pedido saiu do porto de trânsito', 'Aeroporto de Trânsito'],
      ['Pedido chegou no porto de trânsito', 'Aeroporto de Trânsito'],
      ['Pedido saiu da origem', 'Aeroporto Amostra'],
    ]);
    // A reason after a colon, or a scan away from SPX's facilities, keeps its wording.
    expect(spxBrPlacedText('Pedido em inspeção na alfândega de importação: RFB - Motivo')).toEqual({
      description: 'Pedido em inspeção na alfândega de importação: RFB - Motivo', location: '' });
    expect(parseSpxBr(changed('delivered', (tracking) => {
      Object.assign(tracking.records[0]!, { description: 'Pedido entregue no centro logístico: Cidade Exemplo - SP' });
    }), DELIVERED).events![0]).toMatchObject({ description: 'Pedido entregue no centro logístico: Cidade Exemplo - SP' });

    const policy = sameInstantIdentityPolicy('spx-br', { supportsScanMatching: true });
    const incoming = { stage: 'in_transit', description: 'Seu pedido saiu do centro logístico', location: 'Cidade Exemplo - SP', providerCode: 'F540' };
    const stored = { ...incoming, description: 'Seu pedido saiu do centro logístico: Cidade Exemplo - SP' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, location: '' })).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: 'Seu pedido saiu do centro logístico: Vila Amostra - SP', location: '' },
      { ...stored, location: 'Vila Amostra - SP' },
      { ...stored, providerCode: 'F450' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    const arrival = { ...incoming, description: 'O pedido chegou ao centro e segue para a próxima etapa.', providerCode: 'F510' };
    expect(policy?.matches?.(arrival, { ...arrival, description: 'O pedido chegou ao centro de : Cidade Exemplo - SP e segue para a próxima etapa.' })).toBe(true);

    // A posting names the town of its drop-off point, the seller's town: it leaves the wording and is no place.
    const posted = parseSpxBr(changed('delivered', (tracking) => {
      Object.assign(tracking.records.find((record) => record.tracking_code === 'F000')!, { tracking_code: 'F098', description: 'Pedido postado Cidade Exemplo - SP' });
    }), DELIVERED).events!.find((event) => event.provider_code === 'F098')!;
    expect(posted).toMatchObject({ description: 'Pedido postado', stage: 'accepted', stage_source: 'carrier_map' });
    expect(posted.location).toBeUndefined();
    const posting = { stage: 'accepted', description: 'Pedido postado', location: '', providerCode: 'F098' };
    expect(policy?.matches?.(posting, { ...posting, description: 'Pedido postado Cidade Exemplo - SP' })).toBe(true);
    expect(policy?.matches?.(posting, { ...posting, description: 'Pedido postado Cidade Exemplo - SP', providerCode: 'F100' })).toBe(false);
  });

  it('takes whoever received the parcel out of the wording', () => {
    expect(spxBrWording('Pedido entregue. Recebido por: Pessoa Exemplo')).toBe('Pedido entregue');
    expect(spxBrWording('[LM Hub_SP_Exemplo] Seu pacote foi entregue a [Pessoa Exemplo] ')).toBe('[LM Hub_SP_Exemplo] Seu pacote foi entregue');
    expect(spxBrWording('Pacote [TO0000] está sendo transportado para [SoC_SP_Exemplo]'))
      .toBe('Pacote [TO0000] está sendo transportado para [SoC_SP_Exemplo]');
    expect(spxBrWording('Seu pacote foi recebido pelo centro de triagem')).toBe('Seu pacote foi recebido pelo centro de triagem');
  });

  it('reads an unknown number as not found, any other failure as inconclusive and a record without scans as no history', () => {
    expect(() => parseSpxBr(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Several parcels under one number, or a failure of its own, do not say the parcel is missing.
    const several = { ...fixture('not-found'), message: String(fixture('not-found').message).replace('find [0]', 'find [2]') };
    expect(() => parseSpxBr(several, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpxBr({ retcode: 2001, message: 'param is invalid' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSpxBr({ retcode: 0, data: { fulfillment_info: {} } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSpxBr(changed('delivered', (tracking) => { tracking.records = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSpxBr(changed('delivered', (tracking) => {
      tracking.records = tracking.records.filter((row) => !['F001', 'F599'].includes(String(row.tracking_code)));
      for (const row of tracking.records) row.display_flag = 0;
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseSpxBr(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SPX Express Brazil answered for another shipment' }));
    expect(parseSpxBr(changed('in-transit', (tracking) => { tracking.sls_tn = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(13);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_tracking: Tracking, body: Reply) => { delete (body as Row).retcode; },
      (_tracking: Tracking, body: Reply) => { body.data = 'shipment' as never; },
      (_tracking: Tracking, body: Reply) => { body.data.sls_tracking_info = 'tracking' as never; },
      (tracking: Tracking) => { delete (tracking as Row).sls_tn; },
      (tracking: Tracking) => { tracking.records = 'records' as never; },
      (tracking: Tracking) => { tracking.records = Array.from({ length: 1001 }, () => tracking.records[0]!); },
      (tracking: Tracking) => { tracking.records[0] = 'scan' as never; },
      (tracking: Tracking) => { tracking.records[0]!.actual_time = '1779200000'; },
      (tracking: Tracking) => { tracking.records[0]!.actual_time = 1_779_110_000_000; },
      (tracking: Tracking) => { delete tracking.records[0]!.actual_time; },
      (tracking: Tracking) => { tracking.records[0]!.description = ['Pedido entregue']; },
      (tracking: Tracking) => { tracking.records[0]!.tracking_code = 'F 980'; },
      (tracking: Tracking) => { tracking.records[0]!.description = ''; tracking.records[0]!.tracking_name = ''; },
    ]) {
      expect(() => parseSpxBr(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a gateway page and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://spx.com.br/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!doctype html><html><title>Verify</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"retcode":0,')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number with its last scan and the unknown-number answer, and asks nothing for another layout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-19T12:53:20.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('PH2600000000011')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers SPX Brazil does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BR260000000001', 'BR26000000000111', 'BR26000000000AX', 'SPXBR2600000000011', '5964000000000000001']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpxBrNumber('br 2600 0000 0002 x')).toBe(IN_TRANSIT);
  });

  it('ends a hanging read inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under SPX Express Brazil, or one its recognition confirms, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'spx-br' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'spx-br', source: 'spx-br', result: { current_stage: 'delivered' } });
    // Recognition settles on a carrier whose parcel moved lately.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-20T00:00:00Z'));
      await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'spx-br', source: 'spx-br' });
    } finally {
      vi.useRealTimers();
    }
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(SPX_BR_API))).toBe(true);
  });
});

describe('SPX Express Brazil numbers', () => {
  it('names SPX Brazil for its layout', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'spx-br', confidence: 'high', candidates: ['spx-br'] });
    }
  });
});

describe('SPX Express Brazil status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(spxBrStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'spx-br', providerCode: 'F600', description: 'Pedido em rota de entrega' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'spx-br', providerCode: 'F650', description: 'Houve um imprevisto durante a entrega do seu pedido' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'spx-br', providerCode: 'F777', description: 'Aviso sintético' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(spxBrStage('F981', 'Pedido entregue')).toMatchObject({ stage: 'delivered' });
    expect(spxBrStage('F777', 'Aviso sintético')).toBeNull();
  });
});
