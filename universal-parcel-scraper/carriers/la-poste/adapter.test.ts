import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { UpstreamHttpError } from '../../core/errors/index.js';
import type { StepRecord, StepRecorder } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import {
  LaPosteTracker,
  adapter,
  laPosteTrackingApiUrl,
  laPosteTrackingUrl,
  normalizeLaPosteTrackingNumber,
  parseLaPosteTrackingResponse,
} from './adapter.js';
import { eventStage, eventStatus, statusMap } from './status.js';

const TRACKING_NUMBER = 'AB12345678901';
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

interface LaPosteEvent {
  group: string;
  code: string;
  label: string;
  date: string;
  country: string;
  order: number;
  recipientAddress?: string;
}
interface LaPosteResponse {
  returnCode: number;
  returnMessage: string;
  shipment: {
    idShip: string;
    product: string;
    isFinal: boolean;
    estimDate: string;
    timeline: Array<{ id: number; shortLabel: string; date: string; status: boolean; code: string }>;
    event: LaPosteEvent[];
  };
}

function deliveredFixture(): LaPosteResponse[] {
  return JSON.parse(
    readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
  ) as LaPosteResponse[];
}

function recordingRecorder(): { recorder: StepRecorder; steps: StepRecord[] } {
  const steps: StepRecord[] = [];
  return { steps, recorder: { step: (record) => { steps.push(record); }, lookup() {} } };
}

afterEach(() => vi.restoreAllMocks());

describe('La Poste tracking input', () => {
  it('retains structured destination and delivery-partner evidence', () => {
    const data = deliveredFixture();
    Object.assign(data[0]!.shipment, { contextData: {
      arrivalCountry: 'FI', partner: { name: 'Posti', reference: 'CW123456785FR', url: 'https://www.posti.fi/en/tracking/CW123456785FR' },
      recipient: 'PRIVATE_RECIPIENT',
    } });
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER)).toMatchObject({
      destination_country: 'FI', delivery_carrier: 'posti', delivery_tracking_number: 'CW123456785FR',
    });
    expect(JSON.stringify(parseLaPosteTrackingResponse(data, TRACKING_NUMBER))).not.toContain('PRIVATE_RECIPIENT');
    Object.assign(data[0]!.shipment, { contextData: { arrivalCountry: 'FINLAND', partner: { name: 'GLS', reference: 'bad?reference' } } });
    const result = parseLaPosteTrackingResponse(data, TRACKING_NUMBER);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.destination_country).toBeUndefined();
  });
  it('reads the merchant, the pickup point while the parcel waits there and the delivery time', () => {
    const waiting = deliveredFixture();
    Object.assign(waiting[0]!.shipment, { isFinal: false, contextData: {
      merchantName: 'Example Shop', removalPoint: { type: 'A2P', isPickUp: true, name: 'CONSIGNE PICKUP EXEMPLE' },
      recipient: 'PRIVATE_RECIPIENT',
    } });
    waiting[0]!.shipment.event[1] = {
      ...waiting[0]!.shipment.event[1]!, group: 'DISMAD', code: 'AG1',
      label: 'Votre Colissimo vous attend dans votre point de retrait.',
    };
    expect(parseLaPosteTrackingResponse(waiting, TRACKING_NUMBER)).toMatchObject({
      current_stage: 'ready_for_pickup', sender_name: 'Example Shop', pickup_point: 'CONSIGNE PICKUP EXEMPLE',
      expected_delivery: '2026-01-09',
    });
    expect(parseLaPosteTrackingResponse(waiting, TRACKING_NUMBER).delivered_at).toBeUndefined();

    const delivered = deliveredFixture();
    Object.assign(delivered[0]!.shipment, { isFinal: false, contextData: {
      merchantName: '', removalPoint: { type: 'LP', isPickUp: false, name: 'BUREAU EXEMPLE' },
    } });
    const result = parseLaPosteTrackingResponse(delivered, TRACKING_NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', expected_delivery: null, delivered_at: '2026-01-08T11:14:50+01:00' });
    expect(result.sender_name).toBeUndefined();
    expect(result.pickup_point).toBeUndefined();
    expect(JSON.stringify(parseLaPosteTrackingResponse(waiting, TRACKING_NUMBER))).not.toContain('PRIVATE_RECIPIENT');
  });
  it('ignores an arrival country that only repeats the origin while scans happen elsewhere', () => {
    const data = deliveredFixture();
    Object.assign(data[0]!.shipment, { contextData: { arrivalCountry: 'US', originCountry: 'US' } });
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER).destination_country).toBe('FR');
    data[0]!.shipment.event.pop();
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER).destination_country).toBeUndefined();
    const domestic = deliveredFixture();
    Object.assign(domestic[0]!.shipment, { contextData: { arrivalCountry: 'FR', originCountry: 'FR' } });
    expect(parseLaPosteTrackingResponse(domestic, TRACKING_NUMBER).destination_country).toBe('FR');
    const outbound = deliveredFixture();
    Object.assign(outbound[0]!.shipment, { contextData: { arrivalCountry: 'DE', originCountry: 'FR' } });
    expect(parseLaPosteTrackingResponse(outbound, TRACKING_NUMBER).destination_country).toBe('DE');
  });
  it('normalizes domestic and UPU identifiers and builds official URLs', () => {
    expect(normalizeLaPosteTrackingNumber('ab 123.456-78901')).toBe(TRACKING_NUMBER);
    expect(normalizeLaPosteTrackingNumber('RA123456785FR')).toBe('RA123456785FR');
    expect(normalizeLaPosteTrackingNumber('12345678901234q')).toBe('12345678901234Q');
    expect(normalizeLaPosteTrackingNumber('87 0012 3456 7890')).toBe('87001234567890');
    expect(normalizeLaPosteTrackingNumber('87 0012 3456 78901')).toBe('870012345678901');
    expect(normalizeLaPosteTrackingNumber('88 0012 3456 7890a')).toBe('88001234567890A');

    const page = new URL(laPosteTrackingUrl(TRACKING_NUMBER));
    expect(page.origin).toBe('https://www.laposte.fr');
    expect(page.searchParams.get('code')).toBe(TRACKING_NUMBER);
    const api = new URL(laPosteTrackingApiUrl(TRACKING_NUMBER));
    expect(api.pathname).toBe(`/ssu/sun/back/suivi-unifie/${TRACKING_NUMBER}`);
    expect(api.searchParams.get('lang')).toBe('fr');
  });

  it('preserves a tracked-mail suffix in requests and enforces its returned identity', async () => {
    const number = '88001234567890A';
    const fixture = deliveredFixture();
    fixture[0]!.shipment.idShip = number;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    await expect(new LaPosteTracker({ fetcher }).fetch('88 0012 3456 7890a'))
      .resolves.toMatchObject({ status: 'delivered' });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe(`/ssu/sun/back/suivi-unifie/${number}`);
    expect(() => parseLaPosteTrackingResponse(fixture, '88001234567890B')).toThrow('different shipment');
  });

  it.each([
    [{ name: 'UPS', reference: 'LOCAL12345' }, 'ups'],
    [{ name: 'Unknown partner label', url: 'https://www.posti.fi/en/tracking#/lahetys/LOCAL12345' }, 'posti'],
    [{ name: 'Posti', url: 'https://www.post.ch/' }, undefined],
    [{ name: 'Unknown carrier', url: 'https://other-carrier.test/' }, undefined],
    [{}, undefined],
  ])('uses structured partner evidence independently of the destination: %j', (partner, expected) => {
    const data = deliveredFixture();
    Object.assign(data[0]!.shipment, { contextData: { arrivalCountry: 'FI', partner } });
    const result = parseLaPosteTrackingResponse(data, TRACKING_NUMBER);
    expect(result.delivery_carrier).toBe(expected);
    expect(result.status).toBe('delivered');
  });

  it('rejects unsupported and unsafe identifiers', () => {
    for (const value of [
      '123',
      'AB1234567890',
      'ABCDEFGHIJKLMNO',
      'AB12345678901&lang=en',
      'AB1234567890É',
      'ABCDEFGHIJKLMN1',
      '870012345678',
      '8700123456789012',
      '8700123456789A',
    ]) {
      expect(() => laPosteTrackingUrl(value)).toThrow('13-, 14- or 15-character');
    }
  });
});

