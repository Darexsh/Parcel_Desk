import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ANJUN_API, anjunClock, anjunToken, AnjunTracker } from './adapter.js';
import { anjunWording, normalizeAnjunNumber, parseAnjun } from './parser.js';
import { anjunStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'AJ260301000000101';
const IN_TRANSIT = 'AJ260514000000201';
const UNKNOWN = 'AJ260101000000001';
// A Correios number of the kind Anjun's tracker also answers for.
const CORREIOS = 'NC000000000BR';

type Row = Record<string, unknown>;
type Reply = Row & { data: Row[]; extra: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (rows: Row[], reply: Reply) => void) => {
  const body = fixture(name);
  change(body.data, body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page the SafeLine firewall in front of the service serves a client it blocks.
const SAFELINE = '<!DOCTYPE html><html><head><title>访问已被拦截</title></head><body><div>Protected by SafeLine</div></body></html>';

describe('Anjun HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, with a fresh token, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new AnjunTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => Date.UTC(2026, 4, 21, 16, 30, 5) });
    await expect(tracker.fetch(' aj2605 1400 0000 201 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ANJUN_API}?trackNo=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    // A 1024-bit RSA block in base64.
    expect((init!.headers as Record<string, string>).token).toMatch(/^[A-Za-z0-9+/]{171}=$/);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'anjun', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('encrypts the time in Beijing afresh for every token', () => {
    expect(anjunClock(Date.UTC(2026, 4, 21, 16, 30, 5))).toBe('2026-05-22 00:30:05');
    expect(anjunClock(Date.UTC(2026, 11, 31, 15, 59, 59))).toBe('2026-12-31 23:59:59');
    // Random padding makes each token differ, even for the same second.
    expect(anjunToken(0)).not.toBe(anjunToken(0));
    expect(Buffer.from(anjunToken(), 'base64')).toHaveLength(128);
  });

  it('keeps each scan’s wall clock and stages it by its code', () => {
    const result = parseAnjun(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Entrada no armazém alfândegado de TFK', last_update: null, last_update_local: '2026-05-21T09:14:27',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-05-21T09:14:27', 'TFK _has_ been_ scanned', 'customs', null],
      ['2026-05-21T06:02:00', 'custody_receipt', 'in_transit', null],
      ['2026-05-20T23:48:00', 'arrival_at_destination_airport', 'in_transit', 'BR'],
      ['2026-05-19T04:15:00', 'air_take_off', 'in_transit', 'Sample Port'],
      ['2026-05-18T14:22:11', 'arrived_at_airline', 'in_transit', 'Sample Port'],
      ['2026-05-18T09:00:00', 'leave_orgin_place', 'in_transit', 'Sample Origin'],
      ['2026-05-16T17:45:02', 'leave_warehouse', 'in_transit', 'Sample Origin'],
      ['2026-05-15T23:55:57', 'arrive_at_warehouse', 'accepted', 'Sample Origin'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('destination_country');
  });

  it('keeps the delivery without the recipient, the courier, the proof of delivery, contacts or the repeated scan', () => {
    const result = parseAnjun(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'O pacote foi assinado', last_update: null, last_update_local: '2026-03-14T15:42:10' });
    expect(result.events).toHaveLength(20);
    expect(result.events!.slice(0, 5).map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['delivered', 'delivered', 'O pacote foi assinado'],
      ['to_be_delivered', 'out_for_delivery', 'Objeto saiu para entrega ao destinatário. É preciso ter alguém no endereço.'],
      ['delivery_failed', 'failed_attempt', 'A entrega falhou: Cliente ausente'],
      ['to_be_delivered', 'out_for_delivery', 'Objeto saiu para entrega ao destinatário'],
      ['Delivery_point_reception', 'in_transit', 'Objeto chegou ao ponto de entrega'],
    ]);
    expect(result.events!.filter((event) => event.provider_code === 'TRANSIT_WAREHOUSE_SENT')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Person|Courier)|example\.com|0000-0000|latitude|-50|Recebido|Exemplo|SPXD000|00000000/);
  });

  it('adds the detail the page shows beside a line and the destination country, never the recipient’s address', () => {
    const result = parseAnjun(changed('delivered', (rows, body) => {
      rows[2]!.extraData = { problemType: 'Endereço incorreto', statusDetail: 'Nova tentativa amanhã',
        logradouro: 'Rua Sample', numero: '000', bairro: 'Sample District' };
      body.extra.countryCode = 'br';
    }), DELIVERED);
    expect(result.events![2]).toMatchObject({ description: 'A entrega falhou: Endereço incorreto, Nova tentativa amanhã' });
    expect(result).toMatchObject({ destination_country: 'BR' });
    expect(JSON.stringify(result)).not.toMatch(/Rua Sample|Sample District/);
    // A country the page could show that is not a code is left out.
    expect(parseAnjun(changed('in-transit', (_rows, body) => { body.extra.countryCode = 'Brasil'; }), IN_TRANSIT))
      .not.toHaveProperty('destination_country');
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseAnjun(changed('in-transit', (rows) => { rows.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update_local: '2026-05-21T09:14:27', current_stage: 'customs' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'arrive_at_warehouse' });
  });

  it('stages a code the map does not know by its wording, and leaves an unclear one without a stage', () => {
    const worded = parseAnjun(changed('in-transit', (rows) => {
      Object.assign(rows[0]!, { stateCode: 'synthetic_code', status: 'Objeto entregue ao destinatário' });
    }), IN_TRANSIT);
    expect(worded.events![0]).toMatchObject({ provider_code: 'synthetic_code', stage: 'delivered', stage_source: 'wording:language' });
    const unclear = parseAnjun(changed('in-transit', (rows) => {
      Object.assign(rows[0]!, { stateCode: 'synthetic_code', status: 'Synthetic note' });
    }), IN_TRANSIT);
    expect(unclear.events![0]).not.toHaveProperty('stage');
    expect(unclear).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
    // A scan without a code is staged by its wording alone.
    const bare = parseAnjun(changed('in-transit', (rows) => { rows[0]!.stateCode = null; }), IN_TRANSIT);
    expect(bare.events![0]).not.toHaveProperty('provider_code');
  });

  it('takes phone numbers, e-mail addresses and contact sentences out of the wording', () => {
    expect(anjunWording('A entrega falhou', ['Cliente ausente'], '', false)).toBe('A entrega falhou: Cliente ausente');
    expect(anjunWording('Objeto saiu para entrega', [], 'Aguarde em casa. Ligue para +55 (00) 00000-0000.', false))
      .toBe('Objeto saiu para entrega. Aguarde em casa.');
    expect(anjunWording('Objeto saiu para entrega', [], 'Dúvidas: sac@example.com', false)).toBe('Objeto saiu para entrega');
    expect(anjunWording('A entrega falhou', ['Ligar 0000 000 0000'], '', false)).toBe('A entrega falhou: Ligar');
    // A delivery's note can name who took the parcel; a date stays.
    expect(anjunWording('O pacote foi assinado', [], 'Recebido por Sample Person', true)).toBe('O pacote foi assinado');
    expect(anjunWording('Nova data', [], 'Entrega prevista 2026-05-20.', false)).toBe('Nova data. Entrega prevista 2026-05-20.');
    expect(anjunWording('', ['Cliente ausente'], '', false)).toBe('Cliente ausente');
    expect(anjunWording('', [], '<p>Sample note</p>', false)).toBe('Sample note');
    expect(anjunWording('Linha.', ['', 'Linha'], '', false)).toBe('Linha.: Linha');
  });

  it('reads an unknown number as not found, another failure as inconclusive and a history without scans as no history', () => {
    expect(() => parseAnjun(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAnjun(fixture('service-error'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAnjun({ ...fixture('not-found'), code: 401 }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAnjun(changed('delivered', (rows) => { rows.length = 0; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a history only when it echoes the number asked', () => {
    expect(() => parseAnjun(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Anjun answered for another shipment' }));
    expect(parseAnjun(changed('in-transit', (_rows, body) => { body.extra.trackNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(8);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], body: Reply) => { body.code = '200'; },
      (_rows: Row[], body: Reply) => { delete (body as Row).extra; },
      (_rows: Row[], body: Reply) => { body.extra.trackNo = 7; },
      (_rows: Row[], body: Reply) => { body.data = 'scans' as never; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[0]!)); },
      (rows: Row[]) => { rows[0] = 'scan' as never; },
      (rows: Row[]) => { rows[0]!.date = '21/05/2026 09:14'; },
      (rows: Row[]) => { rows[0]!.date = '2026-05-21 24:00:00'; },
      (rows: Row[]) => { rows[0]!.date = '2026-02-30 09:14:27'; },
      (rows: Row[]) => { delete rows[0]!.date; },
      (rows: Row[]) => { rows[0]!.status = ['Entrada']; },
      (rows: Row[]) => { rows[0]!.status = ''; },
      (rows: Row[]) => { rows[0]!.extraData = 'detail'; },
      (rows: Row[]) => { rows[0]!.extraData = { problemType: 3 }; },
    ]) {
      expect(() => parseAnjun(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseAnjun('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refused token, a firewall block and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('service-error'))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://anjuntrack.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // A missing, stale or unreadable token gets an empty 403.
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(SAFELINE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Anjun</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Anjun does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-14T15:42:10' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(CORREIOS)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Anjun does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [CORREIOS, 'AJ26030100000010', 'AJ2603010000001010', 'AB260301000000101', `AJ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAnjunNumber('aj 2603-0100-0000-101')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    let calls = 0;
    const flaky = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return reply(fixture('delivered'));
    });
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(2);
    // Each try builds its own token.
    const tokens = flaky.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).token);
    expect(new Set(tokens).size).toBe(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Anjun, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'anjun' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'anjun', source: 'anjun', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'anjun', source: 'anjun' });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(ANJUN_API))).toBe(true);
  });
});

describe('Anjun numbers', () => {
  it('claims AJ, a date and nine digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, 'AJ251231999999999']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'anjun', confidence: 'high' });
      expect(recognitionAskedCarriers(number), number).not.toContain('anjun');
    }
    for (const number of ['AJ261301000000101', 'AJ260132000000101', 'AJ260300000000101', 'AJ2603010000001', 'AK260301000000101']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('anjun');
    }
  });

  it('names Anjun for its own numbers in its links, and leaves a Correios number in them to Correios', () => {
    for (const link of [`https://anjuntrack.com/trackQuery?t=${DELIVERED}`, `https://pu.anjuntrack.com/trajectory?orderNum=${DELIVERED}`,
      `https://anjunexpress.com/trackPackage?tracking=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'anjun', source: 'link' });
    }
    expect(parseTrackingInput('https://pu.anjuntrack.com/trackQuery?t=NC000000001BR').carrier).not.toBe('anjun');
  });
});

describe('Anjun status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, (entry.wording ?? '').toLowerCase()), entry.code).toBe(entry.stage);
      expect(anjunStage(entry.code, entry.wording ?? '')?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'anjun', providerCode: 'LM _has _collected', description: 'Objeto coletado' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'anjun', providerCode: 'synthetic_code', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(anjunStage('DELIVERY_FAILED', 'Synthetic note')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(anjunStage('synthetic_code', 'Synthetic note')).toBeNull();
  });
});
