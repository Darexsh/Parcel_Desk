import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LOGOIX_TRACKING, LogoixTracker } from './adapter.js';
import { normalizeLogoixNumber, parseLogoix } from './parser.js';
import { logoixStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DHL = 'LIX9000000101';
const AUSTRIAN_POST = 'LIX9000000202';
const REGISTERED = 'LIX9000000303';
const UNKNOWN = 'LIX9000000404';
const EXPIRED = 'LIX9000000505';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// The tracker serves ISO-8859-1.
const page = (body: string, init: ResponseInit = {}) => new Response(Buffer.from(body, 'latin1'),
  { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const partnerRow = (name: string, number: string) => `<tr><td></td><td><b style='color:blue;'>LogoiX Transportpartner: ${name}<br>Lieferanten-Paketnummer: ${number}</b></td></tr>`;
const withPartner = (name: string, number: string) => fixture('dhl').replace(/<tr>\s*<td><\/td>\s*<td>\s*<b style='color:blue;'>[\s\S]*?<\/tr>/, partnerRow(name, number));

describe('LogoiX HTTP adapter', () => {
  it('opens the tracker with the number, through the supplied transport', async () => {
    const fetcher = answering(() => page(fixture('dhl')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LogoixTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' lix 9000-0001-01 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LOGOIX_TRACKING}?q=${DHL}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'logoix', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a counter shipment handed to DHL, newest first in Berlin time, and hands it to DHL', () => {
    const result = parseLogoix(fixture('dhl'), DHL);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Ausgang Verteilzentrum LogoiX', last_update: '2026-10-12T15:34:00+02:00', expected_delivery: null,
      service_name: 'Schalterversand', delivery_carrier: 'dhl', delivery_tracking_number: '340000000018', timezone: 'Europe/Berlin',
      events: [
        { time: '2026-10-12T15:34:00+02:00', description: 'Ausgang Verteilzentrum LogoiX', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-10-12T10:41:00+02:00', description: 'Abfertigung LogoiX Zentrale Freilassing', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The page's hidden row carrying the time of the lookup is no scan.
    expect(JSON.stringify(result)).not.toMatch(/AUTORISIERTE|09:12/);
    expect(deliveryHandoff('logoix', DHL, result)).toEqual({ carrier: 'dhl', number: '340000000018', basis: 'partner' });
  });

  it('reads a forwarded parcel handed to Austrian Post across the clock change, from the page’s own encoding', async () => {
    const result = await carrier(answering(() => page(fixture('austrian-post')))).track({ number: AUSTRIAN_POST });
    expect(result).toMatchObject({
      current_stage: 'in_transit', service_name: 'Nachsendung', last_update: '2026-10-26T14:20:00+01:00',
      delivery_carrier: 'austrian-post', delivery_tracking_number: '1000000000000000000001',
      events: [{ time: '2026-10-26T14:20:00+01:00' }, { time: '2026-10-26T09:58:00+01:00', stage: 'accepted' },
        { time: '2026-10-24T16:05:00+02:00', description: 'Eingang Verteilzentrum LogoiX, in Bearbeitung', stage: 'accepted' }],
    });
    expect(deliveryHandoff('logoix', AUSTRIAN_POST, result)).toEqual({ carrier: 'austrian-post', number: '1000000000000000000001', basis: 'partner' });
  });

  it('reads a booked parcel not yet handed in as registered, its two lines as one scan', () => {
    const result = parseLogoix(fixture('registered'), REGISTERED);
    expect(result).toMatchObject({
      status: 'pending', current_stage: 'registered', service_name: 'Schalterversand',
      // The hour Berlin's clocks repeat reads as its first occurrence.
      last_update: '2026-10-25T02:30:00+02:00',
      events: [{ description: 'Sendungsdaten wurden elektronisch erfasst. Der Versender hat die Sendung noch nicht bei LogoiX zum Versand eingeliefert.',
        stage: 'registered', stage_source: 'carrier_map' }],
    });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(deliveryHandoff('logoix', REGISTERED, result)).toBeNull();
  });

  it('hands off only a whole number the named partner tracks, and only one', () => {
    for (const [name, number] of [['DHL Deutschland', '340000000017'], ['DHL Deutschland', '34000000001'], ['Österreichische Post', '100000000000000000001'],
      ['GLS', '340000000018'], ['DPD', '1000000000000000000001']] as const) {
      const result = parseLogoix(withPartner(name, number), DHL);
      expect(result, `${name} ${number}`).not.toHaveProperty('delivery_carrier');
      expect(result, `${name} ${number}`).not.toHaveProperty('delivery_tracking_number');
      expect(result.events).toHaveLength(2);
    }
    const twice = fixture('dhl').replace(/Lieferanten-Paketnummer: 340000000018[\s\S]*?<\/tr>/, `$&${partnerRow('DHL Deutschland', '340000000024')}`);
    expect(parseLogoix(twice, DHL)).not.toHaveProperty('delivery_carrier');
  });

  it('leaves a wording the map lacks to the shared rules, and keeps one they cannot read without a stage', () => {
    const unread = parseLogoix(fixture('dhl').replace('Ausgang Verteilzentrum LogoiX', 'Xyzzy'), DHL);
    expect(unread).toMatchObject({ current_stage: 'accepted', last_status_text: 'Xyzzy', events: [{ description: 'Xyzzy' }, { stage: 'accepted' }] });
    expect(unread.events![0]).not.toHaveProperty('stage');
    expect(logoixStage('Paket zugestellt')).toMatchObject({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
  });

  it('reads the tracker’s notices for an unknown number and one it no longer has as not found', async () => {
    expect(() => parseLogoix(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLogoix(fixture('expired'), EXPIRED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses an answer for another or several parcels, or one without the number', () => {
    expect(() => parseLogoix(fixture('dhl'), AUSTRIAN_POST)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogoix(fixture('not-found'), DHL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogoix(fixture('dhl').replace(`<h3>Schalterversand ${DHL}`, `<h3>Schalterversand ${AUSTRIAN_POST}`), DHL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogoix(fixture('dhl').replace('<h1>', `<h1>Verlauf der Sendung ${DHL}</h1><h1>`), DHL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogoix(fixture('dhl').replace(`<h1>Verlauf der Sendung ${DHL}`, '<h1>Verlauf der Sendung '), DHL))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a page without a history or with invalid scans, and reads a bot check as a challenge', () => {
    for (const changed of [
      fixture('dhl').replace(/<table bgcolor="#FFFFFF" class="tnttable">\s*<tr style/, '<table class="other"><tr style'),
      fixture('dhl').replace('12.10.2026&nbsp;10:41', '2026-10-12 10:41'),
      fixture('dhl').replace('12.10.2026&nbsp;10:41', '30.02.2026&nbsp;10:41'),
      fixture('dhl').replace('12.10.2026&nbsp;10:41', '12.10.2026&nbsp;24:00'),
      fixture('dhl').replace('<td>Abfertigung LogoiX Zentrale Freilassing</td>', '<td></td>'),
      fixture('dhl').replace('<td>Abfertigung LogoiX Zentrale Freilassing</td>', '<td>Abfertigung</td><td>Extra</td>'),
      '<html><body><h1>Internal Server Error</h1></body></html>',
    ]) expect(() => parseLogoix(changed, DHL), changed.slice(-120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture('registered').replace(/<tr>\s*<td valign="top">[\s\S]*?<\/tr>/, '');
    expect(() => parseLogoix(empty, REGISTERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogoix(CHALLENGE, DHL)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    // The warning row the page hides, shown, is no scan either.
    expect(() => parseLogoix(fixture('dhl').replace('<tr style="display:none;">', '<tr>'), DHL)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DHL });
    await expect(lookup(() => page(fixture('rate-limited'), { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup(() => page(fixture('rate-limited').replace('waittime=10', 'waittime=20')))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 20_000 });
    await expect(lookup(() => page('Too many requests', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup(() => page(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('', { status: 302, headers: { Location: 'https://www.logoix.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => page('<html><body>Internal Server Error</body></html>', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('asks once more when LogoiX cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page(fixture('dhl')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new LogoixTracker({ fetcher: flaky, recorder }).fetch(DHL, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DHL }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects what is not a LogoiX number, the all-zero placeholder and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'LIX900000010', 'LIX90000001011', 'LXX9000000101', '340000000018', 'LIX0000000000', `LIX${'9'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: DHL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLogoixNumber('lix 9000 0001 01')).toBe(DHL);
  });

  it('recognizes a known parcel and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(fixture('dhl'))).mockResolvedValueOnce(page(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DHL)).resolves.toEqual({ known: true, lastActivityAt: '2026-10-12T13:34:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => page(fixture('rate-limited'), { status: 429 }))).recognize!(DHL)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('answers a number filed under LogoiX or opened from its tracker’s address', async () => {
    const fetcher = answering(() => page(fixture('dhl')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DHL, carrier: 'logoix' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'logoix', source: 'logoix', result: { current_stage: 'in_transit', delivery_carrier: 'dhl' } });
    // Detection names LogoiX at high confidence, so preflight asks no recognition.
    expect(detectCarrierMatch(DHL)).toMatchObject({ carrier: 'logoix', confidence: 'high', candidates: ['logoix'] });
    expect(recognitionCandidates(DHL)).toEqual([]);
    expect(parseTrackingInput(`https://www.logoix.com/cgi-bin/tnt.pl?q=${DHL}`)).toMatchObject({ trackingNumber: DHL, carrier: 'logoix' });
  });
});

describe('LogoiX status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of (statuses.entries as { wording: string; stage?: string }[]).filter((item) => item.stage)) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(logoixStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'logoix', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('X', 'ausgang verteilzentrum logoix')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'logoix', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