describe('La Poste pickup point address', () => {
  const LOCATOR_PAGE = readFileSync(new URL('./fixtures/locator.html', import.meta.url), 'utf8');
  const feed = (waiting = true) => {
    const data = deliveredFixture();
    Object.assign(data[0]!.shipment, { isFinal: !waiting, contextData: {
      removalPoint: { idPoint: '000001', type: 'LP', isPickUp: false, name: 'EXEMPLEVILLE BP' },
    } });
    if (waiting) {
      data[0]!.shipment.event[1] = { ...data[0]!.shipment.event[1]!, group: 'DISINS', code: 'AG1',
        label: 'Votre colis est disponible dans votre point de retrait.' };
    }
    return data;
  };
  const lookup = (data: LaPosteResponse[], page?: () => Response | Promise<Response>, signal?: AbortSignal) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => (String(url).startsWith('https://localiser.laposte.fr/')
      ? (page ?? (() => new Response(LOCATOR_PAGE)))()
      : Response.json(data)));
    const tracker = new LaPosteTracker({ fetcher });
    return { fetcher, tracker, result: tracker.fetch(TRACKING_NUMBER, { signal }) };
  };

  it('follows the point name with its street and town while the parcel waits there', async () => {
    const waiting = lookup(feed());
    const result = await waiting.result;
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup',
      pickup_point: 'EXEMPLEVILLE BP\n1 RUE EXEMPLE\n00000 EXEMPLEVILLE' });
    expect(JSON.stringify(result)).not.toMatch(/PHONE|CENTRE|17:30|48\.1/);
    const [url, init] = waiting.fetcher.mock.calls[1]!;
    expect(url).toBe('https://localiser.laposte.fr/000001');
    expect(init).toMatchObject({ redirect: 'follow' });
    const collected = lookup(feed(false));
    expect((await collected.result).pickup_point).toBeUndefined();
    expect(collected.fetcher).toHaveBeenCalledOnce();
  });

  it('remembers the address of a point, and asks again after a failure', async () => {
    const failing = lookup(feed(), () => new Response('', { status: 503 }));
    expect((await failing.result).pickup_point).toBe('EXEMPLEVILLE BP');
    failing.fetcher.mockImplementation(async (url) => (String(url).startsWith('https://localiser.laposte.fr/')
      ? new Response(LOCATOR_PAGE) : Response.json(feed())));
    for (let lookups = 0; lookups < 2; lookups += 1) {
      expect((await failing.tracker.fetch(TRACKING_NUMBER)).pickup_point).toBe('EXEMPLEVILLE BP\n1 RUE EXEMPLE\n00000 EXEMPLEVILLE');
    }
    expect(failing.fetcher.mock.calls.filter(([url]) => String(url).startsWith('https://localiser.laposte.fr/'))).toHaveLength(2);
  });

  it.each([
    ['another point', () => new Response(LOCATOR_PAGE.replace('"id":"000001"', '"id":"000002"'))],
    ['a point without a street', () => new Response(LOCATOR_PAGE.replace('"line1":"1 RUE EXEMPLE"', '"line1":null'))],
    ['a page without a record', () => new Response('<html>PRIVATE</html>')],
    ['a malformed record', () => new Response(LOCATOR_PAGE.replace('"meta":{', '"meta":{{'))],
    ['an unknown point', () => new Response('Not found', { status: 404 })],
    ['an outage', () => { throw new TypeError('fetch failed'); }],
  ])('keeps the point name alone after %s', async (_, page) => {
    await expect(lookup(feed(), page).result).resolves.toMatchObject({ pickup_point: 'EXEMPLEVILLE BP' });
  });

  it('asks nothing for a point id it cannot put in a path', async () => {
    const data = feed();
    Object.assign(data[0]!.shipment, { contextData: { removalPoint: { idPoint: '../000001', type: 'LP', name: 'EXEMPLEVILLE BP' } } });
    const odd = lookup(data);
    expect((await odd.result).pickup_point).toBe('EXEMPLEVILLE BP');
    expect(odd.fetcher).toHaveBeenCalledOnce();
  });

  it('ends a lookup cancelled during the address request', async () => {
    const controller = new AbortController();
    const cancelled = lookup(feed(), () => {
      controller.abort(new Error('Cancelled'));
      return new Response('', { status: 503 });
    }, controller.signal);
    await expect(cancelled.result).rejects.toThrow('Cancelled');
  });
});

