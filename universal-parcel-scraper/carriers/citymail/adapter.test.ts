import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CITYMAIL_TRACKING, CitymailTracker } from './adapter.js';
import { normalizeCitymailNumber, parseCitymail } from './parser.js';
import { citymailStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BCMXY900000001';
const IN_TRANSIT = 'BCMQ900000002';
const PICKUP = 'BCMXYZ90000003';
const RETURNED = 'BCMQ900000004';
const UNKNOWN = 'BCMXY900000005';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('CityMail HTTP adapter', () => {
  it('opens the tracker with the reference, through the supplied transport', async () => {
    const fetcher = answering(() => html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CitymailTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bcmxy 900000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CITYMAIL_TRACKING}?search=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'citymail', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a door delivery with Stockholm clocks, without the photo or the recipient’s postcode', () => {
    const result = parseCitymail(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Paketet är utdelat, vid dörr/finns i påse på brevlåda', last_update: '2026-10-27T15:42:00+01:00',
      expected_delivery: null, delivered_at: '2026-10-27T15:42:00+01:00', sender_name: 'Exempelbokhandeln AB', service_name: 'PRIO',
      timezone: 'Europe/Stockholm',
      events: [
        { time: '2026-10-27T15:42:00+01:00', location: 'Exempelby', description: 'Paketet är utdelat, vid dörr/finns i påse på brevlåda',
          stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-10-27T07:05:00+01:00', description: 'Paketet förbereds för leverans', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-10-26T16:31:00+01:00', location: 'Terminal Exempelstad', description: 'Paketet har ankommit till terminal',
          stage: 'in_transit', stage_source: 'carrier_map' },
        // The hour Stockholm's clocks repeat reads as its first occurrence.
        { time: '2026-10-25T02:34:00+02:00', description: 'Paketet har aviserats, men ännu inte lämnats in till CityMail',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/999 01|photos\.example/);
  });

  it('reads a parcel on its way with its estimated delivery day', () => {
    expect(parseCitymail(fixture('in-transit'), IN_TRANSIT)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Paketet förbereds för leverans',
      last_update: '2026-03-10T06:48:00+01:00', expected_delivery: '2026-03-13', sender_name: 'Exempelhandel', service_name: 'BAS',
      events: [{ stage: 'in_transit' }, { location: 'Terminal Exempelstad', stage: 'in_transit' }, { stage: 'registered' }],
    });
  });

  it('names the service point a parcel waits at, and drops it once the parcel goes back', () => {
    const waiting = parseCitymail(fixture('pickup'), PICKUP);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'EXEMPELBUTIKEN', service_name: 'Ombud' });
    expect(waiting.events!.map((event) => event.stage))
      .toEqual(['ready_for_pickup', 'in_transit', 'failed_attempt', 'in_transit', 'in_transit', 'registered']);
    expect(waiting.events![2]).toMatchObject({ location: 'CityMail-kontor Exempelby', description: 'Namn saknades på adressen - leveransen kunde inte genomföras' });
    const collected = parseCitymail(fixture('pickup').replace(/(<tr>\s*<td>)/, '$1Paketet har levererats hem till dig</td><td>2026-05-16 10:00</td><td></td></tr><tr><td>'), PICKUP);
    expect(collected).toMatchObject({ current_stage: 'delivered', pickup_point: 'EXEMPELBUTIKEN', delivered_at: '2026-05-16T10:00:00+02:00' });
    const returned = parseCitymail(fixture('returned'), RETURNED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
    expect(returned).not.toHaveProperty('pickup_point');
    expect(returned).not.toHaveProperty('delivered_at');
  });

  it('leaves a wording the map lacks to the shared rules, and keeps one they cannot read without a stage', () => {
    const unread = parseCitymail(fixture('in-transit').replaceAll('Paketet f&#246;rbereds f&#246;r leverans', 'Xyzzy'), IN_TRANSIT);
    expect(unread).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Xyzzy', events: [{ description: 'Xyzzy' }, { stage: 'in_transit' }, {}] });
    expect(unread.events![0]).not.toHaveProperty('stage');
    // The shared rules have no Swedish; they read wording in the languages they know.
    expect(citymailStage('Paketet är ute för leverans')).toBeNull();
    expect(citymailStage('Out for delivery')).toMatchObject({ stage: 'out_for_delivery', source: expect.stringMatching(/^wording:/) });
  });

  it('orders scans newest first, and reads a parcel without scans from its status', () => {
    const page = fixture('in-transit');
    const rows = page.match(/<tr>\s*<td>[\s\S]*?<\/tr>/g)!;
    const block = page.slice(page.indexOf(rows[0]), page.lastIndexOf(rows.at(-1)!) + rows.at(-1)!.length);
    expect(parseCitymail(page.replace(block, [...rows].reverse().join('\n')), IN_TRANSIT).events!.map((event) => event.time))
      .toEqual(['2026-03-10T06:48:00+01:00', '2026-03-09T18:12:00+01:00', '2026-03-08T14:20:00+01:00']);
    const bare = parseCitymail(page.replace(block, ''), IN_TRANSIT);
    expect(bare).toMatchObject({ current_stage: 'in_transit', summary_only: true, last_update: '2026-03-10T06:48:00+01:00',
      events: [{ time: '2026-03-10T06:48:00+01:00', description: 'Paketet förbereds för leverans' }] });
  });

  it('keeps scans of one minute in the page’s order, whichever way it lists them', () => {
    const page = fixture('in-transit').replace('2026-03-09 18:12', '2026-03-10 06:48');
    const rows = page.match(/<tr>\s*<td>[\s\S]*?<\/tr>/g)!;
    const block = page.slice(page.indexOf(rows[0]), page.lastIndexOf(rows.at(-1)!) + rows.at(-1)!.length);
    const descriptions = (body: string) => parseCitymail(body, IN_TRANSIT).events!.map((event) => event.description);
    expect(descriptions(page.replace(block, [...rows].reverse().join('\n')))).toEqual(descriptions(page));
  });

  it('reads the tracker’s notice for the reference asked as not found', async () => {
    expect(() => parseCitymail(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => html(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses an answer for another reference, or one without the reference, the status or valid clocks', () => {
    expect(() => parseCitymail(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCitymail(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const notice = fixture('not-found').replace(`<span class="green">${UNKNOWN}</span>`, `<span class="green">${DELIVERED}</span>`);
    expect(() => parseCitymail(notice, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const booked = fixture('delivered').replace(new RegExp(`(Ursprunglig paketreferens</b><br />\\s*)${DELIVERED}`), `$1${UNKNOWN}`);
    expect(() => parseCitymail(booked, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      fixture('delivered').replace('Ursprunglig paketreferens', 'Referens'),
      fixture('delivered').replace(/<h4 class="green">[\s\S]*?<\/h4>/, ''),
      fixture('delivered').replace('id="MainForm"', 'id="OtherForm"'),
      fixture('delivered').replace('2026-10-27 07:05', '2026-02-30 07:05'),
      fixture('delivered').replace('2026-10-27 07:05', '27/10/2026 07:05'),
      fixture('delivered').replace('2026-10-27 07:05', '2026-10-27 24:00'),
      fixture('delivered').replace(/<td>\s*Terminal Exempelstad\s*<\/td>/, ''),
      fixture('delivered').replace(/<td>\s*Paketet f&#246;rbereds f&#246;r leverans\s*<\/td>/, '<td></td>'),
      fixture('in-transit').replace('2026-03-13', '13 mars'),
      '<html><body><h1>Server Error in \'/\' Application.</h1></body></html>',
    ]) {
      expect(() => parseCitymail(page, page.includes(IN_TRANSIT) ? IN_TRANSIT : DELIVERED), page.slice(-200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseCitymail(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => html(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Too many requests', { status: 429, headers: { 'Retry-After': '30' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://www.citymail.se/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('<html><body>Runtime Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => html(fixture('delivered').replace('id="MainForm"', 'id="OtherForm"')))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks once more when CityMail cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new CitymailTracker({ fetcher: flaky, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects what is not a parcel reference, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'BCMABCDEFG', 'BCM1234', `BCM${'0'.repeat(40)}`, 'BCMXY90000000é']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCitymailNumber('am 900 000 006')).toBe('AM900000006');
  });

  it('recognizes a known parcel and an unknown reference from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture('delivered'))).mockResolvedValueOnce(html(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-27T14:42:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => html(CHALLENGE))).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('answers a reference filed under CityMail or opened from its tracker’s address', async () => {
    const fetcher = answering(() => html(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'citymail' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'citymail', source: 'citymail', result: { current_stage: 'delivered' } });
    // Detection names CityMail for them at high confidence, so recognition is not needed to settle them.
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'citymail', confidence: 'high', candidates: ['citymail'] });
    expect(recognitionCandidates(DELIVERED)).toEqual([]);
    expect(parseTrackingInput(`https://tracking.citymail.se/?search=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'citymail' });
  });

  it('claims references of BCM, two letters, thirteen digits and CN, and not their near misses', () => {
    const reference = 'BCMXY0000000000001CN';
    expect(normalizeCitymailNumber(reference.toLowerCase())).toBe(reference);
    expect(detectCarrierMatch(reference)).toMatchObject({ carrier: 'citymail', confidence: 'high', candidates: ['citymail'] });
    expect(recognitionCandidates(reference)).toEqual([]);
    for (const number of ['BCMXY000000000001CN', 'BCMXY00000000000001CN', 'BCMX0000000000001CN', 'BCMXYZ0000000000001CN', 'BCMXY0000000000001SE']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('citymail');
    }
  });

  it('proposes no hand-off: the tracker names no other carrier or number', () => {
    expect(deliveryHandoff('citymail', PICKUP, parseCitymail(fixture('pickup'), PICKUP))).toBeNull();
  });
});

describe('CityMail status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(citymailStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'citymail', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('X', 'paketet har levererats hem till dig')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'citymail', description: 'Paketet är ute för leverans' })).toEqual({ kind: 'unknown' });
  });
});
