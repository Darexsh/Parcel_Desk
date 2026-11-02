import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';
import type { StepRecord, StepRecorder } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { TrawlClient } from '../../core/transport/index.js';
import {
  DPDFranceChallengeError,
  DPDFranceTracker,
  DPDFranceTrackingError,
  adapter,
  dpdFranceTrackingUrl,
  normalizeDPDFranceTrackingNumber,
  parseDPDFranceTrackingHtml,
} from './adapter.js';
import { classifyStatus } from './status.js';

type Row = [date: string, clock: string, description: string, location: string];
type Detail = [label: string, value: string];

// Fully synthetic identifiers paired with provider-shaped HTML. The live suite
// verifies DPD France separately with a privacy-safe wrong-number canary.
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/claim-after-delivery.json', import.meta.url), 'utf8'),
) as {
  outboundNumber: string;
  returnNumber: string;
  outboundDetails: Detail[];
  returnDetails: Detail[];
  outboundRows: Row[];
  returnRows: Row[];
  privateSections: Record<string, string>;
};
const TEST_TRACKING_NUMBER = FIXTURE.outboundNumber;
const TEST_RETURN_NUMBER = FIXTURE.returnNumber;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function detailsBlock(id: string, details: Detail[]): string {
  const rows = details.map(([label, value]) => (
    `<ul class="tableInfosAR"><li><strong>${label}</strong></li><li class="tdInfos">${value}</li></ul>`
  )).join('');
  return `<div id="${id}">${rows}</div>`;
}

function traceRows(className: string, rows: Row[]): string {
  return rows.map(([date, clock, description, location]) => (
    `<tr class="${className}"><td>${date}</td><td>${clock}</td><td>${description}</td><td>${location}</td></tr>`
  )).join('');
}

function trackingFixture(overrides: {
  outboundNumber?: string;
  outboundRows?: Row[];
  outboundDetails?: Detail[];
} = {}): string {
  const outboundNumber = overrides.outboundNumber ?? TEST_TRACKING_NUMBER;
  const outboundDetails = (overrides.outboundDetails ?? FIXTURE.outboundDetails)
    .map(([label, value]): Detail => (label === 'N° colis' ? [label, outboundNumber] : [label, value]));
  const privateSections = Object.entries(FIXTURE.privateSections)
    .map(([id, value]) => `<div id="${id}">${value}</div>`).join('');
  return `<!doctype html><html><body>
    <div id="iconsAller">
      <span class="infosTitle parcelNumberAller">Votre colis ${outboundNumber}</span>
    </div>
    <span class="parcelNumberRetour">Votre colis ${TEST_RETURN_NUMBER}</span>
    ${detailsBlock('infos1', outboundDetails)}
    ${detailsBlock('infos2', FIXTURE.returnDetails)}
    <table id="tableTrace">
      ${traceRows('tabTraceColisAller', overrides.outboundRows ?? FIXTURE.outboundRows)}
      ${traceRows('tabTraceColisRetour', FIXTURE.returnRows)}
    </table>
    ${privateSections}
  </body></html>`;
}

function recordingRecorder(): { recorder: StepRecorder; steps: StepRecord[] } {
  const steps: StepRecord[] = [];
  return { steps, recorder: { step: (record) => { steps.push(record); }, lookup() {} } };
}

afterEach(() => vi.restoreAllMocks());