describe('La Poste transient 403 recovery', () => {
  const rejection = () => new Response('<title>Temporary access refusal</title>', {
    status: 403, headers: { 'Content-Type': 'text/html' },
  });

  const incidentPage = () => new Response(
    '<title>Site indisponible - Incident en cours - La Poste</title>', { status: 403, headers: { 'Content-Type': 'text/html' } },
  );

  it('retries the incident page, which La Poste serves for single requests while the next one succeeds', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      fetcher.mock.calls.length <= 1 ? incidentPage() : Response.json(deliveredFixture())
    ));
    const { recorder, steps } = recordingRecorder();

    await expect(new LaPosteTracker({ recorder }).fetch(TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'challenge'], ['retry', 'ok']]);
  });

  it('still hands a lasting incident to the router after the bounded retries', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => incidentPage());
    await expect(new LaPosteTracker().fetch(TRACKING_NUMBER)).rejects.toMatchObject({
      status: 403, diagnostics: expect.objectContaining({ body_excerpt: expect.stringContaining('Incident en cours') }),
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([1, 2, 3])('recovers after %i immediate retries recorded as the retry step', async (failures) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      fetcher.mock.calls.length <= failures ? rejection() : Response.json(deliveredFixture())
    ));
    const { recorder, steps } = recordingRecorder();

    await expect(new LaPosteTracker({ recorder }).fetch(TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });

    expect(fetcher).toHaveBeenCalledTimes(failures + 1);
    expect(steps.map((step) => step.step))
      .toEqual(['direct', ...Array.from({ length: failures }, () => 'retry')]);
    // Every recovery carries the rejection that caused it, with its bounded
    // response diagnostics, so the host reports each 403 rather than only the last.
    for (const step of steps.slice(1)) {
      expect(step).toMatchObject({ fallbackReason: 'challenge' });
      expect(step.fallbackError).toMatchObject({
        status: 403,
        diagnostics: expect.objectContaining({ body_excerpt: expect.stringContaining('Temporary access refusal') }),
      });
    }
  });

  it('stops after four 403 responses and preserves the last response for router fallback', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => rejection());
    const { recorder, steps } = recordingRecorder();

    await expect(new LaPosteTracker({ recorder }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({
      name: 'UpstreamHttpError', status: 403,
      diagnostics: expect.objectContaining({ body_excerpt: expect.stringContaining('Temporary access refusal') }),
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(steps.map((step) => [step.step, step.outcome]))
      .toEqual([['direct', 'challenge'], ['retry', 'challenge'], ['retry', 'challenge'], ['retry', 'challenge']]);
  });

  it.each([401, 404, 429, 500, 503])('does not retry HTTP %i', async (status) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    const { recorder, steps } = recordingRecorder();

    await expect(new LaPosteTracker({ recorder }).fetch(TRACKING_NUMBER))
      .rejects.toBeInstanceOf(UpstreamHttpError);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(steps.map((step) => step.step)).toEqual(['direct']);
  });

  it('stops retrying if a 403 is followed by another failure', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rejection())
      .mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(new LaPosteTracker().fetch(TRACKING_NUMBER)).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry malformed successful responses', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('invalid json'));
    await expect(new LaPosteTracker().fetch(TRACKING_NUMBER)).rejects.toThrow('invalid tracking response');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('shares the original deadline and stops when a retry exhausts it', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      elapsed += 600.25;
      return rejection();
    });

    await expect(new LaPosteTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ status: 403 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    // Each attempt bounds twice: once for the runner's remaining budget and
    // once for the request itself, both from the same original deadline. While
    // the network retry remains, the request gets half of what is left.
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([1_000, 500, 399, 199]);
  });
});

