import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TEAM_TRAC, teamLookupBody, TeamTracker } from './adapter.js';
import { normalizeTeamNumber, parseTeam } from './parser.js';
import { statusMap, teamStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZZ100001';
const IN_TRANSIT = 'ZZZ100003';
const OTHER = 'ZZZ100005';
const UNKNOWN = 'ZZZ100009';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const page = (name: string) => answering(() => reply(fixture(name)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The block page of the Fortinet firewall in front of the site, as it could stand in place of the page.
const BLOCKED = '<html><head><title>Web Page Blocked</title></head><body><p>Access to the web page you were trying to visit has been blocked.</p><p>Attack ID: 20000051</p></body></html>';
const events = (result: ReturnType<typeof parseTeam>) => result.events!.map((event) => [event.local_time, event.provider_code ?? null,
  event.description, event.location ?? null, event.stage ?? null]);
// The answer's block, the rows of its status details and its header's rows.
const ANSWER = /<div class="tracInfo">[\s\S]*?<\/div><br \/>\n/;
const answer = (html: string) => ANSWER.exec(html)![0];
const withRows = (html: string, rows: [string, string, string, string][]) => html.replace(/<tbody><tr><td>[\s\S]*?\n\t\t<\/tbody>/,
  `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join(' ')}</tr>`).join('\n')}\n\t\t</tbody>`);
const status = (html: string, wording: string) => html.replace(/(<td class="tracright">Status<\/td>\s*<td class="[a-z]+">)[^<]*/, `$1${wording}`);

describe('Team Worldwide HTTP adapter', () => {
  it('posts the Team Trac form for the whole bill, through the supplied transport', async () => {
    const fetcher = page('in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TeamTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzz-100 003 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TEAM_TRAC);
    expect(TEAM_TRAC).toBe('https://www.teamww.com/tracking/team-trac');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `hbl=${IN_TRANSIT}&srn=&con=`,
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(teamLookupBody('26zzzc100007')).toBe('hbl=26ZZZC100007&srn=&con=');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'team-worldwide', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered history as wall clocks, without the signer, the remarks, the booking agent, the reference or the ZIP code', () => {
    const result = parseTeam(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SIGNED FOR', last_update: null, last_update_local: '2026-03-12T14:40:00', expected_delivery: null,
    });
    for (const field of ['summary_only', 'history_truncated', 'delivered_at', 'receiver_name', 'sender_name']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(events(result)).toEqual([
      ['2026-03-12T14:40:00', 'POD', 'SIGNED FOR', null, 'delivered'],
      ['2026-03-12T08:15:00', 'OFD', 'OUT FOR DELIVERY', 'EXAMPLETOWN, TX', 'out_for_delivery'],
      // Stamped when it was booked; the day it is booked for is an estimate, and the agent is not kept.
      ['2026-03-11T09:10:00', 'ADS', 'APPT FOR DEL SCHED', null, 'in_transit'],
      // The station's remark is left out.
      ['2026-03-10T16:30:00', 'ASD', 'ATTEMPTING TO SCHEDULE DELIVERY APPOINTMENT', null, 'in_transit'],
      ['2026-03-10T07:02:00', 'COH', 'FREIGHT ON HAND', null, 'in_transit'],
      ['2026-03-09T22:15:00', 'RCU', 'FREIGHT RECOVERED', null, 'in_transit'],
      // The repeated row is kept once.
      ['2026-03-06T19:40:00', 'ITR', 'IN TRANSIT', null, 'in_transit'],
      ['2026-03-06T11:25:00', 'BKD', 'BOOKED WITH CARRIER', null, 'in_transit'],
      ['2026-03-05T15:00:00', 'PKU', 'PICKED UP FROM SHIPPER', 'SAMPLEVILLE, GA', 'accepted'],
      ['2026-03-04T10:10:00', 'APS', 'APPT FOR PKU SCHED', null, 'registered'],
      ['2026-03-03T18:00:00', 'ACK', 'PICKUP REQUEST ACKNOWLEDGED BY AGENT', null, 'registered'],
      ['2026-03-03T08:07:00', 'ESN', 'SHIPMENT NOTIFICATION RECEIVED FROM API', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PAT|SAMPLETON|ROBIN|CASEY|EXAMPLE\b|555-0|SAMPLE-REF|75000|THURSDAY|BET|0800|2026-03-12"/);
    // A delivery row the page lists under a later row still settles the shipment, with its own clock.
    const later = parseTeam(withRows(fixture('delivered'), [['ITR', '20260312', '1450', 'IN TRANSIT'], ['POD', '20260312', '1440', 'SIGNED FOR BY: PAT SAMPLETON']]), DELIVERED);
    expect(later).toMatchObject({ current_stage: 'delivered', last_status_text: 'SIGNED FOR', last_update_local: '2026-03-12T14:40:00' });
  });

  it('reads an in-transit history, and the estimate from the newest delivery appointment, else the header', () => {
    const result = parseTeam(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'FREIGHT RECOVERED', last_update: null, last_update_local: '2026-10-19T09:30:00', expected_delivery: '2026-10-23',
    });
    expect(events(result)).toEqual([
      ['2026-10-19T09:30:00', 'RCU', 'FREIGHT RECOVERED', null, 'in_transit'],
      ['2026-10-16T20:10:00', 'ITR', 'IN TRANSIT', null, 'in_transit'],
      ['2026-10-15T17:57:00', 'REQ', 'PICKUP REQUESTED', null, 'registered'],
      ['2026-10-15T15:48:00', 'CPR', 'CUSTOMER PICKUP REQUESTED', null, 'registered'],
      ['2026-10-15T12:57:00', 'NEW', 'SHIPMENT CREATED', null, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|46000|555-0/);
    const booked = withRows(fixture('in-transit'), [
      ['ADS', '20261020', '0824', 'APPT FOR DEL SCHED 20261022 BY 1700 SAMPLE/JFK'],
      ['ADS', '20261019', '1100', 'APPT FOR DEL SCHED 20261021 BET 0800-1200'],
      ['RCU', '20261019', '0930', 'FREIGHT RECOVERED'],
    ]);
    expect(parseTeam(booked, IN_TRANSIT)).toMatchObject({ last_status_text: 'APPT FOR DEL SCHED', expected_delivery: '2026-10-22' });
    expect(JSON.stringify(parseTeam(booked, IN_TRANSIT))).not.toMatch(/SAMPLE|JFK|1700/);
    // A pickup appointment is no delivery estimate, and a day before the newest row's is stale.
    expect(parseTeam(withRows(fixture('in-transit'), [['APS', '20261020', '0954', 'APPT FOR PKU SCHED 20261028 BET 0800-1600']]), IN_TRANSIT))
      .toMatchObject({ expected_delivery: '2026-10-23' });
    expect(parseTeam(withRows(fixture('in-transit'), [['ITR', '20261020', '0954', 'IN TRANSIT'],
      ['ADS', '20261019', '1100', 'APPT FOR DEL SCHED 20261019 BET 0800-1200']]), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    expect(parseTeam(fixture('in-transit').replace('2026-10-23', '2026-10-18'), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    // The estimated arrival at the destination station is not a delivery estimate.
    const terminal = fixture('in-transit').replace('*Requested Delivery', '*Est Arrival DST Terminal');
    expect(parseTeam(terminal, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', expected_delivery: null });
  });

  it('takes the further of the newest staged row and the header, and reads a remark-only or empty history from the header', () => {
    // The header ahead of every row is the current state, without a clock.
    const out = parseTeam(status(fixture('in-transit'), 'OUT FOR DELIVERY'), IN_TRANSIT);
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'OUT FOR DELIVERY',
      expected_delivery: '2026-10-23' });
    expect(out).not.toHaveProperty('last_update_local');
    expect(parseTeam(status(fixture('in-transit'), 'DELIVERED'), IN_TRANSIT)).toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED',
      expected_delivery: null });
    // A header behind the newest staged row does not step it back.
    expect(parseTeam(status(fixture('in-transit'), 'RCVD FR SHPR'), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'FREIGHT RECOVERED' });
    // The remark the header points to is left out, so the remark-only history is the header's.
    const remarks = parseTeam(withRows(status(fixture('in-transit'), '(SEE REMARKS)'), [['CMT', '20261019', '0757', 'S/U FOR DELIVERY 10/23 SAMPLE']]), IN_TRANSIT);
    expect(remarks).toMatchObject({ status: 'unknown', last_status_text: '(SEE REMARKS)', summary_only: true, events: [] });
    expect(remarks).not.toHaveProperty('current_stage');
    expect(parseTeam(withRows(status(fixture('in-transit'), 'RCVD FR SHPR'), [['ESN', '20261015', '1022', 'SHIPMENT NOTIFICATION RECEIVED FROM API']]), IN_TRANSIT))
      .toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'SHIPMENT NOTIFICATION RECEIVED FROM API' });
    expect(() => parseTeam(withRows(status(fixture('in-transit'), ''), []), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(parseTeam(withRows(fixture('in-transit'), []), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'IN TRANSIT', summary_only: true });
  });

  it('cuts free text after a row’s wording unless it names a town and its state', () => {
    const result = parseTeam(withRows(fixture('in-transit'), [
      ['RCU', '20261019', '0930', 'FREIGHT RECOVERED - CALLED SAMPLE'],
      ['ITR', '20261016', '2010', 'IN TRANSIT - CALLED SAMPLE - SAMPLE CITY, IN'],
      ['XYZ', '20261016', '1010', 'Sample Note'],
    ]), IN_TRANSIT);
    expect(events(result)).toEqual([
      ['2026-10-19T09:30:00', 'RCU', 'FREIGHT RECOVERED', null, 'in_transit'],
      ['2026-10-16T20:10:00', 'ITR', 'IN TRANSIT', 'SAMPLE CITY, IN', 'in_transit'],
      // A code the map does not know keeps its wording, without a stage.
      ['2026-10-16T10:10:00', 'XYZ', 'Sample Note', null, null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/CALLED/);
  });

  it('reads the notice for a bill Team Trac has no status for as not found, and answers about other bills as no answer', () => {
    expect(() => parseTeam(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTeam(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Team Trac answered for another bill' }));
    expect(() => parseTeam(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Team Trac answered for another bill' }));
    // Each bill has its own block; the one asked is read, whatever the others say.
    const several = (first: string, second: string) => fixture('not-found').replace(ANSWER, () => first + second);
    const notice = answer(fixture('not-found'));
    expect(parseTeam(several(notice, answer(fixture('in-transit'))), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(parseTeam(several(answer(fixture('delivered')), answer(fixture('in-transit'))), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(() => parseTeam(several(notice, answer(fixture('delivered'))), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTeam(several(answer(fixture('in-transit')), answer(fixture('in-transit'))), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Team Trac answered with several shipments for the bill' }));
    expect(() => parseTeam(fixture('not-found').replaceAll(UNKNOWN, OTHER), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page prints the bill in capitals.
    expect(parseTeam(fixture('in-transit').replace(`<th class="data">${IN_TRANSIT}</th>`, `<th class="data">${IN_TRANSIT.toLowerCase()}</th>`), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed page', () => {
    for (const rows of [
      [['RCU', '20261019', '0930']],
      [['', '20261019', '0930', 'FREIGHT RECOVERED']],
      [['RCU-1', '20261019', '0930', 'FREIGHT RECOVERED']],
      [['RCU', '2026-10-19', '0930', 'FREIGHT RECOVERED']],
      [['RCU', '20260230', '0930', 'FREIGHT RECOVERED']],
      [['RCU', '20261019', '2400', 'FREIGHT RECOVERED']],
      [['RCU', '20261019', '9:30', 'FREIGHT RECOVERED']],
      [['RCU', '20261019', '', 'FREIGHT RECOVERED']],
      [['RCU', '20261019', '0930', '']],
      Array.from({ length: 301 }, () => ['ITR', '20261016', '2010', 'IN TRANSIT']),
    ] as [string, string, string, string][][]) {
      expect(() => parseTeam(withRows(fixture('in-transit'), rows), IN_TRANSIT), JSON.stringify(rows[0])).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const html of [
      fixture('in-transit').replace('<th class="tracright">Team Bill #</th>', '<th class="tracright">Bill</th>'),
      fixture('in-transit').replace(`<th class="data">${IN_TRANSIT}</th>`, '<th class="data"></th>'),
      fixture('in-transit').replace('<td class="tracright">Status</td>', '<td class="tracright">State</td>'),
      fixture('in-transit').replace('<td class="tracright">Delivery To</td>', ''),
      fixture('in-transit').replace('<div class="statusDetail">', '<div class="statusDetail"><table><tbody></tbody></table>'),
      fixture('in-transit').replace('<div class="trac">', '<div class="trac"><table></table>'),
      fixture('not-found').replace('Status is not available for Team Bill #', 'Sample notice for'),
      // The search form alone answers nothing.
      fixture('not-found').replace(ANSWER, ''),
      fixture('not-found').replace(ANSWER, () => answer(fixture('not-found')).repeat(51)),
      '<html><head><title>TeamTrac - Team Worldwide</title></head><body></body></html>',
    ]) {
      expect(() => parseTeam(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown bill, a moved page, a firewall block, an empty page and a broken page apart', async () => {
    const lookup = (respond: () => Response) => carrier(answering(respond)).track({ number: UNKNOWN });
    await expect(carrier(page('not-found')).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => reply('<html><title>404</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(null, { status: 301, headers: { Location: 'https://www.teamww.com/tracking/team-trac/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(BLOCKED, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script></body></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(' \n'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('<html><title>TeamTrac - Team Worldwide</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (code, kind) => {
      const fetcher = answering(() => reply('<html><body>Sample error</body></html>', { status: code }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known bill and the unknown answer, and asks nothing for a number Team does not issue', async () => {
    // A local clock dates the last activity without an instant.
    await expect(carrier(page('delivered')).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T14:40:00' });
    await expect(carrier(page('not-found')).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(BLOCKED))).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // A page for another bill is no answer either way.
    await expect(carrier(page('delivered')).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('ZZZ10000')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Team does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ZZZ10000', 'ZZZ1000011', 'ZZ1000011', '100000001', 'ZZZ100001AB', '2ZZZC100001', '26ZZZ1100001', '26ZZZC10000',
      'ZZZM1000000R', 'ZZZM100000011', 'ZZZ100001/2', `${DELIVERED}${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [raw, number] of [['zzz100001', DELIVERED], ['ZZZ 100001', DELIVERED], ['zzz100001a', 'ZZZ100001A'], ['26zzzc100007', '26ZZZC100007'],
      ['26-ZZZC-100007', '26ZZZC100007'], ['zzzm10000007r', 'ZZZM10000007R'], ['ZZZM10000007', 'ZZZM10000007']]) {
      expect(normalizeTeamNumber(raw!), raw).toBe(number);
    }
  });

  it('tries a lookup that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a bill the caller names Team’s to the adapter', async () => {
    const fetcher = page('delivered');
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'team-worldwide' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'team-worldwide', source: 'team-worldwide', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === TEAM_TRAC && init?.body === `hbl=${DELIVERED}&srn=&con=`)).toBe(true);
  });
});

