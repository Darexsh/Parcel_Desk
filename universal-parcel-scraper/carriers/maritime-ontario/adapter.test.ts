import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MaritimeOntarioTracker } from './adapter.js';
import catalog from './carrier.json' with { type: 'json' };
import { normalizeMaritimeOntarioNumber, parseMaritimeOntarioBill, readMaritimeOntarioTrace } from './parser.js';
import { maritimeOntarioMappedStage, maritimeOntarioStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'F1234568';
const IN_TRANSIT = 'F0000000';
const VIEWER = 'https://cp.m-o.com/trace/external_bill_viewer.msw';
const AJAX = 'https://cp.m-o.com/trace/bill_details_ajax.msw';
const TYPES = ['~PTLORDER', '%PTLORDER', 'BPTRACE', 'PPTRACE', 'KPTRACE'];

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const reply = (name: string) => JSON.parse(text(`${name}.json`)) as Record<string, unknown>;
const page = (body: string, init: ResponseInit & { cookies?: string[] } = {}) => new Response(body, { status: init.status ?? 200,
  headers: [['Content-Type', 'text/html; charset=UTF-8'], ...(init.cookies ?? []).map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });
const SESSION = ['PHPSESSID=0000000000000000; path=/; HttpOnly'];

/** The portal: the viewer opens a session, the trace and the bill's details answer inside it. */
function portal(answers: { viewer?: () => Response; trace?: () => Response; bill?: () => Response } = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/external_bill_viewer.msw')) return answers.viewer?.() ?? page(text('viewer.html'), { cookies: SESSION });
    if (url.searchParams.get('func') === 'ExternalTrace') return answers.trace?.() ?? json(reply('trace-found'));
    if (url.searchParams.get('func') === 'BillDetails') return answers.bill?.() ?? json(reply('bill-delivered'));
    throw new Error(`unexpected request ${url}`);
  });
}
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (answers: Parameters<typeof portal>[0], number = DELIVERED) => carrier(portal(answers)).track({ number });

