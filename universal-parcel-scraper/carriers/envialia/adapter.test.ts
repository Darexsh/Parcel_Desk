import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ENVIALIA_ENDPOINT, EnvialiaTracker, envialiaRequestBody } from './adapter.js';
import { parseEnvialiaStatusXml } from './parser.js';
import { envialiaStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '0090010100000001';
const IN_TRANSIT = '0090020100000002';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const fault = '<?xml version=\'1.0\' encoding=\'utf-8\'?><soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope"><soapenv:Body>'
  + '<soapenv:Fault><soapenv:Code><soapenv:Value>soapenv:Receiver</soapenv:Value></soapenv:Code><soapenv:Reason><soapenv:Text xml:lang="en-US">'
  + 'Synthetic failure</soapenv:Text></soapenv:Reason></soapenv:Fault></soapenv:Body></soapenv:Envelope>';
const withState = (code: string, wording: string) => text('in-transit')
  .replace('<ax21:strCodEstado>1</ax21:strCodEstado>', `<ax21:strCodEstado>${code}</ax21:strCodEstado>`)
  .replace('<ax21:strDesEstado>En tránsito</ax21:strDesEstado>', `<ax21:strDesEstado>${wording}</ax21:strDesEstado>`);

describe('Envialia app status adapter', () => {
  it('posts the app\'s guest search for the whole number once through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EnvialiaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 009001 0100000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ENVIALIA_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', body: envialiaRequestBody(DELIVERED), signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/soap+xml;charset=utf-8;action="urn:buscarEstadoEnvio2"', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init?.body)).toContain(`<ser:strValor>${DELIVERED}</ser:strValor><ser:strTipoBusqueda>T</ser:strTipoBusqueda>`
      + '<ser:strCodPostal></ser:strCodPostal><ser:strIdMovil></ser:strIdMovil>');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'envialia', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment as an identity-bound summary, without the recipient\'s side or the agency\'s contacts', () => {
    const result = parseEnvialiaStatusXml(text('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', provider_code: '4', summary_only: true, last_update: null, expected_delivery: null, events: [] });
    const kept = JSON.stringify(result);
    for (const dropped of ['99901', 'Villaejemplo', 'PEDIDO', '900000001', 'example.com', '40.1', 'EJEMPLO NORTE', '00000000-0000', '12/03', '14/03', '2026-03-14']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('keeps the target day while the shipment is open, under either of its agencies and any namespace prefix', () => {
    const expected = { status: 'in_transit', current_stage: 'in_transit', last_status_text: 'En tránsito', provider_code: '1',
      summary_only: true, expected_delivery: '2026-03-18', events: [] };
    expect(parseEnvialiaStatusXml(text('in-transit'), IN_TRANSIT)).toMatchObject(expected);
    expect(parseEnvialiaStatusXml(text('in-transit'), '0090010100000002')).toMatchObject(expected);
    expect(parseEnvialiaStatusXml(withState('2', 'En reparto'), IN_TRANSIT)).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-03-18' });
    for (const code of ['3', '5', '10', '19']) {
      expect(parseEnvialiaStatusXml(withState(code, 'Synthetic'), IN_TRANSIT).expected_delivery, code).toBeNull();
    }
    const undated = text('in-transit').replace('18/03/2026', '18-03-2026');
    expect(parseEnvialiaStatusXml(undated, IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('keeps an unmapped state visible with its own wording, and words a known code the reply leaves blank', () => {
    const unknown = parseEnvialiaStatusXml(withState('6', 'Recanalizado'), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Recanalizado', provider_code: '6', expected_delivery: null });
    expect(unknown.current_stage).toBeUndefined();
    expect(parseEnvialiaStatusXml(withState('2', ''), IN_TRANSIT)).toMatchObject({ last_status_text: 'En reparto', current_stage: 'out_for_delivery' });
    expect(parseEnvialiaStatusXml(withState('77', ''), IN_TRANSIT)).toMatchObject({ status: 'unknown', last_status_text: '77' });
    expect(() => parseEnvialiaStatusXml(withState('', ''), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEnvialiaStatusXml(withState('4a', 'Entregado'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the reply to the whole requested number', () => {
    for (const number of ['0090010100000009', '0090030100000002', '0100000002009002']) {
      expect(() => parseEnvialiaStatusXml(text('in-transit'), number), number).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const shipment = /<ns:return[\s\S]*<\/ns:return>/.exec(text('delivered'))![0];
    const twice = text('delivered').replace(shipment, shipment + shipment);
    expect(() => parseEnvialiaStatusXml(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const other = shipment.replace('0100000001', '0100000005');
    expect(parseEnvialiaStatusXml(text('delivered').replace(shipment, other + shipment), DELIVERED)).toMatchObject({ status: 'delivered' });
    const repeated = text('delivered').replace('<ax23:strAlbaran>', '<ax23:strAlbaran>0100000001</ax23:strAlbaran><ax23:strAlbaran>');
    expect(() => parseEnvialiaStatusXml(repeated, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells the empty reply from a search the service could not run and from its faults', async () => {
    expect(() => parseEnvialiaStatusXml(text('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEnvialiaStatusXml(text('no-search'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEnvialiaStatusXml(fault, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')))
      .mockResolvedValueOnce(reply(text('no-search')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('0100000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const absent = vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found')));
    await expect(carrier(absent).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [400, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fault, status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing shipments', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Request Rejected</title></head><body>Request unsuccessful. Incapsula incident ID: 0-0</body></html>', 'challenge'],
      ['<html><script src="/_Incapsula_Resource?SWJIYLWA=0"></script></html>', 'challenge'],
      ['<html>Maintenance</html>', 'schema'],
      [text('not-found').replace('buscarEstadoEnvio2Response', 'buscarEstadoEnvioResponse').replace('buscarEstadoEnvio2Response', 'buscarEstadoEnvioResponse'), 'schema'],
      [text('not-found').replace('http://www.w3.org/2003/05/soap-envelope', 'http://schemas.xmlsoap.org/soap/envelope/'), 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects numbers the app does not search and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0100000001', '009001010000000', '00900101000000011', 'ES90010100000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller\'s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a parcel filed under Envialia to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'envialia' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'envialia', source: 'envialia', result: { current_stage: 'delivered', summary_only: true } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === ENVIALIA_ENDPOINT)).toBe(true);
  });

  it('keeps the status map in step with statuses.json', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(envialiaStatus(entry.code).stage, entry.code).toBe(stage);
      if ('wording' in entry) expect(envialiaStatus(entry.code).wording, entry.code).toBe(entry.wording);
      expect(statusMap.stage(entry.code, 'synthetic')).toBe(stage);
      if (!stage) expect(statusMap.gaps.map(gap => gap.code)).toContain(entry.code);
    }
    expect(statusMapAnswer({ carrier: 'envialia', providerCode: '4', description: 'Entregado' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'envialia', providerCode: '14', description: 'Entregado parcial' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