describe('DPD France tracking input', () => {
  it('accepts the official 12-to-15-digit formats and builds the public URL', () => {
    expect(normalizeDPDFranceTrackingNumber('1059 4002 3786 11')).toBe('10594002378611');
    expect(normalizeDPDFranceTrackingNumber('250.123.456.789.012')).toBe(TEST_TRACKING_NUMBER);
    expect(normalizeDPDFranceTrackingNumber('012345678901')).toBe('012345678901');
    expect(dpdFranceTrackingUrl(TEST_TRACKING_NUMBER))
      .toBe(`https://trace.dpd.fr/fr/trace/${TEST_TRACKING_NUMBER}`);
  });

  it('looks a label barcode up by its parcel number when the GS1 check digit matches', () => {
    expect(normalizeDPDFranceTrackingNumber('2501 2345 6789 0127')).toBe(TEST_TRACKING_NUMBER);
    expect(dpdFranceTrackingUrl('2501234567890127'))
      .toBe(`https://trace.dpd.fr/fr/trace/${TEST_TRACKING_NUMBER}`);
    expect(() => normalizeDPDFranceTrackingNumber('2501234567890128')).toThrow('12 to 15 digits');
  });

  it('rejects unsafe or non-France identifiers', () => {
    for (const value of [
      '25012345678',
      '2501234567890120',
      '350123456789012',
      '25012345678901A',
      '250123456789012?admin=true',
    ]) {
      expect(() => normalizeDPDFranceTrackingNumber(value)).toThrow('12 to 15 digits');
    }
  });
});

