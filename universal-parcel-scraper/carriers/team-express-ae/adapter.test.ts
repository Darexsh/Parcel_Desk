import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TEAM_EXPRESS_ENDPOINT, TeamExpressTracker } from './adapter.js';
import { parseTeamExpress } from './parser.js';
import { statusMap, teamExpressMappedStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RAKPOS12345679';
const EXPORT = 'SMART1234567';
const TRANSIT = 'SMART0000000';
const UNKNOWN = 'RAKPOS00000000';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseTeamExpress>) => result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.stage]);
// One row of the history, as the page renders it.
const ROW = /<tr>\s*<td align="left">[\s\S]*?<\/tr>/g;
const BLOCK = /<div class="track_details">[\s\S]*?<\/table>\s*<\/div>/;
// The in-transit export with its newest scan's status and details replaced.
const scan = (code: string, details: string) => page('in-transit')
  .replace('<td align="left">OTHERS</td>\n                                    <td align="left">FORWARDED TO DESTINATION</td>',
    `<td align="left">${code}</td><td align="left">${details}</td>`);
// The export with another forwarding row.
const forwarded = (number: string, link: string) => page('export-delivered')
  .replace(/<strong>12345678903&nbsp;[\s\S]*?<\/a>/, `<strong>${number}&nbsp;&nbsp;&nbsp;<a href="${link}" id="button" class="btn-search">View Details</a>`);
const CAPTCHA = '<html><body><form method="POST"><div class="g-recaptcha" data-sitekey="synthetic"></div></form></body></html>';
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';
const PRIVATE = ['Ima', 'Recipient', '000000000000000', 'SAMPLE OASIS', 'Deira', 'NA -', '02/03/2026', '12:05 PM', 'Team Express', 'partner-courier'];