describe('Team Worldwide numbers', () => {
  it('leaves Team bills to the caller’s choice, and reads Team Trac links of either page', () => {
    // Station codes are airport codes other carriers print too, so neither detection nor recognition offers Team.
    for (const number of [DELIVERED, '26ZZZC100007', 'ZZZM10000007R']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('team-worldwide');
      expect(recognitionAskedCarriers(number), number).not.toContain('team-worldwide');
    }
    for (const link of [`https://www.teamww.com/wp-content/tracking/teamTrac.php?hbl=${DELIVERED}`,
      `https://teamww.com/tracking/team_trac_results.php?hbl=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'team-worldwide', source: 'link' });
    }
  });
});

describe('Team Worldwide status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives, and the codes it leaves out', () => {
    const gaps = new Set(statusMap.gaps.flatMap((gap) => gap.code ?? []));
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? null;
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(teamStage(code, entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
      // Every code seen either has a stage or is left out on purpose.
      if (code) expect(Boolean(entry.stage) !== gaps.has(code), entry.wording).toBe(true);
      expect(entry.unmapped === true, entry.wording).toBe(!entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'team-worldwide', providerCode: 'OFD', description: 'OUT FOR DELIVERY' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'team-worldwide', providerCode: 'FRE', description: 'RESCHEDULING' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'team-worldwide', providerCode: 'XYZ', description: 'Sample Note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to its wording, then to the shared rules, else stays without a stage.
    expect(teamStage('XYZ', 'IN TRANSIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(teamStage('XYZ', 'Out for delivery today')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(teamStage('XYZ', 'Sample Note')).toBeNull();
    expect(teamStage(null, '(SEE REMARKS)')).toBeNull();
  });
});
