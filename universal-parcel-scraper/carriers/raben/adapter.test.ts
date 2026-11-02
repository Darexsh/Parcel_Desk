import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, RABEN_LINK, RABEN_SESSION, RabenTracker } from './adapter.js';
import { normalizeRabenNumber, parseRaben } from './parser.js';
import { rabenMappedStage, rabenStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '999999000000011';
const IN_TRANSIT = '999999000000022';
const UNKNOWN = '999999000000033';
const REFERENCE = 'SAMPLEREF7';
const COOKIES = ['XASSESSIONID=00000000-0000-4000-8000-000000000001; Path=/; HttpOnly; Secure; SameSite=Lax',
  'XASID=0.00000000-0000-4000-8000-000000000002; Path=/; HttpOnly; Secure; SameSite=Lax', 'Other=1; Path=/'];
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Values = Record<string, { value: unknown }>;
interface MendixObject { objectType: string; guid: string; attributes: Values }
interface Reply { instructions: { type: string; args: Record<string, unknown> }[]; objects: MendixObject[]; changes: Record<string, Values>;
  enumerations: Record<string, [string, string][]> }
const fixture = (name: string): Reply => JSON.parse(text(name)) as Reply;
const edited = (name: string, change: (payload: Reply) => void): Reply => {
  const payload = fixture(name);
  change(payload);
  return payload;
};
const ofType = (payload: Reply, type: string) => payload.objects.filter(object => object.objectType === type).map(object => payload.changes[object.guid]!);
const shipment = (payload: Reply) => ofType(payload, 'Anonymous.ShipmentNP')[0]!;
const search = (payload: Reply) => ofType(payload, 'Anonymous.AnonymousPage')[0]!;
const rows = (payload: Reply) => ofType(payload, 'Anonymous.StatusHistory');
const opened = (status = 303, cookies = COOKIES, body = '') => new Response(body || null, {
  status, headers: [...(status === 303 ? [['Location', '/index.html'] as [string, string]] : []), ...cookies.map(cookie => ['Set-Cookie', cookie] as [string, string])] });
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
/** A myRaben stand-in: the deep link opens a session, and the session's data are `body`. */
const site = (body: string | (() => Response), link: () => Response = () => opened()) => vi.fn<typeof fetch>(async (input) => {
  if (String(input).startsWith(`${RABEN_LINK}?`)) return link();
  return typeof body === 'string' ? reply(body) : body();
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Raben tracking adapter', () => {
  it('opens the deep link for the whole number, then asks for its session’s data, through the supplied transport', async () => {
    const fetcher = site(text('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RabenTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 999 999 000 000 011 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[link, first], [session, second]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(link).toBe(`${RABEN_LINK}?ShipmentNumber=${DELIVERED}&Language=EN`);
    expect(first).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(first.method ?? 'GET').toBe('GET');
    expect(session).toBe(RABEN_SESSION);
    expect(second).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'Content-Type': 'application/json', Cookie: 'XASSESSIONID=00000000-0000-4000-8000-000000000001; XASID=0.00000000-0000-4000-8000-000000000002',
      'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(second.body))).toMatchObject({ action: 'get_session_data', params: { timezoneId: 'UTC', version: 2 } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'raben', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first, as instants in each country’s zone, with the page’s captions and codes', () => {
    const result = parseRaben(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'delivered', last_update: '2026-05-20T09:15:00+02:00', delivered_at: '2026-05-20T09:15:00+02:00',
      expected_delivery: null, weight_kg: 412.5 });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-05-20T09:15:00+02:00', 'Beispielhof, AT', 'delivered', 'E03', 'delivered'],
      // Of two rows at the same instant, the page lists the one with the higher sequence first.
      ['2026-05-20T06:02:00+02:00', 'Beispielhof, AT', 'in delivery', 'E05', 'out_for_delivery'],
      ['2026-05-20T06:02:00+02:00', 'Beispielhof, AT', 'loaded', 'E08', 'in_transit'],
      ['2026-05-20T01:40:00+02:00', 'Beispielhof, AT', 'unloaded', 'E22', 'in_transit'],
      ['2026-05-18T18:53:00+02:00', 'Musterstadt, DE', 'loaded', 'E08', 'in_transit'],
      ['2026-05-18T10:52:00+02:00', 'Musterstadt, DE', 'collected', 'E02', 'accepted'],
      ['2026-05-17T16:00:00+02:00', 'Musterstadt, DE', 'shipment parameters updated', 'E67', undefined],
      ['2026-05-17T09:30:00Z', undefined, 'registered in the system', 'E21', 'registered'],
    ]);
    // Remarks, the customer-service depot, its phone numbers, colli and volume are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Erika|Remark|Depot|Sample Unit|\+0000|1\.8|"colli"/i);
    expect(result).not.toHaveProperty('summary_only');
  });

  it('reads a shipment on its way, with the planned delivery day', async () => {
    const answer = await carrier(site(text('in-transit'))).track({ number: IN_TRANSIT });
    expect(answer).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Inventory in a warehouse',
      last_update: '2026-03-10T11:05:00+02:00', expected_delivery: '2026-03-11', weight_kg: 18 });
    expect(answer.events!.map(event => [event.time, event.location])).toEqual([
      ['2026-03-10T11:05:00+02:00', 'Pavyzdžiai, LT'], ['2026-03-10T08:20:00+02:00', 'Pavyzdžiai, LT'],
      ['2026-03-09T18:45:00+01:00', 'Przykładowo, PL'], ['2026-03-09T11:10:00+01:00', 'Przykładowo, PL'], ['2026-03-08T12:00:00Z', undefined],
    ]);
    expect(answer).not.toHaveProperty('delivered_at');
  });

  it('orders rows whatever the reply’s order, keeps a repeated row once and reads a country with several zones in UTC', () => {
    const reversed = edited('delivered', payload => { payload.objects.reverse(); });
    expect(parseRaben(reversed, DELIVERED).events).toEqual(parseRaben(fixture('delivered'), DELIVERED).events);
    const repeated = edited('delivered', payload => {
      const row = payload.objects.find(object => object.objectType === 'Anonymous.StatusHistory')!;
      payload.objects.push({ ...row, guid: '900000000000000999' });
      payload.changes['900000000000000999'] = { ...payload.changes[row.guid]!, Sequence: { value: '9' } };
    });
    expect(parseRaben(repeated, DELIVERED).events).toHaveLength(8);
    const abroad = parseRaben(edited('in-transit', payload => {
      payload.enumerations['CMS.Countries']!.push(['Russia', 'Russia'], ['Sample_Land', 'Sample Land']);
      rows(payload)[0]!.Country = { value: 'Russia' };
      rows(payload)[1]!.Country = { value: 'Sample_Land' };
      rows(payload)[2]!.Country = { value: 'Unlisted_Land' };
    }), IN_TRANSIT);
    expect(abroad.events!.slice(0, 3).map(event => [event.time, event.location])).toEqual([
      ['2026-03-10T09:05:00Z', 'Pavyzdžiai, RU'], ['2026-03-10T06:20:00Z', 'Pavyzdžiai, Sample Land'], ['2026-03-09T17:45:00Z', 'Przykładowo, Unlisted Land']]);
  });

  it('keeps the newest stage under a notice or an unknown status, and reads a key without a caption by its words', () => {
    const notice = parseRaben(edited('in-transit', payload => {
      rows(payload)[0]!.DisplayShipmentStatus = { value: 'E55_new_delivery_date_agreed_with_consignee' };
    }), IN_TRANSIT);
    expect(notice).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'new delivery date agreed with consignee' });
    expect(notice.events![0]).not.toHaveProperty('stage');
    const unknown = parseRaben(edited('in-transit', payload => {
      rows(payload)[0]!.DisplayShipmentStatus = { value: 'E99_sample_status' };
    }), IN_TRANSIT);
    expect(unknown.events![0]).toMatchObject({ description: 'sample status', provider_code: 'E99' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    const worded = parseRaben(edited('in-transit', payload => {
      payload.enumerations['translations.ShipmentStatus']!.push(['E98_sample', 'delivered']);
      rows(payload)[0]!.DisplayShipmentStatus = { value: 'E98_sample' };
    }), IN_TRANSIT);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language' });
  });

  it('reads self collection as held at the depot for the recipient, and a round after it as a change of plan', () => {
    const SELF = 'E07_The_shipment_is_awaiting_for_own_pick_up_by_consginee';
    const pickup = parseRaben(edited('in-transit', payload => { rows(payload)[0]!.DisplayShipmentStatus = { value: SELF }; }), IN_TRANSIT);
    expect(pickup).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'not delivered - self collection' });
    const round = parseRaben(edited('in-transit', payload => {
      rows(payload)[0]!.DisplayShipmentStatus = { value: 'E05_The_shipment_in_delivery' };
      rows(payload)[1]!.DisplayShipmentStatus = { value: SELF };
    }), IN_TRANSIT);
    expect(round).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'in delivery' });
    expect(round.events!.slice(0, 2).map(event => [event.provider_code, event.stage])).toEqual([['E05', 'out_for_delivery'], ['E07', 'ready_for_pickup']]);
  });

  it('reads the ETA slot of a delivery round as the expected window, until the round is over or the shipment settled', async () => {
    // A slot of four hours from 11:00 UTC, after the newest row at 09:05 UTC in Lithuania.
    const FROM = 1773140400000;
    const TO = 1773154800000;
    const eta = (name: string, from: unknown, to: unknown, change: (payload: Reply) => void = () => {}) => edited(name, payload => {
      shipment(payload).EtaFrom = { value: from };
      shipment(payload).EtaTo = { value: to };
      change(payload);
    });
    const onRound = (payload: Reply) => { rows(payload)[0]!.DisplayShipmentStatus = { value: 'E05_The_shipment_in_delivery' }; };
    const answer = await carrier(site(JSON.stringify(eta('in-transit', FROM, TO, onRound)))).track({ number: IN_TRANSIT });
    expect(answer).toMatchObject({ current_stage: 'out_for_delivery',
      expected_delivery_from: '2026-03-10T13:00:00+02:00', expected_delivery: '2026-03-10T17:00:00+02:00' });
    // A slot of one instant is that instant.
    const instant = parseRaben(eta('in-transit', TO, TO), IN_TRANSIT);
    expect(instant).toMatchObject({ expected_delivery: '2026-03-10T17:00:00+02:00' });
    expect(instant).not.toHaveProperty('expected_delivery_from');
    // A slot that ended before the newest row, or without both ends in order, leaves the planned day.
    for (const [from, to] of [[1773129600000, 1773133200000], [FROM, null], [null, TO], [TO, FROM]]) {
      const planned = parseRaben(eta('in-transit', from, to), IN_TRANSIT);
      expect(planned, `${from} ${to}`).toMatchObject({ expected_delivery: '2026-03-11' });
      expect(planned).not.toHaveProperty('expected_delivery_from');
    }
    // A shipment without rows writes the slot in UTC; a delivered one expects nothing.
    const summary = parseRaben(eta('in-transit', FROM, TO, payload => {
      payload.objects = payload.objects.filter(object => object.objectType !== 'Anonymous.StatusHistory');
    }), IN_TRANSIT);
    expect(summary).toMatchObject({ summary_only: true, expected_delivery_from: '2026-03-10T11:00:00Z', expected_delivery: '2026-03-10T15:00:00Z' });
    const delivered = parseRaben(eta('delivered', 1779262200000, 1779276600000), DELIVERED);
    expect(delivered).toMatchObject({ current_stage: 'delivered', expected_delivery: null });
    expect(delivered).not.toHaveProperty('expected_delivery_from');
  });

  it('reads a shipment without status rows from its own status, and one without either as having no history yet', () => {
    const summary = parseRaben(edited('in-transit', payload => {
      payload.objects = payload.objects.filter(object => object.objectType !== 'Anonymous.StatusHistory');
    }), IN_TRANSIT);
    expect(summary).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Inventory in a warehouse',
      provider_code: 'E44', last_update: null, expected_delivery: '2026-03-11', weight_kg: 18, summary_only: true, events: [] });
    expect(() => parseRaben(edited('in-transit', payload => {
      payload.objects = payload.objects.filter(object => object.objectType !== 'Anonymous.StatusHistory');
      shipment(payload).DisplayShipmentStatus = { value: null };
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Rows of another shipment in the session are not this one's.
    const other = parseRaben(edited('in-transit', payload => {
      for (const row of rows(payload)) row['Anonymous.StatusHistory_ShipmentNP'] = { value: '900000000000000998' };
    }), IN_TRANSIT);
    expect(other).toMatchObject({ summary_only: true, events: [] });
  });

  it('reads the page’s not-found as missing, during retrieval and recognition', async () => {
    expect(() => parseRaben(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(site(text('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site(text('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(site(text('delivered'))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-05-20T07:15:00.000Z' });
  });

  it('binds the answer to the whole number: another search is a changed reply, a reference or colli match is inconclusive', async () => {
    expect(() => parseRaben(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema', message: 'Raben answered for a different search' }));
    expect(() => parseRaben(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const reference = edited('delivered', payload => { search(payload).SearchString = { value: REFERENCE }; });
    expect(() => parseRaben(reference, REFERENCE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'reference_only' }));
    await expect(carrier(site(JSON.stringify(reference))).track({ number: REFERENCE.toLowerCase() }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'reference_only' });
    await expect(carrier(site(JSON.stringify(reference))).recognize!(REFERENCE)).rejects.toMatchObject({ reason: 'reference_only' });
    const unasked = edited('not-found', payload => { search(payload).SearchString = { value: null }; });
    expect(() => parseRaben(unasked, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const padded = edited('delivered', payload => { shipment(payload).ShipmentNumber = { value: ` ${DELIVERED} ` }; });
    expect(parseRaben(padded, DELIVERED).events).toHaveLength(8);
  });

  it('rejects changed replies instead of reading them as missing', () => {
    const another = (name: string) => edited('delivered', payload => { payload.instructions[0]!.args.FormName = name; });
    expect(() => parseRaben(another('Anonymous.Home'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRaben(edited('delivered', payload => { payload.instructions = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const cases: unknown[] = [[], null, 'reply', { instructions: {} },
      edited('delivered', reply => { reply.instructions.push(reply.instructions[0]!); }),
      edited('delivered', reply => { reply.instructions[0]!.args = {}; }),
      edited('delivered', reply => { reply.instructions[0]!.args.FormParameters = { $AnonymousPage_Hook: '900000000000000998' }; }),
      edited('delivered', reply => { (reply as unknown as Record<string, unknown>).objects = null; }),
      edited('delivered', reply => { reply.objects.push(reply.objects.find(object => object.objectType === 'Anonymous.AnonymousPage')!); }),
      edited('delivered', reply => { reply.objects[0]!.guid = 'guid'; }),
      edited('delivered', reply => { (reply.objects[0] as unknown as Record<string, unknown>).attributes = null; }),
      edited('delivered', reply => { (reply.changes as Record<string, unknown>)[reply.objects[0]!.guid] = 'changes'; }),
      edited('delivered', reply => { search(reply).SearchString = { value: 7 }; }),
      edited('delivered', reply => { search(reply)['Anonymous.AnonymousPage_ShipmentNP_NP'] = { value: null }; }),
      edited('delivered', reply => { search(reply)['Anonymous.AnonymousPage_ShipmentNP_NP'] = { value: 7 }; }),
      edited('delivered', reply => { shipment(reply).GrossWeight = { value: 412.5 }; }),
      edited('delivered', reply => { shipment(reply).GrossWeight = { value: '-1' }; }),
      edited('delivered', reply => { shipment(reply).DeliveryDate = { value: '2026-05-20' }; }),
      edited('delivered', reply => { shipment(reply).EtaFrom = { value: '2026-05-20T10:00' }; }),
      edited('delivered', reply => { shipment(reply).EtaTo = { value: -1 }; }),
      edited('delivered', reply => { rows(reply)[1]!.TimeStamp = { value: null }; }),
      edited('delivered', reply => { rows(reply)[1]!.TimeStamp = { value: '1779250920000' }; }),
      edited('delivered', reply => { rows(reply)[1]!.TimeStamp = { value: 1.5 }; }),
      edited('delivered', reply => { rows(reply)[1]!.DisplayShipmentStatus = { value: null }; }),
      edited('delivered', reply => { rows(reply)[1]!.DisplayShipmentStatus = { value: 'E05 in delivery' }; }),
      edited('delivered', reply => { rows(reply)[1]!.City = { value: ['Beispielhof'] }; }),
      edited('delivered', reply => { rows(reply)[1]!.Sequence = { value: 2 }; }),
      edited('delivered', reply => { rows(reply)[1]!.Country = { value: 7 }; }),
      edited('delivered', reply => { rows(reply)[1]!['Anonymous.StatusHistory_ShipmentNP'] = { value: {} }; }),
      edited('delivered', reply => { delete (reply.enumerations as Record<string, unknown>)['translations.ShipmentStatus']; }),
      edited('delivered', reply => { (reply.enumerations as Record<string, unknown>)['CMS.Countries'] = [['Austria']]; }),
      edited('delivered', reply => {
        const row = reply.objects.find(object => object.objectType === 'Anonymous.StatusHistory')!;
        for (let index = 0; index < 501; index += 1) {
          reply.objects.push({ ...row, guid: String(800000000000000000n + BigInt(index)) });
          reply.changes[String(800000000000000000n + BigInt(index))] = { ...reply.changes[row.guid]!, TimeStamp: { value: 1779000000000 + index } };
        }
      })];
    for (const payload of cases) {
      expect(() => parseRaben(payload, DELIVERED), String(cases.indexOf(payload))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a browser check as a challenge and another page as a changed reply, never as missing', async () => {
    const lookup = (fetcher: typeof fetch) => carrier(fetcher).track({ number: DELIVERED });
    await expect(lookup(site(text('delivered'), () => opened(200, [], CHECK)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(text('delivered'), () => opened(403, [], CHECK)))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(text('delivered'), () => opened(200, [], '<html><body>Sample page</body></html>'))))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'Raben did not open an anonymous session' });
    await expect(lookup(site(() => reply(CHECK, 200, 'text/html')))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => reply(CHECK, 403, 'text/html')))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(site(() => reply('<html><body>Sample maintenance page</body></html>', 200, 'text/html')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(site(() => reply('  ')))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(site(() => reply('{"error":"Session expired"}', 401)))).rejects.toMatchObject({ kind: 'indeterminate', status: 401 });
    await expect(lookup(site(`\uFEFF${text('delivered')}`))).resolves.toMatchObject({ status: 'delivered' });
  });

  it('keeps rate limits and HTTP failures of either request, without a retry', async () => {
    const limited = () => new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '30' } });
    await expect(carrier(site(text('delivered'), limited)).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(site(limited)).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(site(limited)).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    for (const [status, kind] of [[404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const) {
      const link = site(text('delivered'), () => reply('', status, 'text/html'));
      await expect(carrier(link).track({ number: DELIVERED }), `link ${status}`).rejects.toMatchObject({ kind });
      expect(link).toHaveBeenCalledTimes(1);
      const session = site(() => reply('', status, 'text/html'));
      await expect(carrier(session).track({ number: DELIVERED }), `session ${status}`).rejects.toMatchObject({ kind });
      expect(session).toHaveBeenCalledTimes(2);
    }
    await expect(carrier(site(() => new Response(null, { status: 302, headers: { Location: '/login.html' } }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('tries once more in a new session after a failed connection, inside the caller’s budget', async () => {
    let calls = 0;
    const flaky = site(() => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return reply(text('delivered'));
    });
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const immediate = site(text('delivered'));
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
    const large = site(() => new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('takes letters and digits with at least one digit, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABC', 'SAMPLEREF', '12', '9999/9900', `9${'0'.repeat(40)}`, `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRabenNumber(' 999-999 000.000 011 ')).toBe(DELIVERED);
    expect(normalizeRabenNumber('sampleref7')).toBe(REFERENCE);
  });

  it('routes a shipment filed under Raben, and its tracking link, to the adapter', async () => {
    const fetcher = site(text('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'raben' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'raben', source: 'raben', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${RABEN_LINK}?`) || String(url) === RABEN_SESSION)).toBe(true);
    for (const link of [`https://oftc.myraben.com/link/ShipmentInformation?ShipmentNumber=${DELIVERED}&Language=EN`,
      `https://myraben.com/link/ShipmentInformation/?ShipmentNumber=${DELIVERED}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'raben', source: 'link' });
    }
  });
});

describe('Raben status vocabulary', () => {
  it('stages every status of the page’s list or leaves it out on purpose', () => {
    const gaps = new Set(statusMap.gaps.map(gap => gap.code));
    for (const [key, caption] of fixture('delivered').enumerations['translations.ShipmentStatus']!) {
      const code = key.slice(0, 3);
      expect(Boolean(rabenMappedStage(code)) !== gaps.has(code), key).toBe(true);
      expect(rabenStage(code, caption)?.stage, key).toBe(rabenMappedStage(code));
    }
  });

  it('maps every code it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording), entry.code).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'raben', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'raben', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'raben', providerCode: 'E99', description: 'sample status' })).toEqual({ kind: 'unknown' });
    expect(rabenStage('e03', 'delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    for (const code of ['constructor', 'toString', 'E3', '']) expect(rabenMappedStage(code), code).toBeUndefined();
  });
});
