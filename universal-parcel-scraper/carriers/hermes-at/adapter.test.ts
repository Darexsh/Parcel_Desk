import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HERMES_AT_TRACKER, HermesAtTracker } from './adapter.js';
import { normalizeHermesAtNumber, parseHermesAt } from './parser.js';
import { hermesAtStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '10000000000001';
const CROSS_BORDER = '10000000000002';
const H_NUMBER = 'H1000000000000000002';
const IN_BOX = '1000000000000000000003';
const UNKNOWN = '10000000000004';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const html = fixture(name);
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The ${name} fixture has no ${String(from)}`);
  return next;
};
const row = (clock: string, wording: string, where = '&Ouml;sterreich') =>
  `<tr class=""><td>${clock} Uhr</td><td>${wording}<br>\n\t\t\t\t\t\t\t\tOrt: ${where}<br></td></tr>`;
// A row put in as the newest, right under the table's heading.
const newest = (name: string, ...rows: string[]) => changed(name, '<tr><th>Zeit</th><th>Status</th></tr>', `<tr><th>Zeit</th><th>Status</th></tr>${rows.join('')}`);
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hermes Austria HTTP adapter', () => {
  it('opens the tracker’s page for the number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HermesAtTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0000 0000 01 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HERMES_AT_TRACKER}${DELIVERED}/`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de-AT,de', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hermes-at', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery after a post office collection newest first, in Vienna’s winter time', () => {
    const result = parseHermesAt(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Sendung an Empfänger übergeben', last_update: '2026-01-12T14:05:10+01:00', expected_delivery: null,
      delivered_at: '2026-01-12T14:05:10+01:00', destination_country: 'AT' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-01-12T14:05:10+01:00', 'Sendung an Empfänger übergeben', 'Musterstadt, Österreich', 'delivered'],
      ['2026-01-12T10:30:00+01:00', 'Sendung in Post-Geschäftsstelle abholbereit', 'Österreich', 'ready_for_pickup'],
      ['2026-01-12T09:12:44+01:00', 'Empfänger nicht angetroffen - benachrichtigt', 'Österreich', 'failed_attempt'],
      // The repeated scan is kept once.
      ['2026-01-12T07:40:02+01:00', 'Sendung in Zustellung', 'Österreich', 'out_for_delivery'],
      ['2026-01-11T22:15:31+01:00', 'Sendung in Sortierung', 'Beispielhof, Österreich', 'in_transit'],
      // "undetermined" stands for no place.
      ['2026-01-11T22:10:05+01:00', 'Eingang Logistikzentrum', 'Österreich', 'in_transit'],
      // A PaketShop whose number lost its closing bracket gets it back.
      ['2026-01-10T16:20:00+01:00', 'Sendung an Dienstleister übergeben', 'Hermes Paketshop (000001), Österreich', 'in_transit'],
      ['2026-01-09T11:02:33+01:00', 'Sendung vom Kunden am PaketShop abgegeben', 'Hermes Paketshop (000001), Österreich', 'accepted'],
      ['2026-01-08T18:45:00+01:00', 'Sendung wurde Hermes elektronisch angekündigt', 'Hermes Datenverarbeitung, Österreich', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The progress rail is no scan.
    expect(JSON.stringify(result)).not.toMatch(/Abgabe \/ Abholung|Transport zum/);
  });

  it('reads a parcel from abroad under either of its numbers, keeping a clock local where it differs from Vienna’s', () => {
    for (const number of [CROSS_BORDER, H_NUMBER, H_NUMBER.toLowerCase()]) {
      const result = parseHermesAt(fixture('cross-border'), number);
      expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Sendung in Zustellung',
        last_update: '2026-06-04T06:51:20+02:00', destination_country: 'AT' });
      expect(result.events!.map((event) => [event.time ?? null, event.local_time ?? null, event.location ?? null])).toEqual([
        ['2026-06-04T06:51:20+02:00', null, 'Österreich'],
        ['2026-06-04T02:10:11+02:00', null, 'Österreich'],
        ['2026-06-03T21:41:25+02:00', null, 'Beispielhof, Österreich'],
        ['2026-06-03T21:36:34+02:00', null, 'Österreich'],
        // Germany's clock agrees with Vienna's, so it reads the same in either.
        ['2026-06-02T10:21:26+02:00', null, 'Hermes Germany, Deutschland'],
        ['2026-06-01T18:39:42+02:00', null, 'Beispielstadt, Deutschland'],
        [null, '2026-06-01T09:00:00', 'Esimerkki, Finnland'],
        ['2026-05-31T14:23:20+02:00', null, 'Österreich'],
      ]);
      // Austrian Post's redirect banner names Hermes's fourteen-digit number, which Austrian Post's adapter looks up.
      expect(result).toMatchObject({ delivery_carrier: 'austrian-post', delivery_tracking_number: CROSS_BORDER });
    }
    const local = parseHermesAt(newest('cross-border', row('05.06.2026  08:00:00', 'Sendung in Sortierung', 'Esimerkki, Finnland')), CROSS_BORDER);
    expect(local).toMatchObject({ current_stage: 'in_transit', last_update: null, last_update_local: '2026-06-05T08:00:00' });
  });

  it('hands a parcel to Austrian Post when the page names a number its adapter looks up, and leaves it in a receiving box until taken out', () => {
    const inBox = parseHermesAt(fixture('receiving-box'), IN_BOX);
    expect(inBox).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Sendung in Postempfangsbox zugestellt',
      last_update: '2026-10-15T09:12:00+02:00', delivery_carrier: 'austrian-post', delivery_tracking_number: IN_BOX });
    expect(inBox).not.toHaveProperty('delivered_at');
    expect(deliveryHandoff('hermes-at', IN_BOX, inBox)).toEqual({ carrier: 'austrian-post', number: IN_BOX, basis: 'partner' });
    expect(deliveryHandoff('hermes-at', H_NUMBER, parseHermesAt(fixture('cross-border'), H_NUMBER)))
      .toEqual({ carrier: 'austrian-post', number: CROSS_BORDER, basis: 'partner' });

    const taken = parseHermesAt(newest('receiving-box', row('15.10.2026  17:40:00', 'Sendung aus Postempfangsbox entnommen')), IN_BOX);
    expect(taken).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-10-15T17:40:00+02:00' });
    // A banner for another site, or one without a number, names no leg.
    for (const href of ['https://www.post.at/sendungsverfolgung.php/interaktion?pnum2=1', 'https://www.example.test/sendungsverfolgung.php/interaktion?pnum1=1000000000000000000003']) {
      expect(parseHermesAt(changed('receiving-box', /https:\/\/www\.post\.at\/[^"]+/, href), IN_BOX)).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads a handover after the parcel was sent back as its return to the sender', () => {
    const result = parseHermesAt(changed('delivered', 'Sendung in Post-Gesch&auml;ftsstelle abholbereit ', 'R&uuml;cksendung - Sendung besch&auml;digt'), DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Sendung an Empfänger übergeben' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.slice(0, 2).map((event) => event.stage)).toEqual(['returned', 'exception']);
    // A return label's parcel is sorted as a return on its way to the merchant: its delivery stays one.
    expect(parseHermesAt(changed('delivered', 'Eingang Logistikzentrum ', 'Retoure im Logistikzentrum sortiert'), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('stages a wording it does not know through the shared rules, or leaves it unstaged', () => {
    const worded = parseHermesAt(newest('cross-border', row('05.06.2026  08:00:00', 'Sendung zugestellt beim Nachbarn')), CROSS_BORDER);
    expect(worded.events![0]).toMatchObject({ stage: 'delivered', stage_source: expect.not.stringMatching(/^carrier_map$/) });
    const unstaged = parseHermesAt(newest('cross-border', row('05.06.2026  08:00:00', 'Synthetischer Hinweis')), CROSS_BORDER);
    expect(unstaged).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetischer Hinweis', last_update: '2026-06-05T08:00:00+02:00' });
    expect(unstaged.events![0]).not.toHaveProperty('stage');
  });

  it('keeps only the recipient’s country', () => {
    const result = parseHermesAt(changed('delivered', /(Empf&auml;ngeradresse:<\/span>) &Ouml;sterreich/, '$1 Musterweg 1, 1000 Musterstadt, &Ouml;sterreich'), DELIVERED);
    expect(result).not.toHaveProperty('destination_country');
    expect(JSON.stringify(result)).not.toMatch(/Musterweg|1000 Musterstadt/);
    expect(parseHermesAt(changed('delivered', /(Empf&auml;ngeradresse:<\/span>) &Ouml;sterreich/, '$1 Deutschland'), DELIVERED))
      .toMatchObject({ destination_country: 'DE' });
  });

  it('reads an unknown number as not found, the form alone as inconclusive and a parcel without scans as no history', () => {
    expect(() => parseHermesAt(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHermesAt(changed('not-found', /<div class="headline5">[^<]+<\/div>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHermesAt(changed('delivered', /<tr class="[^"]*"><td>[\s\S]*<\/tr>/, ''), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A row without a wording says nothing about the parcel.
    const bare = parseHermesAt(changed('delivered', /<td>Sendung[^<]*<br>/g, '<td>'), DELIVERED);
    expect(bare.events!.map((event) => event.description)).toEqual([
      'Empfänger nicht angetroffen - benachrichtigt', 'Eingang Logistikzentrum']);
  });

  it('counts a parcel only when it lists the number asked', () => {
    expect(() => parseHermesAt(fixture('delivered'), CROSS_BORDER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Hermes Austria answered for another parcel' }));
  });

  it('rejects a changed page', () => {
    for (const html of [
      '<html><title>Hermes</title><body>Sendungsverfolgung</body></html>',
      fixture('delivered').replace('class="tx-webservices"', 'class="tx-other"'),
      fixture('delivered').replace('</main>', `${fixture('not-found').match(/<div class="tx-webservices"[\s\S]*?<\/form><\/div><\/div>/)![0]}</div></main>`),
      changed('delivered', /<span class="bold">Sendungsnummer\(n\):<\/span>[^<]*/, '<span class="bold">Sendungsnummer(n):</span> '),
      changed('delivered', 'class="hermestabelle sendungsstatus"', 'class="hermestabelle"'),
      changed('delivered', '12.01.2026  14:05:10 Uhr', '12.01.2026, 14:05 Uhr'),
      changed('delivered', '12.01.2026  14:05:10 Uhr', '30.02.2026  14:05:10 Uhr'),
      changed('delivered', '12.01.2026  14:05:10 Uhr', '12.01.2026  24:05:10 Uhr'),
      changed('delivered', '<td>12.01.2026  14:05:10 Uhr</td>', '<td>12.01.2026  14:05:10 Uhr</td><td></td>'),
      changed('delivered', '<tr><th>Zeit</th><th>Status</th></tr>', `<tr><th>Zeit</th><th>Status</th></tr>${row('12.01.2026  14:05:10', 'Sendung zugestellt').repeat(501)}`),
    ]) {
      expect(() => parseHermesAt(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a bot check, maintenance, a moved route and a broken page apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Service nicht verfügbar</title></head><body>Bitte später</body></html>'))
      .rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.myhermes.at/service-nicht-verfuegbar/' } }))
      .rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.myhermes.at/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>myHermes</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a parcel the tracker lists, and no number it says it does not know', async () => {
    const answer = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(page(body))).recognize!(DELIVERED);
    await expect(answer(fixture('delivered'))).resolves.toEqual({ known: true, lastActivityAt: '2026-01-12T13:05:10.000Z' });
    await expect(answer(fixture('not-found'))).resolves.toEqual({ known: false });
    await expect(answer(changed('not-found', /<div class="headline5">[^<]+<\/div>/, ''))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects what is not a Hermes number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', 'SAMPLETRACKING', '10000000000000000000001', '1000000000000/1', `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHermesAtNumber('h1000 0000 0000 0000 002')).toBe(H_NUMBER);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Hermes Austria to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'hermes-at' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'hermes-at', source: 'hermes-at', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${HERMES_AT_TRACKER}${DELIVERED}/`)).toBe(true);
  });
});

describe('Hermes Austria numbers', () => {
  it('is never asked by recognition, since no rule offers Hermes Austria', () => {
    for (const number of [DELIVERED, H_NUMBER, IN_BOX]) expect(recognitionAskedCarriers(number)).not.toContain('hermes-at');
  });
});

describe('Hermes Austria status vocabulary', () => {
  it('records every scan wording the map knows with the stage it gives', () => {
    // The progress rail's steps are recorded too, but are no scans.
    const scans = (statuses.entries as { wording: string; stage: string; note?: string }[]).filter((entry) => !/progress bar/.test(entry.note ?? ''));
    expect(scans).toHaveLength(21);
    for (const entry of scans) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(hermesAtStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'hermes-at', description: 'Sendung in Postempfangsbox zugestellt' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'hermes-at', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(hermesAtStage('Synthetic note')).toBeNull();
  });
});