describe('La Poste network failure recovery', () => {
  it('retries a request that hangs once, inside the original budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: 400, reply: () => Response.json(deliveredFixture()) }]);
    const { recorder, steps } = recordingRecorder();
    const lookup = new LaPosteTracker({ fetcher, recorder }).fetch(TRACKING_NUMBER);
    await vi.advanceTimersByTimeAsync(7_900);
    await expect(lookup).resolves.toMatchObject({ status: 'delivered' });
    // The hung request gets half of the 15-second budget; the retry answers well within the rest.
    expect(ended).toEqual([7_500, 7_900]);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'transport'], ['retry', 'ok']]);
  });

  it('retries a network failure once, then leaves it to the router', async () => {
    fakeBudgetClock();
    const { fetcher } = delayedFetcher([
      { afterMs: 10, failure: new TypeError('fetch failed') }, { afterMs: 10, failure: new TypeError('fetch failed') },
    ]);
    const failure = expect(new LaPosteTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ name: 'UpstreamNetworkError' });
    await vi.advanceTimersByTimeAsync(20);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry a not-found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ returnCode: 104, returnMessage: 'Unknown' }]));
    await expect(new LaPosteTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('La Poste refusal of a number it does not issue', () => {
  const refusal = (returnCode: number) => Response.json({
    status: 400, response: { returnCode, returnMessage: 'Le numéro que vous avez saisi n’est pas valide.', idShip: TRACKING_NUMBER },
  }, { status: 400 });

  it('reads an HTTP 400 with code 412 as invalid input, which recognition counts as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => refusal(412));
    await expect(new LaPosteTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledOnce();
    const instance = adapter({ trawl: null, browserExecutablePath: null, fetcher, recorder: recordingRecorder().recorder, env: {} });
    await expect(instance.recognize!(TRACKING_NUMBER)).resolves.toEqual({ known: false });
  });

  it('keeps any other HTTP 400 an HTTP failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => refusal(400));
    await expect(new LaPosteTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ status: 400, kind: 'transport' });
    await expect(new LaPosteTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toBeInstanceOf(UpstreamHttpError);
    fetcher.mockImplementation(async () => new Response('Bad Request', { status: 400 }));
    await expect(new LaPosteTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ status: 400, kind: 'transport' });
  });
});

