import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FORZA_API, ForzaTracker } from './adapter.js';
import { forzaWording, normalizeForzaNumber, parseForza, parseForzaReply } from './parser.js';
import { forzaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'FD0000001';
const IN_TRANSIT = 'FD0000002';
const UNKNOWN = 'FD0000000';

type Row = Record<string, unknown>;
type Answer = Row & { StatusCode: unknown; ObjectValue: Row & { order: Row & { milestones: Row[] } } };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
// The reply's three layers: ASP.NET's `d`, the relay's `Data` and its `PayLoad`, each a string of JSON.
const decode = (body: string): Answer => {
  const relay = JSON.parse((JSON.parse(body) as { d: string }).d) as { Data: string };
  return JSON.parse((JSON.parse(relay.Data) as { PayLoad: string }).PayLoad) as Answer;
};
const encode = (answer: unknown, relay: Row = {}) => JSON.stringify({ d: JSON.stringify({ StatusCode: null,
  Data: JSON.stringify({ CodApp: 'SAMPLEAPP000', PayLoad: JSON.stringify(answer) }), Message: null, ...relay }) });
const fixture = (name: string) => decode(text(name));
const edited = (name: string, change: (answer: Answer) => void): Answer => {
  const answer = fixture(name);
  change(answer);
  return answer;
};
const reply = (body: string, status = 200, type = 'application/json; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const failedRelay = (status: string) => JSON.stringify({ d: JSON.stringify({ StatusCode: status, Data: null,
  Message: 'The remote server returned an error.' }) });
const BALANCER = '<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n</body>\r\n</html>\r\n';