describe('DPD France rendered tracking', () => {
  it('parses a provider-shaped fixture and excludes private page sections', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture(), TEST_TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Nous avons reçu une réclamation : une enquête est ouverte',
      last_update: '2026-02-12T09:50:00+01:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2026-02-12T09:50:00+01:00',
        location: 'Agence DPD de La Crau (283)',
        description: 'Nous avons reçu une réclamation : une enquête est ouverte',
        stage: 'exception',
        point: { latitude: 43.1512, longitude: 6.0712 },
      },
      {
        time: '2026-01-23T12:45:00+01:00',
        // The cell repeats the delivery, which is no place.
        location: '',
        description: 'Votre colis est livré',
        stage: 'delivered',
      },
      {
        time: '2026-01-23T08:31:00+01:00',
        location: 'Agence DPD de La Crau (283)',
        description: 'Votre colis est en cours de livraison',
        stage: 'out_for_delivery',
        point: { latitude: 43.1512, longitude: 6.0712 },
      },
      {
        time: '2026-01-22T16:16:00+01:00',
        location: 'Centre de tri DPD de Le Coudray (175)',
        description: 'Votre colis est arrivé en France',
        stage: 'in_transit',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'private-order-reference',
      'Private return event',
      'Private Street',
      'Private Recipient',
      'private@example.test',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('returns every declared capability from one fixture', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: FIXTURE.outboundRows.slice(2),
    }), TEST_TRACKING_NUMBER);

    const delivered = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: FIXTURE.outboundRows.slice(1),
    }), TEST_TRACKING_NUMBER);

    expect(CAPABILITIES).toEqual(['history', 'location', 'eta', 'delivered_at']);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.expected_delivery).toBe('2026-01-24');
    expect(delivered).toMatchObject({ status: 'delivered', delivered_at: '2026-01-23T12:45:00+01:00' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the shorter rows and the weight of earlier trace pages', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundDetails: [['N° colis', TEST_TRACKING_NUMBER], ['Poids du colis', '1.2 Kg'], ['Livré le', '09/01/2026']],
      outboundRows: [
        ['09/01/2026', '12:37', 'Colis livré', 'Relais Pickup'],
        ['08/01/2026', '16:54', 'Le destinataire est informé que son colis est disponible au point relais Pickup', 'Relais Pickup'],
        ['08/01/2026', '16:53', 'Colis à disposition du destinataire au point relais Pickup', 'Relais Pickup'],
        ['07/01/2026', '10:57', 'Livraison reportée, prise de rendez-vous nécessaire', 'Agence DPD de La Crau (283)'],
        ['06/01/2026', '08:56', 'En attente de vos instructions', ''],
        ['05/01/2026', '17:10', 'Colis refusé, en attente de vos instructions', 'Agence DPD de La Crau (283)'],
        ['05/01/2026', '08:38', 'Colis en livraison', 'Agence DPD de La Crau (283)'],
        ['04/01/2026', '09:32', 'Colis en agence DPD France', 'Agence DPD de La Crau (283)'],
        ['31/12/2025', '10:48', 'Livraison reportée suite à une prise de rendez-vous', 'Agence DPD de La Crau (283)'],
        ['30/12/2025', '04:18', 'Colis en cours d´acheminement', 'Centre de tri DPD de Le Coudray (175)'],
        ['29/12/2025', '15:36', 'Colis en retour vers l\'adresse d\'expédition, en attente de livraison chez l’expéditeur', 'Agence DPD de La Crau (283)'],
        ['28/12/2025', '09:00', 'Colis en préparation chez l´expéditeur', ''],
      ],
    }), '2501234567890127');

    expect(result).toMatchObject({
      status: 'delivered',
      delivered_at: '2026-01-09T12:37:00+01:00',
      weight_kg: 1.2,
    });
    expect(result.events?.map((event) => event.stage)).toEqual([
      'delivered',
      'ready_for_pickup',
      'ready_for_pickup',
      'failed_attempt',
      'exception',
      'exception',
      'out_for_delivery',
      'in_transit',
      'in_transit',
      'in_transit',
      'returned',
      'registered',
    ]);
  });

  it('leaves unrecognized wording without a stage and falls back to the newest mapped row', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: [
        ['13/02/2026', '07:05', 'Votre colis fait l’objet d’un traitement particulier', 'Agence DPD de La Crau (283)'],
        ...FIXTURE.outboundRows.slice(1),
      ],
    }), TEST_TRACKING_NUMBER);

    const [newest] = result.events ?? [];
    expect(newest?.description).toBe('Votre colis fait l’objet d’un traitement particulier');
    expect(newest && 'stage' in newest).toBe(false);
    // The unmapped row decides nothing: the newest recognized row still does.
    expect(result.status).toBe('delivered');
    expect(result.last_status_text).toBe('Votre colis fait l’objet d’un traitement particulier');
  });

  it('reports status unknown when no event wording is recognized', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: [
        ['13/02/2026', '07:05', 'Votre colis fait l’objet d’un traitement particulier', 'Agence DPD de La Crau (283)'],
      ],
    }), TEST_TRACKING_NUMBER);

    expect(result.status).toBe('unknown');
    expect(result.events).toEqual([{
      time: '2026-02-13T07:05:00+01:00',
      location: 'Agence DPD de La Crau (283)',
      description: 'Votre colis fait l’objet d’un traitement particulier',
      point: { latitude: 43.1512, longitude: 6.0712 },
    }]);
  });

  it('puts only the delivering depot\'s scans on its map marker', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture(), TEST_TRACKING_NUMBER);
    const points = result.events?.map((event) => [event.location, event.point ?? null]);

    expect(points).toEqual([
      ['Agence DPD de La Crau (283)', { latitude: 43.1512, longitude: 6.0712 }],
      ['', null],
      ['Agence DPD de La Crau (283)', { latitude: 43.1512, longitude: 6.0712 }],
      // Another depot: the page only places the delivering one.
      ['Centre de tri DPD de Le Coudray (175)', null],
    ]);
  });

  it('lets the delivered scan stored with its status as the location keep its row', () => {
    const scans = (parseDPDFranceTrackingHtml(trackingFixture(), TEST_TRACKING_NUMBER).events ?? []).map((event) => ({
      time: event.time, stage: event.stage ?? '', description: event.description ?? '', location: event.location ?? '', providerCode: '',
    }));
    // What an earlier release stored: the same rows, the delivered one placed at its status.
    const stored = scans.map((scan) => (scan.stage === 'delivered' ? { ...scan, location: 'Livré au destinataire' } : scan));
    const policy = sameInstantIdentityPolicy('dpd-fr', { supportsScanMatching: true })!;
    // As the app matches: one row at the scan's instant, and that row matching no other scan of the batch.
    const takenOver = scans.map((scan) => {
      const rows = stored.filter((row) => row.time === scan.time && policy.matches!(scan, row));
      const others = scans.filter((other) => other.time === scan.time && rows[0] && policy.matches!(other, rows[0]));
      return rows.length === 1 && others.length === 1 ? rows[0]!.location : null;
    });
    // Rows whose location did not change keep their identity and are never asked.
    expect(takenOver).toEqual([null, 'Livré au destinataire', null, null]);
  });

  it('rejects browser challenges, unknown shipments, and mismatched responses', () => {
    expect(() => parseDPDFranceTrackingHtml(
      '<title>Just a moment...</title><p>Performing security verification</p>',
      TEST_TRACKING_NUMBER,
    )).toThrow(DPDFranceChallengeError);
    expect(() => parseDPDFranceTrackingHtml(
      '<p>Nous ne sommes pas en mesure de retrouver le numéro de colis recherché.</p>',
      TEST_TRACKING_NUMBER,
    )).toThrow(DPDFranceTrackingError);
    expect(() => parseDPDFranceTrackingHtml(
      trackingFixture({ outboundNumber: '250123456789099' }),
      TEST_TRACKING_NUMBER,
    )).toThrow('different shipment');
  });

  it('selects the requested return leg without mixing outbound events', () => {
    const html = `<!doctype html><html><body>
      <span class="parcelNumberAller">Votre colis 10612345678900</span>
      <span class="parcelNumberRetour">Votre colis ${TEST_RETURN_NUMBER}</span>
      <div id="infos1"><ul class="tableInfosAR"><li><strong>N° colis</strong></li><li class="tdInfos">10612345678900</li></ul></div>
      <div id="infos2"><ul class="tableInfosAR"><li><strong>N° colis</strong></li><li class="tdInfos">${TEST_RETURN_NUMBER}</li></ul></div>
      <table id="tableTrace">
        <tr class="tabTraceColisAller"><td>18/11/2024</td><td>12:20</td><td>Votre colis est livré</td><td>Outbound location</td></tr>
        <tr class="tabTraceColisRetour"><td>19/11/2024</td><td>09:01</td><td>Votre colis est en transit dans notre réseau</td><td>Return location</td></tr>
      </table>
    </body></html>`;

    expect(parseDPDFranceTrackingHtml(html, TEST_RETURN_NUMBER)).toMatchObject({
      status: 'in_transit',
      events: [{ location: 'Return location', stage: 'in_transit' }],
    });
    expect(JSON.stringify(parseDPDFranceTrackingHtml(html, TEST_RETURN_NUMBER)))
      .not.toContain('Outbound location');
  });
});