describe('La Poste response normalization', () => {
  it('sorts events, maps the official group, and excludes response PII', () => {
    const result = parseLaPosteTrackingResponse(deliveredFixture(), TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Colis livré au destinataire',
      last_update: '2026-01-08T11:14:50+01:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2026-01-08T11:14:50+01:00',
        location: 'FR',
        description: 'Colis livré au destinataire',
        stage: 'delivered',
        provider_code: 'DESBAL/DI1',
      },
      {
        time: '2026-01-07T10:42:00+01:00',
        location: 'FR',
        description: 'Votre colis est en transit',
        stage: 'in_transit',
        provider_code: 'ACHNAT/TR1',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('must never survive');
  });

  it('returns every declared capability from a waiting and a delivered fixture', () => {
    const fixture = deliveredFixture();
    Object.assign(fixture[0]!.shipment, { isFinal: false, contextData: {
      merchantName: 'Example Shop', removalPoint: { type: 'LP', isPickUp: false, name: 'BUREAU EXEMPLE' },
      partner: { name: 'Posti', reference: 'LOCAL12345' },
    } });
    fixture[0]!.shipment.event[1] = { ...fixture[0]!.shipment.event[1]!, group: 'DISINS', code: 'AG1', label: 'Votre colis est disponible dans votre point de retrait.' };
    const result = parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER);
    const delivered = parseLaPosteTrackingResponse(deliveredFixture(), TRACKING_NUMBER);

    expect(CAPABILITIES).toEqual([
      'history', 'location', 'eta', 'sender_name', 'pickup_point', 'delivered_at', 'provider_code',
      'delivery_partner', 'delivery_tracking_number',
    ]);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
    expect(result.expected_delivery).toBe('2026-01-09');
    expect(result.sender_name).toBe('Example Shop');
    expect(result.pickup_point).toBe('BUREAU EXEMPLE');
    expect(result).toMatchObject({ delivery_carrier: 'posti', delivery_tracking_number: 'LOCAL12345' });
    expect(delivered.delivered_at).toBe('2026-01-08T11:14:50+01:00');
  });

  it('keeps a finished delivery over a pre-advice filed after it', () => {
    const withPreAdvice = (isFinal: boolean, lastStep: string) => {
      const fixture = deliveredFixture();
      fixture[0]!.shipment.isFinal = isFinal;
      fixture[0]!.shipment.timeline = [{ id: 5, shortLabel: 'Livré', date: '2026-01-08T11:14:50+01:00', status: true, code: lastStep }];
      fixture[0]!.shipment.event.push({
        group: 'EXPANN', code: 'DR1', label: 'Votre colis est annoncé. Il va nous être confié par l\'expéditeur',
        date: '2026-01-08T11:40:00+01:00', country: 'FR', order: 6,
      });
      return parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER);
    };
    for (const result of [withPreAdvice(true, 'ACHNAT'), withPreAdvice(false, 'DESBAL')]) {
      expect(result).toMatchObject({
        status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-08T11:14:50+01:00',
        last_status_text: 'Colis livré au destinataire', last_update: '2026-01-08T11:40:00+01:00', expected_delivery: null,
      });
      expect(result.events?.map((event) => event.stage)).toEqual(['registered', 'delivered', 'in_transit']);
    }
    // Still open, the newest scan leads as before.
    expect(withPreAdvice(false, 'ACHNAT')).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it("keeps the day of a sender's announcement La Poste dates at midnight", () => {
    const announced = (group: string, date: string) => {
      const fixture = deliveredFixture();
      fixture[0]!.shipment.isFinal = false;
      fixture[0]!.shipment.timeline = [];
      fixture[0]!.shipment.event = [{
        group, code: 'DR1', label: 'Votre Colissimo va bientôt nous être confié !', date, country: 'FR', order: 1,
      }];
      return parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER);
    };
    const result = announced('EXPANN', '2026-01-08T00:00:00+01:00');
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null, last_update_local: '2026-01-08' });
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-01-08', provider_code: 'EXPANN/DR1', stage: 'registered' });
    expect(result.events?.[0]).not.toHaveProperty('time');
    // A time of day, or another group's DR1, keeps its instant.
    expect(announced('EXPANN', '2026-01-08T00:00:01+01:00').events?.[0]).toMatchObject({ time: '2026-01-08T00:00:01+01:00' });
    expect(announced('EXPANN', '2026-01-08T00:00:00+00:00').events?.[0]).toMatchObject({ time: '2026-01-08T00:00:00+00:00' });
    expect(announced('DISINS', '2026-01-08T00:00:00+01:00').events?.[0]).toMatchObject({ time: '2026-01-08T00:00:00+01:00' });
  });

  it('uses timeline data when an announced parcel has no event history', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    fixture[0]!.shipment.event = [];
    fixture[0]!.shipment.timeline = [{
      id: 1,
      shortLabel: 'Information reçue, colis préparé',
      date: '2026-01-02T17:54:00+01:00',
      status: true,
      code: 'ACCEPT',
    }];

    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'pending',
      last_update: '2026-01-02T17:54:00+01:00',
      events: [],
    });
  });

  it('normalizes Chronopost shipments returned by the same unified API', () => {
    const chronopostNumber = 'PZ123456785JF';
    const fixture = deliveredFixture();
    fixture[0]!.shipment.idShip = chronopostNumber;
    fixture[0]!.shipment.product = 'chronopost';
    fixture[0]!.shipment.event = [{
      group: '',
      code: 'DI1',
      label: 'Livraison effectuée',
      date: '2026-08-13T09:55:00+02:00',
      country: '',
      order: 100,
      recipientAddress: 'must never survive normalization',
    }];

    const result = parseLaPosteTrackingResponse(fixture, chronopostNumber);
    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Livraison effectuée',
      delivery_carrier: 'chronopost',
      events: [{ provider_code: 'DI1', stage: 'delivered' }],
    });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('must never survive');
  });

  it('hands a Chronopost item to Chronopost, under the identity the feed answered', () => {
    const fixture = deliveredFixture();
    Object.assign(fixture[0]!.shipment, { idShip: 'XA123456785FR', product: 'Chronopost', contextData: {
      partner: { name: 'Posti', reference: 'LOCAL12345' },
    } });
    const result = parseLaPosteTrackingResponse(fixture, 'XA123456785FR');
    expect(result).toMatchObject({ delivery_carrier: 'chronopost' });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(deliveryHandoff('la-poste', 'XA123456785FR', result))
      .toEqual({ carrier: 'chronopost', number: 'XA123456785FR', basis: 'partner' });
    Object.assign(fixture[0]!.shipment, { idShip: '87001234567890I' });
    expect(parseLaPosteTrackingResponse(fixture, '87001234567890')).toMatchObject({
      delivery_carrier: 'chronopost', delivery_tracking_number: '87001234567890I',
    });
    fixture[0]!.shipment.product = 'colissimo';
    expect(parseLaPosteTrackingResponse(fixture, '87001234567890')).toMatchObject({
      delivery_carrier: 'posti', delivery_tracking_number: 'LOCAL12345',
    });
  });

  it('uses return semantics rather than treating every final event as delivered', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.event = [{
      group: '',
      code: 'DI2',
      label: 'Colis mis à disposition du vendeur suite à un retour',
      date: '2026-08-14T10:00:00+02:00',
      country: 'FR',
      order: 101,
      recipientAddress: '',
    }];

    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'exception',
      events: [{ stage: 'returned', provider_code: 'DI2' }],
    });
  });

  it('lets explicit incidents override codes and recognizes pickup readiness', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    fixture[0]!.shipment.event = [{
      group: '',
      code: 'DR1',
      label: 'Incident : livraison impossible',
      date: '2026-08-14T10:00:00+02:00',
      country: 'FR',
      order: 101,
      recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'exception',
      events: [{ stage: 'exception' }],
    });

    fixture[0]!.shipment.event = [{
      group: 'DISMAD',
      code: 'AG1',
      label: 'Votre colis est disponible au point de retrait',
      date: '2026-08-14T11:00:00+02:00',
      country: 'FR',
      order: 102,
      recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      events: [{ stage: 'ready_for_pickup' }],
    });
  });

  it('declares the parcel stage so a pickup point is never read as out for delivery', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    // The same sentence arrives under the delivery-round group; the code and the wording both say pickup.
    const waiting = 'Votre Colissimo vous attend dans votre point de retrait. Le délai de retrait est de 5 jours.';
    fixture[0]!.shipment.event = [{
      group: 'DISTOU', code: 'AG1', label: waiting,
      date: '2026-08-14T11:00:00+02:00', country: 'FR', order: 102, recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      events: [{ stage: 'ready_for_pickup', provider_code: 'DISTOU/AG1' }],
    });
    expect(eventStage('DISTOU', '', waiting)).toBe('ready_for_pickup');
    expect(eventStage('', 'AG1', 'Colis mis à disposition au point de retrait')).toBe('ready_for_pickup');
    expect(eventStage('DISINS', 'AG1', 'Votre colis est disponible dans votre point de retrait pendant un délai de 15 jours calendaires.')).toBe('ready_for_pickup');
  });

  it('reads a missed delivery that announces the pickup point as a failed attempt', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    fixture[0]!.shipment.event = [{
      group: 'DISIECHEC', code: 'MD3',
      label: 'Nous sommes passés mais nous n\'avons pu vous remettre votre colis. Il va être acheminé vers votre point de retrait.',
      date: '2026-08-14T08:00:00+02:00', country: 'FR', order: 101, recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'exception',
      current_stage: 'failed_attempt',
      events: [{ stage: 'failed_attempt' }],
    });
    // The group alone is enough when La Poste rewords the sentence.
    expect(eventStage('DISIECHEC', 'MD3', 'Passage du facteur')).toBe('failed_attempt');
  });

  it('separates the entry into customs from the release', () => {
    expect(eventStage('AARIDOU', 'DO1', 'Les formalités import/export sont en cours sur votre colis.')).toBe('customs');
    expect(eventStage('', 'DO1', 'Votre colis est arrivé dans le pays de destination')).toBe('customs');
    expect(eventStage('AARENDDOU', 'DO2', 'Les formalités import/export de votre colis sont terminées et il poursuit son acheminement.')).toBe('in_transit');
    expect(eventStatus('AARIDOU', 'DO1', 'Les formalités import/export sont en cours sur votre colis.', true)).toBe('in_transit');
  });

  it('stages the sort into the delivery round as out for delivery, for parcels and letters', () => {
    for (const item of ['colis', 'envoi']) {
      const label = `Votre ${item} est sur son site de distribution. Nous le préparons pour le mettre en livraison.`;
      const data = deliveredFixture();
      data[0]!.shipment.event = [{ group: 'DISTOU', code: 'MD1', label, date: '2026-01-01T12:00:00Z', country: 'FR', order: 1 }];
      expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER)).toMatchObject({
        status: 'out_for_delivery', current_stage: 'out_for_delivery', events: [{ stage: 'out_for_delivery' }],
      });
    }
    expect(eventStage('DISTOU', 'MD1', 'Votre colis est en cours de livraison')).toBe('out_for_delivery');
  });

  it('does not confuse a delivery driver or a future delivery with delivery', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.isFinal = false;
    fixture[0]!.shipment.event = [{
      group: '',
      code: '',
      label: 'En cours de livraison par le livreur',
      date: '2026-08-14T11:00:00+02:00',
      country: 'FR',
      order: 102,
      recipientAddress: '',
    }];
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      events: [{ stage: 'out_for_delivery' }],
    });

    fixture[0]!.shipment.event[0]!.label = 'Votre colis va être livré prochainement';
    expect(parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER)).toMatchObject({
      status: 'in_transit',
      events: [{ stage: 'in_transit' }],
    });
  });

  it('reads a Colissimo partner scan abroad as the wall clock under the Paris offset', () => {
    const data = deliveredFixture();
    data[0]!.shipment.event = [
      { group: 'DESLIVD', code: 'DI1', label: 'Votre colis a été livré', date: '2026-07-06T15:40:00+02:00', country: 'FI', order: 3 },
      { group: 'DISINTAS', code: 'ET3', label: 'Votre colis est arrivé dans le pays de destination', date: '2026-07-05T20:25:00+02:00', country: 'FI', order: 2 },
      { group: 'ACHINT', code: 'ET1', label: 'Votre colis est en cours d\'acheminement', date: '2026-07-04T18:00:00+02:00', country: 'FR', order: 1 },
    ];
    const result = parseLaPosteTrackingResponse(data, TRACKING_NUMBER);
    expect(result.events?.map((event) => event.time)).toEqual([
      '2026-07-06T15:40:00+03:00', '2026-07-05T20:25:00+03:00', '2026-07-04T18:00:00+02:00',
    ]);
    expect(result).toMatchObject({ last_update: '2026-07-06T15:40:00+03:00', delivered_at: '2026-07-06T15:40:00+03:00' });

    // Switzerland keeps Paris's clock; a country with several keeps the wall clock alone.
    data[0]!.shipment.event[0]!.country = 'CH';
    data[0]!.shipment.event[1]!.country = 'US';
    const placed = parseLaPosteTrackingResponse(data, TRACKING_NUMBER);
    expect(Date.parse(placed.events![0]!.time!)).toBe(Date.parse('2026-07-06T15:40:00+02:00'));
    expect(placed.events?.[1]).toMatchObject({ time: '', local_time: '2026-07-05T20:25:00', location: 'US' });
    data[0]!.shipment.event.shift();
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER)).toMatchObject({ last_update: null, last_update_local: '2026-07-05T20:25:00' });
  });

  it('reads an imported letter\'s partner scan as the wall clock read as UTC', () => {
    const data = deliveredFixture();
    data[0]!.shipment.product = 'Lettre et PPI import suivi';
    data[0]!.shipment.event = [
      { group: 'ACHORI', code: 'ET2', label: 'Votre courrier est prêt à quitter son pays d\'origine', date: '2026-07-08T16:10:00+02:00', country: 'IN', order: 2 },
      { group: 'EDRINT', code: 'PC2', label: 'Votre courrier a été déposé chez notre partenaire', date: '2026-07-09T21:15:00+02:00', country: 'GB', order: 1 },
    ];
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER).events?.map((event) => event.time)).toEqual([
      '2026-07-08T14:10:00+05:30', '2026-07-09T19:15:00+01:00',
    ]);

    // Its arrival and transit in France keep the feed's instant, as its delivery scans do.
    const imported = deliveredFixture();
    imported[0]!.shipment.product = 'Lettre et PPI import suivi';
    imported[0]!.shipment.event = [
      { group: 'DISTOU', code: 'MD1', label: 'Votre envoi est sur son site de distribution.', date: '2026-07-11T07:57:29+02:00', country: 'FR', order: 3 },
      { group: 'ACHNAT', code: 'ET1', label: 'Votre envoi est en transit sur nos plateformes.', date: '2026-07-10T00:44:59+02:00', country: 'FR', order: 2 },
      { group: 'ACHFR', code: 'ET3', label: 'Votre envoi vient d\'arriver en France.', date: '2026-07-09T15:59:49+02:00', country: 'FR', order: 1 },
    ];
    expect(parseLaPosteTrackingResponse(imported, TRACKING_NUMBER).events?.map((event) => event.time)).toEqual([
      '2026-07-11T07:57:29+02:00', '2026-07-10T00:44:59+02:00', '2026-07-09T15:59:49+02:00',
    ]);

    // Other products keep the feed's instant until their partner scans are compared.
    data[0]!.shipment.product = 'Lettre recommandée';
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER).events?.map((event) => event.time)).toEqual([
      '2026-07-08T16:10:00+02:00', '2026-07-09T21:15:00+02:00',
    ]);
  });

  it('reads the partner scan of a tracked letter sent abroad as the wall clock read as UTC', () => {
    // Live shape: a Dutch scan reached the feed before the instant it was labelled.
    const letter = 'LA000000000FR';
    const data = deliveredFixture();
    data[0]!.shipment.idShip = letter;
    data[0]!.shipment.product = 'Lettre suivie internationale';
    data[0]!.shipment.event = [
      { group: 'DISINTAS', code: 'ET3', label: 'Votre envoi poursuit son acheminement sur son territoire de destination.', date: '2026-07-09T18:16:00+02:00', country: 'NL', order: 2 },
      { group: 'ACHORI', code: 'ET2', label: 'Votre envoi est prêt à partir de son territoire d’expédition.', date: '2026-07-08T18:01:00+02:00', country: 'FR', order: 1 },
    ];
    expect(parseLaPosteTrackingResponse(data, letter).events?.map((event) => event.time)).toEqual([
      '2026-07-09T16:16:00+02:00', '2026-07-08T18:01:00+02:00',
    ]);
    // A Colissimo item keeps its own reading, and a domestic number the feed's instant.
    data[0]!.shipment.product = 'Colissimo';
    expect(parseLaPosteTrackingResponse(data, letter).events?.[0]?.time).toBe('2026-07-09T18:16:00+02:00');
    data[0]!.shipment.product = 'Lettre suivie internationale';
    data[0]!.shipment.idShip = TRACKING_NUMBER;
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER).events?.[0]?.time).toBe('2026-07-09T18:16:00+02:00');
  });

  it('keeps the feed\'s instant for scans in France and its overseas departments', () => {
    const data = deliveredFixture();
    data[0]!.shipment.event = [
      { group: 'DESLIVD', code: 'DI1', label: 'Votre colis a été livré', date: '2026-07-06T15:40:00+02:00', country: 'RE', order: 2 },
      { group: 'ACHINT', code: 'ET1', label: 'Votre colis est en cours d\'acheminement', date: '2026-07-04T18:00:00+02:00', country: 'FR', order: 1 },
    ];
    expect(parseLaPosteTrackingResponse(data, TRACKING_NUMBER).events?.map((event) => event.time)).toEqual([
      '2026-07-06T15:40:00+02:00', '2026-07-04T18:00:00+02:00',
    ]);
  });

  it('rejects provider errors and responses for another parcel', () => {
    let providerError: unknown;
    try {
      parseLaPosteTrackingResponse([{
        returnCode: 104,
        returnMessage: 'Unknown shipment',
      }], TRACKING_NUMBER);
    } catch (error) {
      providerError = error;
    }
    expect(providerError).toMatchObject({
      name: 'LaPosteTrackingError',
      kind: 'not_found',
      code: 104,
      message: 'La Poste could not locate the shipment',
      status: 404,
    });
    expect(String(providerError)).not.toContain('Unknown shipment');

    const fixture = deliveredFixture();
    fixture[0]!.shipment.idShip = 'ZZ12345678901';
    expect(() => parseLaPosteTrackingResponse(fixture, TRACKING_NUMBER))
      .toThrow('different shipment');
  });

  it('rejects null provider codes and impossible calendar dates', () => {
    const nullCode = deliveredFixture();
    nullCode[0]!.returnCode = null as unknown as number;
    expect(() => parseLaPosteTrackingResponse(nullCode, TRACKING_NUMBER))
      .toThrow('tracking is unavailable');

    const invalidDates = deliveredFixture();
    invalidDates[0]!.shipment.isFinal = false;
    invalidDates[0]!.shipment.estimDate = '2026-02-30T18:00:00+01:00';
    invalidDates[0]!.shipment.event[1]!.date = '2026-02-30T11:14:50+01:00';
    const result = parseLaPosteTrackingResponse(invalidDates, TRACKING_NUMBER);
    expect(result.expected_delivery).toBeNull();
    expect(result.events?.[0]?.time).toBe('');
  });
});