describe('Team Express tracking adapter', () => {
  it('asks the tracking page once for the whole airwaybill through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TeamExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rakpos 1234-5679 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://teamexpressme.com/tracking?trackno=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'team-express-ae', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery newest first as wall clocks, without the reference, the origin, the signatory or the delivery date', () => {
    const result = parseTeamExpress(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-03-03T12:05:00', expected_delivery: null,
      service_name: 'NEXT DAY DELIVERY - NDD', destination_country: 'AE',
      events: [
        { local_time: '2026-03-03T12:05:00', location: 'EXAMPLETOWN', description: 'DELIVERED', provider_code: 'DELIVERED',
          stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T09:10:00', location: 'EXAMPLETOWN', description: 'OUT FOR DELIVERY', provider_code: 'OUT FOR DELIVERY',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T22:45:00', location: 'DUBAI - SAMPLE HUB', description: 'SHIPMENT ARRIVED AT HUB FACILITY',
          provider_code: 'SHIPMENT ARRIVED AT HUB FACILITY', stage: 'in_transit', stage_source: 'carrier_map' },
        // A scan without a place, just after midnight.
        { local_time: '2026-03-02T00:30:00', description: 'SHIPMENT INFORMATION RECEIVED', provider_code: 'SHIPMENT INFORMATION RECEIVED',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('takes an export’s delivery abroad from the summary and hands it to the partner its link names', () => {
    const result = parseTeamExpress(page('export-delivered'), EXPORT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', provider_code: 'Delivered', last_update: null, last_update_local: '2026-01-12T20:20:00',
      service_name: 'Export Non Dox', destination_country: 'IN', delivery_carrier: 'blue-dart', delivery_tracking_number: '12345678903' });
    expect(rows(result)).toEqual([
      ['2026-01-12T20:20:00', 'OTHERS', 'FORWARDED TO DESTINATION', 'in_transit'],
      ['2026-01-12T19:47:00', 'In Transit', 'Shipment Collected at Despatch Center', 'accepted'],
      ['2026-01-11T12:06:00', 'Collected', 'Shipment Collected from Shipper', 'accepted'],
    ]);
    // The despatch center's scan names the company, not a place.
    expect(result.events!.map((event) => event.location)).toEqual(['DUBAI', undefined, 'Dubai']);
    expect(result.delivered_at).toBeUndefined();
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('reads an export on its way by its scans, without a partner its own number or an unknown link names', () => {
    const result = parseTeamExpress(page('in-transit'), TRANSIT);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'FORWARDED TO DESTINATION', last_update: null, last_update_local: '2025-12-31T23:58:00', expected_delivery: null,
      service_name: 'Export Non Dox', destination_country: 'CN',
      events: [
        { local_time: '2025-12-31T23:58:00', location: 'DUBAI', description: 'FORWARDED TO DESTINATION', provider_code: 'OTHERS',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-12-31T19:33:00', description: 'Shipment Collected at Despatch Center', provider_code: 'In Transit',
          stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('names a partner only when its link is one catalog carrier’s and the number has that carrier’s shape', () => {
    const facts = (html: string) => {
      const { delivery_carrier, delivery_tracking_number } = parseTeamExpress(html, EXPORT);
      return { delivery_carrier, delivery_tracking_number };
    };
    const none = { delivery_carrier: undefined, delivery_tracking_number: undefined };
    expect(facts(forwarded('12345678903', 'https://www.bluedart.com/tracking?trackNo=12345678903')))
      .toEqual({ delivery_carrier: 'blue-dart', delivery_tracking_number: '12345678903' });
    // No link, a link no catalog carrier owns, a number outside the partner's shape, a link back to Team Express.
    expect(facts(forwarded('12345678903', ''))).toEqual(none);
    expect(facts(forwarded('12345678903', 'http://www.partner-courier.example/tracking.aspx'))).toEqual(none);
    expect(facts(forwarded('12345678900', 'https://www.bluedart.com/tracking?trackNo=12345678900'))).toEqual(none);
    expect(facts(forwarded('ABCD0000', 'https://www.bluedart.com/tracking?trackNo=ABCD0000'))).toEqual(none);
    expect(facts(forwarded(EXPORT, 'https://www.bluedart.com/tracking'))).toEqual(none);
    expect(facts(forwarded('SMART0000000', `https://teamexpressme.com/tracking?trackno=SMART0000000`))).toEqual(none);
    expect(facts(page('export-delivered').replace(/<tr>\s*<th align="left">Forwarding Number[\s\S]*?<\/tr>/, ''))).toEqual(none);
  });

  it('turns an oldest-first history round and keeps a repeated scan once', () => {
    const html = page('delivered');
    const scans = html.match(ROW)!;
    expect(scans).toHaveLength(4);
    let reversed = html;
    scans.forEach((row, index) => { reversed = reversed.replace(row, `@@${index}@@`); });
    scans.forEach((_, index) => { reversed = reversed.replace(`@@${index}@@`, scans[scans.length - 1 - index]!); });
    expect(parseTeamExpress(reversed, DELIVERED)).toEqual(parseTeamExpress(html, DELIVERED));
    expect(parseTeamExpress(html.replace(scans[1]!, scans[1]! + scans[1]!), DELIVERED)).toEqual(parseTeamExpress(html, DELIVERED));
  });

  it('stages unknown details by the shared rules or leaves them without a stage', () => {
    expect(parseTeamExpress(scan('OTHERS', 'Shipment delivered'), TRANSIT))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language' });
    const unknown = parseTeamExpress(scan('OTHERS', 'Remarks Updated'), TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Remarks Updated' });
    expect(unknown.events![0]).toEqual({ local_time: '2025-12-31T23:58:00', location: 'DUBAI', description: 'Remarks Updated', provider_code: 'OTHERS' });
    // A status without details stands for them.
    expect(parseTeamExpress(scan('OUT FOR DELIVERY', ''), TRANSIT).events![0])
      .toMatchObject({ description: 'OUT FOR DELIVERY', provider_code: 'OUT FOR DELIVERY', stage: 'out_for_delivery' });
  });

  it('reads the summary alone when the page lists no scan', () => {
    const bare = (html: string) => html.replace(ROW, '');
    expect(parseTeamExpress(bare(page('delivered')), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'DELIVERED',
      provider_code: 'DELIVERED', last_update: null, expected_delivery: null, service_name: 'NEXT DAY DELIVERY - NDD',
      destination_country: 'AE', summary_only: true, events: [],
    });
    // A current status the map does not know, or none, leaves nothing to report.
    expect(() => parseTeamExpress(bare(page('in-transit')), TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseTeamExpress(bare(page('delivered')).replace(/<tr>\s*<th align="left">Current Status[\s\S]*?<\/tr>/, ''), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('binds the page to the requested airwaybill and rejects pages it cannot read', () => {
    expect(() => parseTeamExpress(page('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTeamExpress(page('in-transit'), EXPORT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker shows the airwaybill in capitals; another case is the same one.
    expect(parseTeamExpress(page('in-transit').replace(`<strong>${TRANSIT}</strong>`, '<strong>smart0000000</strong>'), TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    const block = page('delivered').match(BLOCK)![0];
    const row = page('delivered').match(ROW)![0];
    expect(() => parseTeamExpress(page('delivered').replace(block, block + block), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Another shipment beside it does not hide the one asked.
    expect(parseTeamExpress(page('delivered').replace(block, block.replace(DELIVERED, UNKNOWN) + block), DELIVERED))
      .toEqual(parseTeamExpress(page('delivered'), DELIVERED));
    for (const html of [
      page('delivered').replace(/<tr>\s*<th width="150" align="left">Airwaybill No[\s\S]*?<\/tr>/, ''),
      page('delivered').replace('03/03/2026</td>', '31/02/2026</td>'),
      page('delivered').replace('12:05 PM</td>', '13:05 PM</td>'),
      page('delivered').replace('12:05 PM</td>', '12:05</td>'),
      page('delivered').replace('03/03/2026</td>', '2026-03-03</td>'),
      page('delivered').replace(/<td align="left">EXAMPLETOWN&nbsp;<\/td>/, ''),
      page('delivered').replace(row, row.replace(/<td align="left">DELIVERED<\/td>/g, '<td align="left"></td>')),
      page('delivered').replace('</table>\n                  </div>', `</table>${block.match(/<table width="100%"[\s\S]*?<\/table>/)![0]}</div>`),
      page('delivered').replace(row, row.repeat(301)),
      page('delivered').replace(/<input type="text" class="form-control" name="trackno" id="trackno"\/>/, ''),
      '<html><body>Maintenance</body></html>']) {
      expect(() => parseTeamExpress(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the form alone as inconclusive, and a bot check as a challenge', () => {
    expect(() => parseTeamExpress(page('empty'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of [CAPTCHA, CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseTeamExpress(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes SMART and seven digits or RAKPOS and eight only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SMART123456', 'SMART12345678', 'RAKPOS1234567', 'RAKPOS123456789', 'SMARTA123456', '1234567', 'ABC1234567',
      '', `SMART${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    for (const html of [CAPTCHA, CHALLENGE]) {
      const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(html));
      await expect(carrier(challenged).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    }
    const redirected = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302,
      headers: { Location: 'https://teamexpressme.com/' } }));
    await expect(carrier(redirected).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '  ']) {
      const empty = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(empty).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const form = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('empty')));
    await expect(carrier(form).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('in-transit')));
    await expect(carrier(flaky).track({ number: TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('empty')));
    await expect(carrier(immediate).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: UNKNOWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes its links to the adapter, and claims no number layout', async () => {
    for (const number of [DELIVERED, EXPORT, TRANSIT]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('team-express-ae');
      expect(recognitionAskedCarriers(number), number).not.toContain('team-express-ae');
    }
    expect(parseTrackingInput(`https://teamexpressme.com/tracking?trackno=${EXPORT}`))
      .toMatchObject({ trackingNumber: EXPORT, carrier: 'team-express-ae', source: 'link' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'team-express-ae' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'team-express-ae', source: 'team-express-ae', result: { current_stage: 'delivered' } });
    expect(answer.result.receiver_name).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(TEAM_EXPRESS_ENDPOINT))).toBe(true);
  });
});

describe('Team Express status vocabulary', () => {
  it('records every status and detail the map knows, with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code : '';
      expect(teamExpressMappedStage(code, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(parseTeamExpress(scan(code, entry.wording), TRANSIT).events![0]!.stage, entry.wording).toBe(entry.stage);
    }
    // The details decide before their status: the despatch center's scan is filed under "In Transit".
    expect(teamExpressMappedStage('In Transit', 'Shipment Collected at Despatch Center')).toBe('accepted');
    expect(teamExpressMappedStage('In Transit', 'Departed facility')).toBe('in_transit');
    for (const [code, wording] of [['OTHERS', 'Remarks Updated'], ['constructor', 'toString'], ['', 'Shipment']]) {
      expect(teamExpressMappedStage(code!, wording!), wording).toBeUndefined();
    }
    expect(statusMapAnswer({ carrier: 'team-express-ae', providerCode: 'OTHERS', description: 'FORWARDED TO DESTINATION' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
