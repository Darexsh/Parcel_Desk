import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import {
  GeodisTracker,
  GeodisTrackingError,
  geodisRequestBody,
  geodisServiceHeader,
  geodisTrackingUrl,
  normalizeGeodisTrackingNumber,
  parseGeodisTrackingResponse,
} from './adapter.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { classifyStatus } from './status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_SYNTHETIC_NUMBER = '1G123GEODIS0';
const CAPABILITIES: readonly string[] = JSON.parse(
  readFileSync(path.join(here, 'carrier.json'), 'utf8'),
).capabilities;
const PRIVATE_PLACEHOLDERS = [
  'PRIVATE DELIVERY INSTRUCTION',
  'PRIVATE STREET',
  'PRIVATE CONTACT',
  'PRIVATE PHONE',
  'PRIVATE ORIGIN',
  'PRIVATE RECIPIENT',
  'PRIVATE DESTINATION',
  'private.example',
];

function successPayload(overrides: Record<string, unknown> = {}): unknown {
  const contenu = JSON.parse(
    readFileSync(path.join(here, 'fixtures', 'out-for-delivery.json'), 'utf8'),
  ) as Record<string, unknown>;
  return {
    ok: true,
    codeErreur: null,
    texteErreur: null,
    contenu: { ...contenu, ...overrides },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('GEODIS anonymous tracking request', () => {
  it('accepts only the official 12-character 1G form', () => {
    expect(normalizeGeodisTrackingNumber(` ${OFFICIAL_SYNTHETIC_NUMBER.toLowerCase()} `))
      .toBe(OFFICIAL_SYNTHETIC_NUMBER);
    for (const value of [
      '1GSHORT',
      '00104444125506',
      '2G123GEODIS0',
      '1G123GEODIS',
      '1G123GEODIS00',
      '1G123GEODISÉ',
      '1G123GEODIS0&admin=true',
    ]) {
      expect(() => normalizeGeodisTrackingNumber(value)).toThrow('start with 1G');
    }
  });

  it('exposes the fixed endpoint, exact JSON body, and deterministic SPA signature', () => {
    expect(geodisTrackingUrl()).toBe(
      'https://espace-client.geodis.com/services/api/destinataire/recherche-envoi-anonyme',
    );
    expect(geodisRequestBody(OFFICIAL_SYNTHETIC_NUMBER))
      .toBe('{"noSuivi":"1G123GEODIS0"}');
    expect(geodisServiceHeader(OFFICIAL_SYNTHETIC_NUMBER, 1_735_689_600_123)).toBe(
      '$DESTINATAIRE;1735689600123;fr;90458ae51b15e0a392ac1063f7d8ccdf6ae4c390a6d599e778b34adf9d1b07a6',
    );
    expect(() => geodisServiceHeader(OFFICIAL_SYNTHETIC_NUMBER, 0))
      .toThrow('positive integer');
  });
});

describe('GEODIS wording classifier', () => {
  it('keeps future and in-progress deliveries out of the delivered stage', () => {
    expect(classifyStatus('En cours de livraison'))
      .toEqual({ status: 'out_for_delivery', stage: 'out_for_delivery' });
    expect(classifyStatus('Votre colis va être livré prochainement'))
      .toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(classifyStatus('Colis livré')).toEqual({ status: 'delivered', stage: 'delivered' });
  });

  it('leaves wording it does not know unmapped', () => {
    expect(classifyStatus('Nouveau libellé GEODIS')).toEqual({ status: 'unknown' });
  });

  it.each([
    ["En préparation chez l'expéditeur", 'pending', 'registered'],
    ['En cours d’acheminement', 'in_transit', 'in_transit'],
    ['Mise en livraison', 'out_for_delivery', 'out_for_delivery'],
    ['Expédition livrée', 'delivered', 'delivered'],
  ])('reads the timeline step "%s"', (label, status, stage) => {
    expect(classifyStatus(label)).toEqual({ status, stage });
  });
});

describe('GEODIS response normalization', () => {
  it('normalizes the allowlisted timeline and never retains private or complementary fields', () => {
    const result = parseGeodisTrackingResponse(successPayload(), OFFICIAL_SYNTHETIC_NUMBER);

    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      last_status_text: 'En cours de livraison',
      last_update: null,
      last_update_local: '2026-08-29T09:30:00',
      expected_delivery: '2026-08-30',
      sender_name: 'EXAMPLE SENDER',
      service_name: 'Example Express Service',
      weight_kg: 12.5,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        local_time: '2026-08-29T09:30:00',
        location: 'AGENCE PARIS',
        description: 'En cours de livraison',
        stage: 'out_for_delivery',
      },
      {
        local_time: '2026-08-28T14:05:00',
        location: 'CENTRE DE TRI',
        description: 'Envoi pris en charge',
        stage: 'in_transit',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of PRIVATE_PLACEHOLDERS) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('returns every capability declared in carrier.json', () => {
    const result = parseGeodisTrackingResponse(successPayload(), OFFICIAL_SYNTHETIC_NUMBER);
    const checks: Record<string, () => boolean> = {
      history: () => (result.events?.length ?? 0) > 0,
      location: () => (result.events ?? []).some((event) => Boolean(event.location)),
      eta: () => result.expected_delivery != null,
      sender_name: () => Boolean(result.sender_name),
      service_name: () => Boolean(result.service_name),
      weight: () => result.weight_kg != null,
    };
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const capability of CAPABILITIES) {
      expect(checks[capability], `no check for capability ${capability}`).toBeDefined();
      expect(checks[capability]!(), `capability ${capability} is declared but never returned`).toBe(true);
    }
  });

  it('never falls back to the contact person and drops a weight it cannot read', () => {
    const result = parseGeodisTrackingResponse(successPayload({
      expediteur: { nom: ' ', nomContact: 'PRIVATE CONTACT' },
      poids: 0,
    }), OFFICIAL_SYNTHETIC_NUMBER);
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('weight_kg');
    expect(JSON.stringify(result)).not.toContain('PRIVATE CONTACT');
    expect(parseGeodisTrackingResponse(successPayload({ prestationCommerciale: { libelle: ' ' } }), OFFICIAL_SYNTHETIC_NUMBER))
      .not.toHaveProperty('service_name');
    for (const poids of [-1, '12.5', Number.NaN, 1e9, null]) {
      expect(parseGeodisTrackingResponse(successPayload({ poids }), OFFICIAL_SYNTHETIC_NUMBER))
        .not.toHaveProperty('weight_kg');
    }
  });

  it('takes the current stage from the active timeline step, then the newest mapped scan', () => {
    const timeline = (libelle: string) => ({ listTimesteps: [{ actif: true, libelle }] });
    expect(parseGeodisTrackingResponse(successPayload({
      timeline: timeline("En préparation chez l'expéditeur"),
      listJoursSuivis: null,
      dateLivraisonPrevue: null,
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(parseGeodisTrackingResponse(successPayload({
      timeline: timeline('Expédition livrée'),
      listJoursSuivis: null,
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parseGeodisTrackingResponse(successPayload({
      timeline: timeline('Nouveau libellé GEODIS'),
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
  });

  it.each([
    ['Destinataire absent', 'exception', 'failed_attempt'],
    ['Livraison échouée', 'exception', 'failed_attempt'],
    ['Colis endommagé', 'exception', 'exception'],
    ["Retour à l'expéditeur", 'exception', 'returned'],
    ['Disponible pour retrait en agence', 'out_for_delivery', 'ready_for_pickup'],
  ])('lets a newest scan "%s" win over the delivery round step', (label, status, stage) => {
    const payload = (overrides: Record<string, unknown> = {}) => successPayload({
      timeline: { listTimesteps: [{ actif: true, libelle: 'Mise en livraison' }] },
      listJoursSuivis: [{
        dateSuivi: '29/08/2026',
        suivis: [
          { heureSuivi: '14:10:00', libelleSuivi: label },
          { heureSuivi: '09:30:00', libelleSuivi: 'En cours de livraison' },
        ],
      }],
      ...overrides,
    });
    expect(parseGeodisTrackingResponse(payload(), OFFICIAL_SYNTHETIC_NUMBER))
      .toMatchObject({ status, current_stage: stage, last_status_text: label });
    expect(parseGeodisTrackingResponse(payload({ etatLivre: true }), OFFICIAL_SYNTHETIC_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('keeps the timeline step over an older problem or a newer routine scan', () => {
    const payload = (suivis: unknown[]) => successPayload({
      timeline: { listTimesteps: [{ actif: true, libelle: 'Mise en livraison' }] },
      listJoursSuivis: [{ dateSuivi: '30/08/2026', suivis }],
    });
    expect(parseGeodisTrackingResponse(payload([
      { heureSuivi: '08:00:00', libelleSuivi: 'En cours de livraison' },
      { heureSuivi: '07:00:00', libelleSuivi: 'Destinataire absent' },
    ]), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      last_status_text: 'Mise en livraison',
    });
    expect(parseGeodisTrackingResponse(payload([
      { heureSuivi: '08:00:00', libelleSuivi: 'Nouveau libellé GEODIS' },
      { heureSuivi: '07:00:00', libelleSuivi: 'Destinataire absent' },
    ]), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
  });

  it('emits an unmapped scan without a stage', () => {
    const result = parseGeodisTrackingResponse(successPayload({
      timeline: { listTimesteps: [] },
      listJoursSuivis: [{
        dateSuivi: '29/08/2026',
        suivis: [{ heureSuivi: '09:30:00', libelleSuivi: 'Nouveau libellé GEODIS' }],
      }],
    }), OFFICIAL_SYNTHETIC_NUMBER);
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events).toEqual([{
      local_time: '2026-08-29T09:30:00',
      location: '',
      description: 'Nouveau libellé GEODIS',
    }]);
  });

  it('keeps each scan as a Paris wall clock, or its day alone', () => {
    const result = parseGeodisTrackingResponse(successPayload({
      timeline: { listTimesteps: [] },
      listJoursSuivis: [{
        dateSuivi: '29/08/2026',
        suivis: [{ heureSuivi: '', libelleSuivi: 'Nouveau libellé GEODIS' }, { heureSuivi: '09:30', libelleSuivi: 'Envoi pris en charge' }],
      }],
    }), OFFICIAL_SYNTHETIC_NUMBER);
    expect(result.events?.map((event) => [event.time, event.local_time])).toEqual([
      [undefined, '2026-08-29T09:30:00'], [undefined, '2026-08-29'],
    ]);
    expect(dateLocalClocks('geodis', result).events?.map((event) => event.time))
      .toEqual(['2026-08-29T09:30:00+02:00', undefined]);
  });

  it('maps explicit delivered, collected, pickup-ready, and terminal failure states defensively', () => {
    expect(parseGeodisTrackingResponse(successPayload({ etatLivre: true }), OFFICIAL_SYNTHETIC_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(parseGeodisTrackingResponse(successPayload({ etatRetire: true }), OFFICIAL_SYNTHETIC_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parseGeodisTrackingResponse(successPayload({
      timeline: { listTimesteps: [{ actif: true, libelle: 'Disponible pour retrait en agence' }] },
      listJoursSuivis: [],
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      last_status_text: 'Disponible pour retrait en agence',
    });
    expect(parseGeodisTrackingResponse(successPayload({
      finDeVie: true,
      timeline: { listTimesteps: [{ actif: true, libelle: 'Traitement terminé' }] },
      listJoursSuivis: [],
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'exception', current_stage: 'exception' });
    expect(parseGeodisTrackingResponse(successPayload({
      finDeVie: true,
      timeline: { listTimesteps: [{ actif: true, libelle: "Retourné à l'expéditeur" }] },
      listJoursSuivis: [],
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it('marks a reply without scans as a summary', () => {
    // A delivered shipment's anonymous reply: the timeline step and the terminal state, no scans.
    expect(parseGeodisTrackingResponse(successPayload({
      etatLivre: true,
      timeline: { listTimesteps: [{ actif: true, libelle: 'Expédition livrée' }] },
      listJoursSuivis: null,
    }), OFFICIAL_SYNTHETIC_NUMBER)).toMatchObject({
      status: 'delivered',
      last_status_text: 'Expédition livrée',
      last_update: null,
      summary_only: true,
      events: [],
    });
    expect(parseGeodisTrackingResponse(successPayload(), OFFICIAL_SYNTHETIC_NUMBER))
      .not.toHaveProperty('summary_only');
  });

  it('does not treat delivery-driver or future-delivery wording as delivered', () => {
    const eventPayload = (label: string) => successPayload({
      timeline: { listTimesteps: [] },
      listJoursSuivis: [{
        dateSuivi: '29/08/2026',
        suivis: [{ heureSuivi: '09:30:00', libelleSuivi: label }],
      }],
    });

    expect(parseGeodisTrackingResponse(
      eventPayload('En cours de livraison par le livreur'),
      OFFICIAL_SYNTHETIC_NUMBER,
    )).toMatchObject({
      status: 'out_for_delivery',
      events: [{ stage: 'out_for_delivery' }],
    });
    expect(parseGeodisTrackingResponse(
      eventPayload('Votre colis va être livré prochainement'),
      OFFICIAL_SYNTHETIC_NUMBER,
    )).toMatchObject({
      status: 'in_transit',
      events: [{ stage: 'in_transit' }],
    });
  });

  it('handles structured not-found without exposing the provider text', () => {
    let error: unknown;
    try {
      parseGeodisTrackingResponse({
        ok: false,
        codeErreur: 'err.envoi.non.trouve',
        texteErreur: 'Envoi privé non trouvé avec des détails internes',
        contenu: null,
      }, OFFICIAL_SYNTHETIC_NUMBER);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GeodisTrackingError);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({
      message: 'GEODIS could not locate the shipment',
      kind: 'not_found',
      status: 404,
    });
    expect(JSON.stringify(error)).not.toContain('détails internes');
  });

  it('keeps an unreadable rejection indeterminate rather than not-found', () => {
    expect(() => parseGeodisTrackingResponse({
      ok: false,
      codeErreur: 'err.technique',
      texteErreur: null,
      contenu: null,
    }, OFFICIAL_SYNTHETIC_NUMBER)).toThrow(IndeterminateError);
  });

  it('rejects mismatched and structurally invalid success responses', () => {
    expect(() => parseGeodisTrackingResponse(successPayload({ noSuivi: '1GABCDEFGHIJ' }),
      OFFICIAL_SYNTHETIC_NUMBER)).toThrow(SchemaError);
    expect(() => parseGeodisTrackingResponse(successPayload({ noSuivi: '1GABCDEFGHIJ' }),
      OFFICIAL_SYNTHETIC_NUMBER)).toThrow('different shipment');
    expect(() => parseGeodisTrackingResponse({ ok: true, contenu: null }, OFFICIAL_SYNTHETIC_NUMBER))
      .toThrow('incomplete tracking details');
    expect(() => parseGeodisTrackingResponse({ ok: 'true', contenu: {} }, OFFICIAL_SYNTHETIC_NUMBER))
      .toThrow('invalid tracking response');
  });
});

describe('GEODIS tracker', () => {
  it('sends the bounded signed anonymous request and parses its response', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(successPayload()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new GeodisTracker({ timeoutMs: 1_000 }).fetch(OFFICIAL_SYNTHETIC_NUMBER))
      .resolves.toMatchObject({ status: 'out_for_delivery' });

    expect(fetcher.mock.calls[0]?.[0]).toBe(geodisTrackingUrl());
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: 'POST',
      body: geodisRequestBody(OFFICIAL_SYNTHETIC_NUMBER),
      cache: 'no-store',
      redirect: 'error',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('Origin')).toBe('https://espace-client.geodis.com');
    const signature = headers.get('X-GEODIS-Service') ?? '';
    const parts = signature.split(';');
    expect(parts).toHaveLength(4);
    expect(signature).toBe(geodisServiceHeader(OFFICIAL_SYNTHETIC_NUMBER, Number(parts[1])));
  });
});