describe('La Poste status vocabulary', () => {
  it('lets the code outrank the group and incident wording outrank both', () => {
    expect(eventStatus('EXPANN', 'MD1', 'Votre colis est en cours de livraison', true)).toBe('out_for_delivery');
    expect(eventStatus('DESBAL', 'DI1', 'Incident : livraison impossible', true)).toBe('exception');
    expect(eventStage('ACHNAT', 'PC1', 'Votre colis a été pris en charge')).toBe('accepted');
    const postponed = 'Votre colis ne peut être livré ce jour. Il sera mis en livraison au plus tôt.';
    expect(eventStatus('DISIRST', 'PB1', postponed, true)).toBe('exception');
    expect(eventStage('DISIRST', 'PB1', postponed)).toBe('failed_attempt');
    expect(eventStage('DISAADR', 'PB1', "L'adresse de livraison est incomplète et nous ne pouvons pas vous livrer votre colis.")).toBe('exception');
    const released = "Les formalités d'importation de votre envoi sont terminées et il sera livré contre paiement de droits et taxes de douane.";
    expect(eventStatus('AARTAXDOU', 'DO2', released, true)).toBe('in_transit');
    expect(eventStage('AARTAXDOU', 'DO2', released)).toBe('in_transit');
    const expired = "Votre colis vous a attendu dans votre point de retrait jusqu'à la date limite. Nous sommes contraints de le renvoyer à l'expéditeur.";
    // A return is open until the parcel is back with its sender.
    expect(eventStage('AARIREXP', 'RE1', expired)).toBe('exception');
    expect(eventStatus('AARIREXP', 'RE1', expired, true)).toBe('exception');
    expect(eventStage('AARIREXP', 'RE1', "Votre Colissimo n'a pas pu vous être livré en raison d'un problème d'adresse. Il va être retourné à l'expéditeur."))
      .toBe('exception');
    expect(eventStage('RETOUR', '', "Votre colis est en cours de retour vers l'expéditeur.")).toBe('exception');
    expect(eventStage('DESLREXP', 'DI2', "Votre colis est livré à son expéditeur à la suite d'un retour.")).toBe('returned');
    expect(eventStage('DESMDREXP', '', 'Colis mis à disposition du vendeur suite à un retour')).toBe('returned');
    expect(eventStage('', '', "Votre colis est livré à son expéditeur à la suite d'un retour.")).toBe('returned');
    expect(statusMap.stage('AARIREXP/RE1', expired)).toBe('exception');
    expect(statusMap.stage('DESLREXP/DI2', "Votre colis est livré à son expéditeur à la suite d'un retour.")).toBe('returned');
    const paidAtDoor = 'Vous avez payé vos droits et taxes de douane lors de la distribution.';
    expect(eventStage('DESPAY', 'DO4', paidAtDoor)).toBe('delivered');
    expect(eventStatus('DESPAY', 'DO4', paidAtDoor, true)).toBe('delivered');
    expect(eventStage('AARPAY', 'DO4', 'Les droits et taxes de douane de cet envoi ont été payés en ligne.')).toBe('customs');
    expect(eventStage('EDRINT', 'PC2', "Votre colis a été déposé par l'expéditeur chez notre partenaire postal dans son pays d'origine.")).toBe('accepted');
  });
});