describe('Forza Delivery tracking adapter', () => {
  it('posts the guía to the page method once, as the tracking page builds it, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ForzaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' fd- 000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(FORZA_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'SyntheticHost/1.0' } });
    const body = JSON.parse(String(init!.body)) as { path: string; data: string };
    expect(body.path).toBe('Tracking/GetNewDeliveryTracking');
    // The page's parameters for a guía, with no reference, phone or captcha token.
    expect(JSON.parse(body.data)).toEqual({ Method: 'GetNewDeliveryTracking',
      Params: { GuideSerie: 'FD', GuideNumber: '0000001', TicketNumber: '', NirPhone: 0, Phone: 0 } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'forza-delivery', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered guía newest first, with wall clocks, stage ids and nobody’s name, phone or price', () => {
    const result = parseForzaReply(text('delivered'), DELIVERED);
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-03-12T14:07:31', expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-03-12T14:07:31', '5', 'Entregado', 'delivered'],
      ['2026-03-12T08:52:10', '4', 'En ruta', 'out_for_delivery'],
      ['2026-03-12T06:40:00', '11', 'Arribó a las instalaciones', 'in_transit'],
      ['2026-03-11T21:15:44', '19', 'En Tránsito', 'in_transit'],
      // The repeated inventory scan is kept once.
      ['2026-03-11T10:03:27', '10', 'En Inventario', 'in_transit'],
      ['2026-03-11T07:20:00', '11', 'Arribó a las instalaciones', 'in_transit'],
      ['2026-03-11T02:31:05', '19', 'En Tránsito', 'in_transit'],
      ['2026-03-10T19:45:12', '11', 'Arribó a las instalaciones', 'in_transit'],
      ['2026-03-10T17:22:48', '2', 'Recolectado', 'accepted'],
      ['2026-03-10T11:05:19', '1', 'Solicitado', 'registered'],
      ['2026-03-10T11:05:02', '15', 'Generado', 'registered'],
    ]);
    expect(result.events!.every((event) => !event.time && !event.location && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Sample|0000-0000|00000000|Comprobante|Price|SAMPLEAPP/);
  });

  it('reads a guía between facilities as in transit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'En Inventario', last_update_local: '2026-05-06T09:12:40',
      events: [{ provider_code: '10' }, {}, {}, { stage: 'accepted' }, { description: 'Generado', stage: 'registered' }] });
  });

  it('shows a description that says more, after an incident’s classification, without people or phone numbers', () => {
    expect(forzaWording('Entregado', 'Entregado')).toBe('Entregado');
    expect(forzaWording('Entregado', ' entregado ')).toBe('Entregado');
    expect(forzaWording('Entregado', 'Entregado a Sample Person')).toBe('Entregado');
    expect(forzaWording('Entregado', 'Recibido por Sample Person en portería')).toBe('Entregado');
    expect(forzaWording('Entregado', 'Recibe: Sample Person')).toBe('Entregado');
    expect(forzaWording('Visita', 'Cliente ausente, llamar al 0000-0000')).toBe('Visita: Cliente ausente, llamar al');
    expect(forzaWording('Novedad', 'Sample note', 'Sample classification')).toBe('Novedad: Sample classification - Sample note');
    expect(forzaWording('', 'Sample note')).toBe('Sample note');
    const incident = parseForza(edited('in-transit', (answer) => {
      Object.assign(answer.ObjectValue.order.milestones[0]!, { stageId: 45, title: 'Novedad', clasification: 'Sample classification',
        description: 'Sample note' });
    }), IN_TRANSIT);
    expect(incident.events![0]).toEqual({ local_time: '2026-05-06T09:12:40', provider_code: '45',
      description: 'Novedad: Sample classification - Sample note' });
    // The newest scan without a stage leaves the stage to the scan before it.
    expect(incident).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Novedad: Sample classification - Sample note' });
    // Other scans keep the page's title and description only.
    const other = parseForza(edited('in-transit', (answer) => { answer.ObjectValue.order.milestones[0]!.clasification = 'Sample'; }), IN_TRANSIT);
    expect(other.events![0]!.description).toBe('En Inventario');
  });

  it('reads an oldest-first history newest first, and a scan with an unknown stage id by its wording', () => {
    const reversed = parseForza(edited('delivered', (answer) => { answer.ObjectValue.order.milestones.reverse(); }), DELIVERED);
    expect(reversed.events).toEqual(parseForzaReply(text('delivered'), DELIVERED).events);
    const unknown = parseForza(edited('in-transit', (answer) => {
      answer.ObjectValue.order.milestones.unshift({ stageId: 99, date: '2026-05-07 10:00:00Z', title: 'Devuelto', description: 'Devuelto' });
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:language' });
    expect(unknown.events![0]).toMatchObject({ provider_code: '99', stage: 'returned' });
    const alone = parseForza(edited('in-transit', (answer) => {
      answer.ObjectValue.order.milestones = [{ stageId: 98, date: '2026-05-07 10:00:00Z', title: 'Sample event', description: '' }];
    }), IN_TRANSIT);
    expect(alone).toMatchObject({ status: 'unknown', last_status_text: 'Sample event' });
    expect(alone.current_stage).toBeUndefined();
  });

  it('reads the tracker’s 404 result as missing and an order kept without milestones as no history', async () => {
    expect(() => parseForzaReply(text('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const milestones of [[], null]) {
      expect(() => parseForza(edited('delivered', (answer) => { answer.ObjectValue.order.milestones = milestones as never; }), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
    const empty = encode(edited('delivered', (answer) => { answer.ObjectValue.order.milestones = []; }));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(empty));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ name: 'NoHistoryError' });
    // The tracker still has the guía.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null });
  });

  it('keeps the relay’s failures, the tracker’s refusals and block pages apart from a missing guía', async () => {
    const lookup = (body: string, status = 200, type?: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(failedRelay('Conflict'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(failedRelay('InternalServerError'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(failedRelay('TooManyRequests'))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(JSON.stringify({ d: JSON.stringify({ StatusCode: null, Data: JSON.stringify({ CodApp: 'SAMPLEAPP000', PayLoad: null }) }) })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(encode(edited('not-found', (answer) => { answer.StatusCode = 500; answer.ObjectValue = null as never; }))))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // The page shows its message for a refusal, or for a reference that names several guías.
    for (const result of [201, 400, 409]) {
      await expect(lookup(encode(edited('not-found', (answer) => { answer.ObjectValue.IdResult = result; })))).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>', 200, 'text/html'))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The load balancer turns some networks away with its bare page.
    await expect(lookup(BALANCER, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(`\uFEFF${text('not-found')}`)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('counts an order only when it is the guía asked, read as the number the tracker reads', () => {
    expect(() => parseForzaReply(text('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Forza answered for another guía' }));
    // The tracker reads the digits as a number: FD000001 and FD00000001 are FD1, as the order says.
    expect(parseForzaReply(text('delivered'), 'FD000001').events).toHaveLength(11);
    expect(parseForzaReply(text('delivered'), 'FD00000001').events).toHaveLength(11);
    for (const change of [
      (order: Row) => { order.GuideSerie = 'FX'; },
      (order: Row) => { order.id = 'FD2'; },
    ]) {
      expect(() => parseForza(edited('delivered', (answer) => change(answer.ObjectValue.order)), DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseForza(edited('delivered', (answer) => { delete answer.ObjectValue.order.id; }), DELIVERED).events).toHaveLength(11);
  });

  it('rejects changed replies', () => {
    for (const change of [
      (answer: Answer) => { answer.ObjectValue = 'answer' as never; },
      (answer: Answer) => { delete answer.ObjectValue.IdResult; },
      (answer: Answer) => { answer.ObjectValue.IdResult = '202'; },
      (answer: Answer) => { answer.ObjectValue.order = null as never; },
      (answer: Answer) => { delete answer.ObjectValue.order.GuideNumber; },
      (answer: Answer) => { answer.ObjectValue.order.GuideNumber = '1'; },
      (answer: Answer) => { answer.ObjectValue.order.GuideNumber = 1.5; },
      (answer: Answer) => { answer.ObjectValue.order.milestones = 'milestones' as never; },
      (answer: Answer) => { answer.ObjectValue.order.milestones = Array.from({ length: 501 }, () => answer.ObjectValue.order.milestones[0]!); },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1] = 'scan' as never; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.title = ['En ruta']; },
      (answer: Answer) => { Object.assign(answer.ObjectValue.order.milestones[1]!, { title: ' ', description: '' }); },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.stageId = '4'; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.stageId = -4; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.date = '12/03/2026 08:52'; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.date = '2026-02-30 08:52:10Z'; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.date = '2026-03-12 24:00:00Z'; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.date = '2026-03-12 08:52:10-06:00'; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.date = '0001-01-01 00:00:00Z'; },
      (answer: Answer) => { answer.ObjectValue.order.milestones[1]!.date = null; },
    ]) {
      expect(() => parseForza(edited('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['{"d":', '[]', '{"d":7}', '{"d":"[]"}', '{"d":"{\\"Data\\":\\"Sample\\"}"}', JSON.stringify({ d: JSON.stringify({ Data: '{"PayLoad":7}' }) })]) {
      expect(() => parseForzaReply(body, DELIVERED), body).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes FD guías of six to nine digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['FD00001', 'FD0000000001', '0000001', 'FX0000001', 'FDA000001', 'SAMPLETRACKING', `FD${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeForzaNumber('fd 000.0002')).toBe(IN_TRANSIT);
    expect(normalizeForzaNumber('FD000000002')).toBe('FD000000002');
    expect(() => parseForzaReply(text('delivered'), 'FD-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('recognizes a known guía and an unknown one from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T14:07:31' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps ASP.NET’s own failure as inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('{"Message":"There was an error processing the request.","StackTrace":"","ExceptionType":""}', 500));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a guía filed under Forza, or detected as one, to the adapter', async () => {
    // Recognition asks a day after the delivery on Forza's local clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-13T12:00:00Z'));
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
      const tracker = createTracker({ fetcher, providers: [], env: {} });
      await expect(tracker.track({ number: DELIVERED, carrier: 'forza-delivery' }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'forza-delivery', source: 'forza-delivery', result: { current_stage: 'delivered' } });
      await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'forza-delivery', source: 'forza-delivery' });
      expect(fetcher.mock.calls.every(([url]) => String(url) === FORZA_API)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Forza Delivery numbers', () => {
  it('suggests Forza for an FD guía with low confidence, and preflight asks it', () => {
    for (const number of [DELIVERED, 'FD000001', 'FD00000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['forza-delivery']) });
      expect(recognitionAskedCarriers(number), number).toContain('forza-delivery');
    }
    expect(detectCarrierMatch('FD000000002').candidates ?? []).not.toContain('forza-delivery');
  });
});

describe('Forza Delivery status vocabulary', () => {
  it('maps every stage id it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(forzaStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'forza-delivery', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'forza-delivery', providerCode: '99', description: 'Sample event' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage(null, 'entregado')).toBeUndefined();
    // An id the map does not know falls to the shared wording rules.
    expect(forzaStage('99', 'Entregado')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(forzaStage('45', 'Sample event')).toBeNull();
  });
});