describe('Maritime-Ontario TM4Web adapter', () => {
  it('posts the whole trace form with the freight bill, then asks the trace and the bill in the session it opened', async () => {
    const fetcher = portal();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MaritimeOntarioTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' f123 4568 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [[viewer, form], [trace, traceInit], [bill, billInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit], [string, RequestInit]];
    expect(String(viewer)).toBe(VIEWER);
    expect(form).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://cp.m-o.com/trace/external.msw', 'User-Agent': 'SyntheticHost/1.0' } });
    // Every type of the form, the shippers' references empty: the trace finds nothing for a request without one of them.
    expect([...new URLSearchParams(String(form.body))]).toEqual(TYPES.flatMap((type, index) => [['trace_type[]', type],
      ['search_value[]', index ? '' : DELIVERED]]));
    const query = [...new URLSearchParams(new URL(String(trace)).search)];
    expect(query).toEqual([...TYPES.map((type) => ['trace_type[]', type]), ['search_value[]', DELIVERED], ...TYPES.slice(1).map(() => ['search_value[]', '']),
      ['func', 'ExternalTrace']]);
    expect(String(trace).startsWith(`${AJAX}?trace_type%5B%5D=%7EPTLORDER&trace_type%5B%5D=%25PTLORDER&`)).toBe(true);
    expect(String(bill)).toBe(`${AJAX}?func=BillDetails&dld=1234567`);
    for (const init of [traceInit, billInit]) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
        'X-Requested-With': 'XMLHttpRequest', Referer: VIEWER, 'User-Agent': 'SyntheticHost/1.0', Cookie: 'PHPSESSID=0000000000000000' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'maritime-ontario', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    // The link the catalog offers is M-O's quick track, which looks the number in its address up.
    expect(catalog.portal.url.replace('{trackingNumber}', DELIVERED)).toBe(`https://www.m-o.com/quick-track-form/?t=${DELIVERED}`);
  });

  it('reads a delivered history newest first, by its codes and descriptions, each once, with wall clocks kept local', () => {
    const result = parseMaritimeOntarioBill(reply('bill-delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'COMPLETE', last_update: null, last_update_local: '2026-03-05T13:50:01', expected_delivery: null,
      events: [
        { local_time: '2026-03-05T13:50:01', description: 'COMPLETE', provider_code: 'COMPLETE', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T13:50:00', description: 'DEPART CONSIGNEE', provider_code: 'DEPCONS', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T13:30:00', description: 'ARRIVE CONSIGNEE', provider_code: 'ARRCONS', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T09:12:00', description: 'INTRANSIT', provider_code: 'INTRANSIT', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T00:04:00', description: 'INTRANSIT', provider_code: 'INTRANSIT', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T15:10:00', description: 'DEPART SHIPPER', provider_code: 'DEPSHIP', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T14:55:00', description: 'ARRIVE SHIPPER', provider_code: 'ARRSHIP', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The zones, the trace numbers, the freight, the service and the user who entered the order are not kept.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE|SAMPLE|EXCOV|BOL|FAK|SVC-EX|1200|WEBUSER|CAD/);
  });

  it('reads a bill on its way with its scheduled delivery as an estimate over two days', () => {
    expect(parseMaritimeOntarioBill(reply('bill-in-transit'), IN_TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'INTRANSIT', last_update: null, last_update_local: '2026-03-10T02:31:00',
      expected_delivery: '2026-03-12', expected_delivery_from: '2026-03-11',
      events: [
        { local_time: '2026-03-10T02:31:00', description: 'INTRANSIT', provider_code: 'INTRANSIT', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T18:02:00', description: 'DEPART SHIPPER', provider_code: 'DEPSHIP', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T17:40:00', description: 'ARRIVE SHIPPER', provider_code: 'ARRSHIP', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps an unmapped code with its description and no stage, and a code without description as its wording', () => {
    const bill = reply('bill-in-transit');
    const rows = [{ ORDER_ID: '12345678', OS_LEG_ID: '8765432', OS_STATUS_CODE: 'APPTDEL', S_SHORT_DESCRIPTION: 'Delivery appointment <date>',
      OS_CHANGED: '2026-03-10 09:00:00.000000' }, { ORDER_ID: '12345678', OS_LEG_ID: '8765432', OS_STATUS_CODE: 'FREIGHTNA', S_SHORT_DESCRIPTION: '',
      OS_CHANGED: '2026-03-09 18:00:00.000000' }];
    expect(parseMaritimeOntarioBill({ ...bill, ODRSTAT: rows }, IN_TRANSIT)).toMatchObject({
      status: 'exception', current_stage: 'exception', last_status_text: 'Delivery appointment <date>',
      events: [{ provider_code: 'APPTDEL', description: 'Delivery appointment <date>' },
        { provider_code: 'FREIGHTNA', description: 'FREIGHTNA', stage: 'exception' }],
    });
    const appointment = parseMaritimeOntarioBill({ ...bill, ODRSTAT: rows.slice(0, 1) }, IN_TRANSIT);
    expect(appointment).toMatchObject({ status: 'unknown', expected_delivery: '2026-03-12' });
    expect(appointment.events![0]).not.toHaveProperty('stage');
  });

  it('reads the trace’s answer for an unknown freight bill as not found', async () => {
    expect(() => readMaritimeOntarioTrace(reply('trace-not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = portal({ trace: () => json(reply('trace-not-found')) });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes, of several matches, only the bill whose number is the whole freight bill asked', async () => {
    const several = reply('trace-several');
    const [own, other] = several.traceResults as Record<string, unknown>[];
    expect(readMaritimeOntarioTrace(several, DELIVERED)).toBe('1234567');
    expect(readMaritimeOntarioTrace(several, IN_TRANSIT)).toBe('12345678');
    for (const matches of [[other], [{ ...own, BILL_NUMBER: `${DELIVERED}B` }, other], [own, { ...own, DETAIL_LINE_ID: '7' }], []]) {
      expect(() => readMaritimeOntarioTrace({ ...several, traceResults: matches }, DELIVERED), JSON.stringify(matches))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    }
    expect(() => readMaritimeOntarioTrace({ REQUIRE_DISAMBIGUATION: true }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    const fetcher = portal({ trace: () => json(several), bill: () => json(reply('bill-in-transit')) });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(String(fetcher.mock.calls[2]![0])).toBe(`${AJAX}?func=BillDetails&dld=12345678`);
  });

  it('refuses a bill for another number, or a trace or bill reply without its answer, number or valid clocks', async () => {
    expect(() => parseMaritimeOntarioBill(reply('bill-delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(lookup({ bill: () => json(reply('bill-in-transit')) })).rejects.toMatchObject({ kind: 'indeterminate' });
    const bill = reply('bill-delivered');
    const order = bill.TLORDER as Record<string, unknown>;
    // A bill the session's trace did not find comes back as an empty list.
    await expect(lookup({ bill: () => json([]) })).rejects.toMatchObject({ kind: 'schema' });
    for (const broken of [null, [], {}, { TLORDER: [] }, { TLORDER: { ...order, BILL_NUMBER: '   ' } }, { ...bill, ODRSTAT: {} },
      { ...bill, ODRSTAT: [null] }, { ...bill, ODRSTAT: [{ OS_CHANGED: '2026-03-05 13:50:00.000000' }] }]) {
      expect(() => parseMaritimeOntarioBill(broken, DELIVERED), JSON.stringify(broken)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const clock of ['2026-02-30 08:27:00.000000', '2026-03-02 24:00:00.000000', '2026-03-02 08:27:00.000000Z',
      '2026-03-02T08:27:00-05:00', '02/03/2026 08:27', '2026-03-02', '']) {
      expect(() => parseMaritimeOntarioBill({ ...bill, ODRSTAT: [{ OS_CHANGED: clock, OS_STATUS_CODE: 'COMPLETE' }] }, DELIVERED), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const answer of [null, [], {}, { NO_RESULTS: false }, { DETAIL_LINE_ID: '' }, { DETAIL_LINE_ID: 'abc' },
      { MULTIPLE_RESULTS: true }, { error: 'Call failed' }]) {
      expect(() => readMaritimeOntarioTrace(answer, DELIVERED), JSON.stringify(answer)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an order without history apart from a missing bill', () => {
    const bill = reply('bill-in-transit');
    expect(() => parseMaritimeOntarioBill({ ...bill, ODRSTAT: [] }, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps blocks, rate limits, refused sessions, moved routes and server errors apart from a missing parcel', async () => {
    const BLOCKED = text('blocked.html');
    await expect(lookup({ viewer: () => page(BLOCKED, { status: 403 }) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ viewer: () => page(BLOCKED, { cookies: SESSION }) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ trace: () => page(BLOCKED) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ bill: () => page(BLOCKED, { status: 403 }) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ trace: () => json('Too Many Requests', 429) })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup({ viewer: () => page('Too Many Requests', { status: 429 }) })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup({ bill: () => json('', 500) })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ viewer: () => page('', { status: 503 }) })).rejects.toMatchObject({ kind: 'maintenance' });
    // Outside a session the portal sends the request to its home page.
    const home = () => new Response(null, { status: 302, headers: { Location: 'https://cp.m-o.com/home.msw' } });
    await expect(lookup({ trace: home })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(lookup({ bill: home })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(lookup({ viewer: () => page(text('viewer.html')) })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(lookup({ viewer: home })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ viewer: () => page('', { status: 404 }) })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ viewer: () => page('<html><body><h1>TM4Web</h1></body></html>', { cookies: SESSION }) }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ trace: () => json('<html><body>Call to ExternalTrace failed</body></html>') })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ bill: () => json('{"TLORDER":') })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('drops the session from an HTTP failure it reports', async () => {
    const error = await lookup({ bill: () => json('', 500) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect(JSON.stringify(error)).not.toContain('PHPSESSID');
    expect((error as UpstreamHttpError).diagnostics).toBeUndefined();
  });

  it('asks once more, in a new session, when M-O cannot be reached, inside the caller’s budget', async () => {
    let failed = false;
    const answering = portal();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (!failed && String(input).includes('func=ExternalTrace')) {
        failed = true;
        throw new TypeError('fetch failed');
      }
      return answering(input, init);
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new MaritimeOntarioTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('func') ?? 'viewer'))
      .toEqual(['viewer', 'ExternalTrace', 'viewer', 'ExternalTrace', 'BillDetails']);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('rejects what is not an F and seven digits, bills of lading and purchase orders among them, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'F', 'F000000', 'F00000000', '0000000', '00000000', 'G0000000', 'FF0000000', 'BOL0000000', 'PO0000000',
      `F${'0'.repeat(70)}`, 'Ｆ０００００００']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMaritimeOntarioNumber('f1234568')).toBe(DELIVERED);
    expect(normalizeMaritimeOntarioNumber(' F-000 0000 ')).toBe(IN_TRANSIT);
  });

  it('answers a number filed under Maritime-Ontario, and leaves freight bills unclaimed', async () => {
    const fetcher = portal();
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'maritime-ontario' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'maritime-ontario', source: 'maritime-ontario', result: { current_stage: 'delivered' } });
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('maritime-ontario');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id), number).not.toContain('maritime-ontario');
    }
    expect(carrier(fetcher).recognize).toBeUndefined();
  });
});

describe('Maritime-Ontario status vocabulary', () => {
  it('maps every recorded code to the stage it records and leaves the gaps unmapped', () => {
    const entries = (statuses.entries as { code?: string; stage?: string; unmapped?: boolean }[])
      .filter((entry): entry is { code: string; stage?: string; unmapped?: boolean } => Boolean(entry.code));
    for (const entry of entries) {
      const stage = entry.unmapped ? undefined : entry.stage;
      expect(maritimeOntarioMappedStage(entry.code), entry.code).toBe(stage);
      expect(maritimeOntarioStage(entry.code), entry.code).toEqual(stage ? { stage, source: 'carrier_map' } : null);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.code)), entry.code).toBe(stage);
      expect(statusMapAnswer({ carrier: 'maritime-ontario', providerCode: entry.code, description: entry.code }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : expect.objectContaining({ kind: 'intentional_gap' }));
    }
    expect(statusMap.gaps.map((gap) => gap.code)).toEqual(entries.filter((entry) => entry.unmapped).map((entry) => entry.code));
    expect(statusMapAnswer({ carrier: 'maritime-ontario', providerCode: 'LOADING', description: 'LOADING' })).toEqual({ kind: 'unknown' });
  });
});