describe('La Poste adapter factory', () => {
  it.each(['87001234567890', '870012345678901'])('retrieves tracked mail without changing the numeric identifier: %s', async (number) => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.idShip = number;
    fixture[0]!.shipment.product = 'Envoi suivi';
    fixture[0]!.shipment.event[1]!.label = 'Votre envoi a été distribué.';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(fixture));
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: recordingRecorder().recorder, env: {} });

    await expect(instance.track({ number })).resolves.toMatchObject({ status: 'delivered' });
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe(`/ssu/sun/back/suivi-unifie/${number}`);

    const wrong = deliveredFixture();
    wrong[0]!.shipment.idShip = `${number.slice(0, -1)}2`;
    expect(() => parseLaPosteTrackingResponse(wrong, number)).toThrow('different shipment');
    expect(() => parseLaPosteTrackingResponse([{ returnCode: 104 }], number)).toThrow('could not locate');
  });

  it('accepts the feed answering a Smart Data number under its check character', () => {
    const fixture = deliveredFixture();
    fixture[0]!.shipment.idShip = '87001234567890I';
    expect(parseLaPosteTrackingResponse(fixture, '87001234567890')).toMatchObject({
      status: 'delivered', canonical_tracking_number: '87001234567890I',
    });
    expect(parseLaPosteTrackingResponse(fixture, '87001234567890I').canonical_tracking_number).toBeUndefined();
    fixture[0]!.shipment.idShip = '87001234567890J';
    expect(() => parseLaPosteTrackingResponse(fixture, '87001234567890')).toThrow('different shipment');
    fixture[0]!.shipment.idShip = '86601234567890N';
    expect(() => parseLaPosteTrackingResponse(fixture, '87001234567890')).toThrow('different shipment');
  });

  it('declares the direct and retry tiers and fetches the bounded official endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(deliveredFixture()),
    );
    const { recorder } = recordingRecorder();
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder, env: {} });

    expect(instance.id).toBe('la-poste');
    expect(instance.steps).toEqual(['direct', 'retry']);
    await expect(instance.track({ number: TRACKING_NUMBER })).resolves.toMatchObject({
      status: 'delivered',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requested, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(requested)).searchParams.get('lang')).toBe('fr');
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
  });
});