describe('DPD France status vocabulary', () => {
  it('checks returns and incidents before the delivery wording', () => {
    expect(classifyStatus('Votre colis sera retourné à l’expéditeur'))
      .toEqual({ status: 'exception', stage: 'returned' });
    expect(classifyStatus('Votre colis est livré'))
      .toEqual({ status: 'delivered', stage: 'delivered' });
    expect(classifyStatus('Votre colis est disponible en relais'))
      .toEqual({ status: 'out_for_delivery', stage: 'ready_for_pickup' });
  });

  it('keeps the same-day delivery notices on the delivery round and reads acceptance notices as accepted', () => {
    for (const channel of ['SMS', 'e-mail']) {
      expect(classifyStatus(`Le destinataire est informé par ${channel} de la livraison de son colis ce jour`))
        .toEqual({ status: 'out_for_delivery', stage: 'out_for_delivery' });
      expect(classifyStatus(`Le destinataire est informé par ${channel} de la prise en charge de son colis dans notre réseau`))
        .toEqual({ status: 'in_transit', stage: 'accepted' });
    }
    expect(classifyStatus('Votre colis a été pris en charge dans notre réseau'))
      .toEqual({ status: 'in_transit', stage: 'accepted' });
    // The driver taking the parcel over is still the delivery round.
    expect(classifyStatus('Le chauffeur a pris en charge votre colis'))
      .toEqual({ status: 'out_for_delivery', stage: 'out_for_delivery' });
  });
});

