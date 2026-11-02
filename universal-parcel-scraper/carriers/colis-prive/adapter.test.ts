import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputRequiredError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import {
  adapter,
  ColisPriveTracker,
  ColisPriveTrackingError,
  colisPriveTrackingUrl,
  normalizeColisPriveCredential,
  parseColisPriveTrackingHtml,
} from './adapter.js';
import { classifyStatus } from './status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_SYNTHETIC_CREDENTIAL = '99112233445575012';
const CAPABILITIES: readonly string[] = JSON.parse(
  readFileSync(path.join(here, 'carrier.json'), 'utf8'),
).capabilities;

interface PageFixture {
  shipment: string;
  status: string;
  rows: Array<[string, string]>;
  recipientBlock: string[];
  recipientContact: string;
}

const FIXTURE: PageFixture = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'failed-attempt.json'), 'utf8'),
);

function trackingPage(options: {
  shipment?: string;
  status?: string;
  rows?: Array<[string, string]>;
} = {}): string {
  const shipment = options.shipment ?? FIXTURE.shipment;
  const status = options.status ?? FIXTURE.status;
  const rows = options.rows ?? FIXTURE.rows;
  return `<!doctype html>
    <html><body>
      <div class="BandeauInfoColis">
        <div class="divColis"><div class="tdText">${shipment}</div></div>
        <div class="divStatut"><div class="tdText">${status}</div></div>
        <div class="divDesti"><div class="tdText">
          ${FIXTURE.recipientBlock.join('<br>')}
        </div></div>
      </div>
      <table class="tableHistoriqueColis">
        ${rows.map(([date, description]) => `
          <tr class="bandeauText">
            <td class="tdText" headers="th-date">${date}</td>
            <td class="tdText" headers="th-statut">${description}</td>
          </tr>`).join('')}
      </table>
      <div class="recipient-contact">${FIXTURE.recipientContact}</div>
    </body></html>`;
}

afterEach(() => vi.restoreAllMocks());

describe('Colis Privé combined tracking credential', () => {
  it('accepts only 12 alphanumeric shipment characters followed by a French, Belgian or Luxembourg postcode', () => {
    expect(normalizeColisPriveCredential(`  ${PUBLIC_SYNTHETIC_CREDENTIAL}  `))
      .toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(normalizeColisPriveCredential('ab123456789075001')).toBe('AB123456789075001');
    expect(normalizeColisPriveCredential('ab1234567890b1000')).toBe('AB1234567890B1000');
    expect(normalizeColisPriveCredential('AB1234567890L9999')).toBe('AB1234567890L9999');
    // Colis Privé's own links also write a Belgian postcode without its letter.
    expect(normalizeColisPriveCredential('9911223344557501')).toBe('9911223344557501');

    for (const value of [
      '99112233445575',
      '991122334455750123',
      '991122334455ABCDE',
      '9911223344557501É',
      '99112233445575012&admin=true',
      '991 122 334 455 75012',
      '99112233445500000',
      '99112233445596000',
      '99112233445599000',
      '991122334455B0999',
      '991122334455B100',
      '991122334455BE1000',
      '991122334455D1000',
    ]) {
      expect(() => normalizeColisPriveCredential(value)).toThrow(InvalidInputError);
      expect(() => normalizeColisPriveCredential(value)).toThrow('12-character shipment number');
    }
  });

  it('takes the postcode apart from a bare shipment number', () => {
    for (const [postcode, credential] of [
      ['75012', '99112233445575012'],
      [' 75 012 ', '99112233445575012'],
      ['1000', '9911223344551000'],
      ['b1000', '991122334455B1000'],
      ['B-1000', '991122334455B1000'],
      ['BE 1000', '991122334455B1000'],
      ['L-1234', '991122334455L1234'],
      ['LU1234', '991122334455L1234'],
    ] as const) {
      expect(normalizeColisPriveCredential(' 991122334455 ', postcode)).toBe(credential);
    }
    for (const postcode of ['96000', '0999', '123', '750012', 'D1000', 'BL1000', 'SW1A 1AA', '75012&admin=true']) {
      expect(() => normalizeColisPriveCredential('991122334455', postcode)).toThrow(InvalidInputError);
    }
    // A number that already ends in its postcode takes no second one.
    expect(() => normalizeColisPriveCredential(PUBLIC_SYNTHETIC_CREDENTIAL, '75012')).toThrow(InvalidInputError);
  });

  it('asks for the postcode when a bare shipment number has none', () => {
    for (const postcode of ['', '  ']) {
      expect(() => normalizeColisPriveCredential('991122334455', postcode)).toThrow(InputRequiredError);
    }
    expect(() => normalizeColisPriveCredential('991122334455')).toThrow('12-character shipment number');
  });

  it('builds the official detail URL without allowing parameter injection', () => {
    const url = new URL(colisPriveTrackingUrl(PUBLIC_SYNTHETIC_CREDENTIAL));
    expect(url.origin).toBe('https://colisprive.com');
    expect(url.pathname).toBe('/moncolis/pages/DetailColis.aspx');
    expect(url.searchParams.get('numColis')).toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(url.searchParams.get('lang')).toBe('fr');
    expect([...url.searchParams]).toHaveLength(2);
  });
});