describe('DPD France transport tiers', () => {
  it('uses direct HTTP when Cloudflare permits it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      trackingFixture(),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ));
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDFranceTracker({ timeoutMs: 2_000, trawl: null, recorder })
      .fetch(TEST_TRACKING_NUMBER)).resolves.toMatchObject({
        status: 'exception',
        tracking_url: dpdFranceTrackingUrl(TEST_TRACKING_NUMBER),
        tracking_source: 'rendered-page',
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(dpdFranceTrackingUrl(TEST_TRACKING_NUMBER));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      cache: 'no-store',
      redirect: 'follow',
    });
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'ok']]);
  });

  it('asks the browser service at once, with the same TRAWL scrape protocol used for UPS', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        html: trackingFixture(),
        cookies: [],
      }), { headers: { 'Content-Type': 'application/json' } }));
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDFranceTracker({
      timeoutMs: 2_000,
      trawl: new TrawlClient('http://trawl.internal:8191/v1'),
      recorder,
    }).fetch(TEST_TRACKING_NUMBER)).resolves.toMatchObject({ status: 'exception' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://trawl.internal:8191/scrape');
    const trawlRequest = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(trawlRequest).toEqual({
      url: dpdFranceTrackingUrl(TEST_TRACKING_NUMBER),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: 2_000,
    });
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['trawl', 'ok']]);
  });

  it('gives the browser tier the caller\'s signal and what is left of the budget', async () => {
    let reached!: () => void;
    const browserRequest = new Promise<void>((resolve) => { reached = resolve; });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        reached();
      }));
    const controller = new AbortController();
    const cancelled = new Error('caller cancelled');

    const lookup = new DPDFranceTracker({ timeoutMs: 60_000, trawl: new TrawlClient('http://trawl.internal:8191/v1') })
      .fetch(TEST_TRACKING_NUMBER, { signal: controller.signal, budgetMs: 30_000 });
    await browserRequest;
    controller.abort(cancelled);

    await expect(lookup).rejects.toBe(cancelled);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).maxTimeout).toBeLessThanOrEqual(30_000);
  });

  it('retries a GET that hangs once, inside the budget, but not an unknown parcel', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: 300, reply: () => new Response(trackingFixture()) }]);
    const { recorder, steps } = recordingRecorder();
    const lookup = new DPDFranceTracker({ fetcher, trawl: null, recorder }).fetch(TEST_TRACKING_NUMBER, { budgetMs: 30_000 });
    await vi.advanceTimersByTimeAsync(15_300);
    await expect(lookup).resolves.toMatchObject({ status: 'exception' });
    expect(ended).toEqual([15_000, 15_300]);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'transport'], ['retry', 'ok']]);
    const unknown = delayedFetcher([{ afterMs: 10,
      reply: () => new Response('<p>Nous ne sommes pas en mesure de retrouver le numéro de colis recherché.</p>') }]);
    const missing = expect(new DPDFranceTracker({ fetcher: unknown.fetcher, trawl: null }).fetch(TEST_TRACKING_NUMBER))
      .rejects.toBeInstanceOf(DPDFranceTrackingError);
    await vi.advanceTimersByTimeAsync(10);
    await missing;
    expect(unknown.fetcher).toHaveBeenCalledOnce();
  });

  it('surfaces an actionable error when no browser solver is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<title>Just a moment...</title>',
      { status: 403, headers: { 'CF-Mitigated': 'challenge' } },
    ));
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDFranceTracker({ timeoutMs: 2_000, trawl: null, recorder })
      .fetch(TEST_TRACKING_NUMBER)).rejects.toThrow('configure FLARESOLVERR_URL');
    // The missing tier is a disabled step, not a failed one.
    expect(steps.map((step) => step.step)).toEqual(['direct']);
  });
});

describe('DPD France adapter factory', () => {
  it('declares both tiers and tracks through the direct page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(trackingFixture()));
    const { recorder } = recordingRecorder();
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder, env: {} });

    expect(instance.id).toBe('dpd-fr');
    expect(instance.steps).toEqual(['direct', 'retry', 'trawl']);
    await expect(instance.track({ number: TEST_TRACKING_NUMBER }))
      .resolves.toMatchObject({ status: 'exception' });
  });
});