describe('Colis Privé wording classifier', () => {
  it('checks the exception wording before the delivery wording', () => {
    expect(classifyStatus('Nous avons tenté de livrer votre colis.'))
      .toEqual({ status: 'exception', stage: 'failed_attempt' });
    expect(classifyStatus('Votre colis a été livré en boîte aux lettres'))
      .toEqual({ status: 'delivered', stage: 'delivered' });
    expect(classifyStatus("Votre colis est retourné à l'expéditeur"))
      .toEqual({ status: 'exception', stage: 'returned' });
  });

  it('leaves wording it does not know unmapped', () => {
    expect(classifyStatus('Une phrase que le transporteur vient d’ajouter'))
      .toEqual({ status: 'unknown' });
  });
});

describe('Colis Privé HTML normalization', () => {
  it('verifies the requested shipment and parses status history without retaining recipient data', () => {
    const result = parseColisPriveTrackingHtml(
      trackingPage(),
      PUBLIC_SYNTHETIC_CREDENTIAL,
    );

    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Nous avons tenté de livrer votre colis.',
      last_update: null,
      last_update_local: '2026-08-28',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        local_time: '2026-08-28',
        location: '',
        description: 'Nous avons tenté de livrer votre colis.',
        stage: 'failed_attempt',
      },
      {
        local_time: '2026-08-28',
        location: '',
        description: 'Votre colis est en cours de distribution par le livreur',
        stage: 'out_for_delivery',
      },
      {
        local_time: '2026-08-26',
        location: '',
        description: 'Votre colis est arrivé sur notre agence régionale de distribution.',
        stage: 'in_transit',
      },
      {
        local_time: '2026-08-25',
        location: '',
        description: "Votre colis est en cours de préparation par l'expéditeur.",
        stage: 'registered',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [...FIXTURE.recipientBlock, FIXTURE.recipientContact]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('reads the newest announced appointment or relay drop-off day until the parcel settles or passes it', () => {
    const appointment: [string, string] = ['29/08/2026', 'Votre rendez-vous est confirmé. le 31/08/2026'];
    const relay: [string, string] = ['29/08/2026', 'Votre colis va être prochainement déposé en Point Relais. le 30/08/2026'];
    const estimate = (status: string, rows: Array<[string, string]>) => parseColisPriveTrackingHtml(
      trackingPage({ status, rows }), PUBLIC_SYNTHETIC_CREDENTIAL).expected_delivery;
    expect(classifyStatus(appointment[1])).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(estimate(appointment[1], [appointment, ...FIXTURE.rows])).toBe('2026-08-31');
    expect(estimate(relay[1], [relay, ...FIXTURE.rows])).toBe('2026-08-30');
    expect(estimate(appointment[1], [['01/09/2026', "Votre colis est arrivé sur notre agence régionale de distribution."],
      appointment, ...FIXTURE.rows])).toBeNull();
    expect(estimate('Votre Colis a été livré avec signature', [['31/08/2026', 'Votre Colis a été livré avec signature'],
      appointment, ...FIXTURE.rows])).toBeNull();
    expect(estimate(FIXTURE.status, [['30/08/2026', FIXTURE.status], appointment])).toBeNull();
    expect(estimate(appointment[1], [['29/08/2026', 'Votre rendez-vous est confirmé. le 31/02/2026']])).toBeNull();
  });

  it('returns every capability declared in carrier.json', () => {
    const result = parseColisPriveTrackingHtml(trackingPage({ status: 'Votre rendez-vous est confirmé. le 31/08/2026',
      rows: [['29/08/2026', 'Votre rendez-vous est confirmé. le 31/08/2026'], ...FIXTURE.rows] }), PUBLIC_SYNTHETIC_CREDENTIAL);
    const checks: Record<string, () => boolean> = {
      history: () => (result.events?.length ?? 0) > 0,
      eta: () => Boolean(result.expected_delivery),
    };
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const capability of CAPABILITIES) {
      expect(checks[capability], `no check for capability ${capability}`).toBeDefined();
      expect(checks[capability]!(), `capability ${capability} is declared but never returned`).toBe(true);
    }
  });

  it('emits an unmapped row without a stage', () => {
    const result = parseColisPriveTrackingHtml(trackingPage({
      status: 'Un nouveau libellé du transporteur',
      rows: [['29/08/2026', 'Un nouveau libellé du transporteur']],
    }), PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(result.status).toBe('unknown');
    expect(result.events).toEqual([{
      local_time: '2026-08-29',
      location: '',
      description: 'Un nouveau libellé du transporteur',
    }]);
  });

  it('maps delivered and relay-pickup statuses', () => {
    const delivered = parseColisPriveTrackingHtml(trackingPage({
      status: 'Votre colis a été livré en boîte aux lettres',
      rows: [['29/08/2026', 'Votre colis a été livré en boîte aux lettres']],
    }), PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(delivered.status).toBe('delivered');
    expect(delivered.events).toEqual([expect.objectContaining({ stage: 'delivered' })]);

    const pickup = parseColisPriveTrackingHtml(trackingPage({
      status: 'Votre colis vous attend au relais',
      rows: [['29/08/2026', 'Votre colis vous attend au relais']],
    }), PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(pickup.status).toBe('out_for_delivery');
    expect(pickup.events).toEqual([expect.objectContaining({ stage: 'ready_for_pickup' })]);
  });

  it('gives way to the newest row when the banner repeats an older one', () => {
    const rows: Array<[string, string]> = [
      ['27/10/2026', 'Votre colis est en cours de distribution par le livreur'],
      ['27/10/2026', 'Votre colis est arrivé sur notre agence régionale de distribution'],
      ['26/10/2026', 'Votre colis va être pris en charge par Colis Privé'],
    ];
    const lagging = parseColisPriveTrackingHtml(trackingPage({ status: 'Votre colis va être pris en charge par Colis Privé', rows }),
      PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(lagging).toMatchObject({ status: 'out_for_delivery', last_status_text: 'Votre colis est en cours de distribution par le livreur' });
    // A banner of its own, or one the newest row repeats, stands.
    for (const status of ['Votre colis est en cours de livraison', 'Votre colis est en cours de distribution par le livreur']) {
      expect(parseColisPriveTrackingHtml(trackingPage({ status, rows }), PUBLIC_SYNTHETIC_CREDENTIAL).last_status_text).toBe(status);
    }
  });

  it('rejects mismatched, incomplete, and malformed success pages', () => {
    expect(() => parseColisPriveTrackingHtml(
      trackingPage({ shipment: '123 456 789 012' }),
      PUBLIC_SYNTHETIC_CREDENTIAL,
    )).toThrow(SchemaError);
    expect(() => parseColisPriveTrackingHtml(
      trackingPage({ shipment: '123 456 789 012' }),
      PUBLIC_SYNTHETIC_CREDENTIAL,
    )).toThrow('different shipment');
    expect(() => parseColisPriveTrackingHtml(
      '<html><body>Generic home page</body></html>',
      PUBLIC_SYNTHETIC_CREDENTIAL,
    )).toThrow('did not return tracking details');
    expect(() => parseColisPriveTrackingHtml(
      trackingPage({ status: '' }),
      PUBLIC_SYNTHETIC_CREDENTIAL,
    )).toThrow('did not return a shipment status');
  });
});

describe('Colis Privé tracker', () => {
  it('uses a bounded no-redirect request and parses a matching page', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(trackingPage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));

    await expect(new ColisPriveTracker({ timeoutMs: 1_000 }).fetch(PUBLIC_SYNTHETIC_CREDENTIAL))
      .resolves.toMatchObject({ status: 'exception', last_update_local: '2026-08-28' });

    const requested = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requested.searchParams.get('numColis')).toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'manual' });
  });

  it('tracks with the postcode at the end of the number or given apart, and recognizes only the first', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(trackingPage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    const requested = () => new URL(String(fetcher.mock.calls.at(-1)?.[0])).searchParams.get('numColis');

    await expect(instance.track({ number: '991122334455', postcode: '75012' })).resolves.toMatchObject({ status: 'exception' });
    expect(requested()).toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
    await expect(instance.track({ number: '9911223344551000' })).resolves.toMatchObject({ status: 'exception' });
    expect(requested()).toBe('9911223344551000');
    await expect(instance.track({ number: '991122334455' })).rejects.toMatchObject({ kind: 'input_required' });

    fetcher.mockClear();
    await expect(instance.recognize!('991122334455')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(PUBLIC_SYNTHETIC_CREDENTIAL)).resolves.toMatchObject({ known: true });
    expect(requested()).toBe(PUBLIC_SYNTHETIC_CREDENTIAL);
  });

  it('surfaces provider redirects and 404 responses as privacy-safe not-found errors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: '/moncolis/Default.aspx' },
    }));
    await expect(new ColisPriveTracker().fetch(PUBLIC_SYNTHETIC_CREDENTIAL)).rejects.toMatchObject({
      name: 'ColisPriveTrackingError',
      message: 'Colis Privé could not locate the shipment',
      kind: 'not_found',
      status: 404,
    });
    expect(new ColisPriveTrackingError()).toBeInstanceOf(NotFoundError);
    expect(new ColisPriveTrackingError()).toMatchObject({ status: 404 });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });

    fetcher.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await expect(new ColisPriveTracker().fetch(PUBLIC_SYNTHETIC_CREDENTIAL))
      .rejects.toMatchObject({ status: 404 });
  });
});
