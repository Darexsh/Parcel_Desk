import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HAPPY_POST_API, HappyPostTracker } from './adapter.js';
import { normalizeHappyPostNumber, parseHappyPost } from './parser.js';
import { happyPostLabel, happyPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '12340001';
const IN_TRANSIT = '12340002';
const UNKNOWN = '12340003';

type Step = Record<string, unknown>;
type Reply = { tracking: Step[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (steps: Step[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.tracking, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
// The API's answer for a number it does not know: no body, and the methods the view allows.
const absent = () => new Response(null, { status: 404, headers: { Allow: 'GET, OPTIONS', 'Content-Language': 'fr' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const SITE_404 = '<!DOCTYPE html><html lang="fr"><head><meta name="robots" content="noindex, nofollow" /></head><body>Page introuvable</body></html>';

describe('Happy-Post HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HappyPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HAPPY_POST_API}${IN_TRANSIT}`);
    expect(String(url)).toBe('https://app.happy-post.com/api/v1/tracking/12340002');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'happy-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the steps reached as wall clocks, newest first in journey order, and names the delivering network', () => {
    const result = normalizeCarrierResult(parseHappyPost(fixture('delivered'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Colis livré', last_update: null, last_update_local: '2026-03-09T12:47:00', expected_delivery: null,
      delivery_carrier: 'landmark-global', delivery_tracking_number: 'LB000000014BE' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-03-09T12:47:00', 'delivered', 'Colis livré', 'delivered'],
      // Two steps on one clock keep the reply's order.
      ['2026-03-05T06:30:00', 'international-arrival', 'Arrivée pays de destination', 'in_transit'],
      ['2026-03-05T06:30:00', 'international-transit', 'En transit international', 'in_transit'],
      ['2026-03-04T18:22:09', 'international-departure', 'Départ international', 'in_transit'],
      ['2026-03-04T11:05:43', 'in-imx-hub', 'Arrivée plateforme Happy-Post', 'in_transit'],
      ['2026-03-02T17:40:00', 'collected', 'Colis pris en charge', 'accepted'],
      ['2026-03-02T09:14:27', 'ordered', 'Etiquette créée', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map' && !event.location)).toBe(true);
    // The drop-off network's link on the collected step is not the delivery.
    expect(JSON.stringify(result)).not.toMatch(/XQ000000014FR|chronopost/);
  });

  it('names the delivering network from a step not reached yet', () => {
    const result = parseHappyPost(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrivée plateforme Happy-Post',
      last_update_local: '2026-09-24T08:51:19', delivery_carrier: 'colis-prive', delivery_tracking_number: 'Q0000000000000017' });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['in-imx-hub', 'collected', 'ordered']);
  });

  it('keeps a link it cannot read, or only the drop-off network’s, out of the result', () => {
    const unread = parseHappyPost(changed('in-transit', (steps) => { steps.at(-1)!.tracking_url = 'https://example.com/suivi'; }), IN_TRANSIT);
    expect(unread).not.toHaveProperty('delivery_carrier');
    expect(unread).not.toHaveProperty('delivery_tracking_number');
    const firstMile = parseHappyPost(changed('delivered', (steps) => { steps.at(-1)!.tracking_url = null; }), DELIVERED);
    expect(firstMile).not.toHaveProperty('delivery_carrier');
    expect(firstMile).not.toHaveProperty('delivery_tracking_number');
    const relative = parseHappyPost(changed('in-transit', (steps) => { steps.at(-1)!.tracking_url = '/moncolis?numcolis=Q0000000000000017'; }), IN_TRANSIT);
    expect(relative).not.toHaveProperty('delivery_tracking_number');
  });

  it('shows a step the page has no label for by its code, as the page does', () => {
    const result = parseHappyPost(changed('in-transit', (steps) => {
      steps.push({ step: 'synthetic-step', timestamp: '2026-09-25T10:00:00', tracking_url: null });
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ local_time: '2026-09-25T10:00:00', description: 'synthetic-step', provider_code: 'synthetic-step' });
    // A step without a stage leaves the current stage to the step before it.
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'synthetic-step' });
  });

  it('reads the warehouse and return steps', () => {
    const returned = parseHappyPost(changed('in-transit', (steps) => {
      steps.push({ step: 'returned_to_warehouse', timestamp: '2026-09-30T10:00:00.120', tracking_url: null },
        { step: 'return_to_sender', timestamp: '2026-10-01T09:00:00.450', tracking_url: null });
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Choix client : retour à l’expéditeur.' });
    expect(returned.events![1]).toMatchObject({ provider_code: 'returned_to_warehouse', stage: 'exception' });
  });

  it('reads a reply with no step reached as no history', () => {
    const nothing = changed('in-transit', (steps) => { for (const step of steps) step.timestamp = null; });
    expect(() => parseHappyPost(nothing, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseHappyPost({ tracking: [] }, IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_steps: Step[], body: Reply) => { delete (body as Partial<Reply>).tracking; },
      (_steps: Step[], body: Reply) => { body.tracking = 'steps' as never; },
      (steps: Step[]) => { steps.push(...Array.from({ length: 100 }, () => steps[0]!)); },
      (steps: Step[]) => { steps[0] = 'step' as never; },
      (steps: Step[]) => { delete steps[0]!.step; },
      (steps: Step[]) => { steps[0]!.step = 'Etiquette créée'; },
      (steps: Step[]) => { steps[0]!.step = 7; },
      (steps: Step[]) => { delete steps[0]!.timestamp; },
      (steps: Step[]) => { steps[0]!.timestamp = 1758484431; },
      (steps: Step[]) => { steps[0]!.timestamp = '21/09/2026 20:03'; },
      (steps: Step[]) => { steps[0]!.timestamp = '2026-09-21T20:03:51+02:00'; },
      (steps: Step[]) => { steps[0]!.timestamp = '2026-02-30T20:03:51'; },
      (steps: Step[]) => { steps[0]!.timestamp = '2026-09-21T24:03:51'; },
      (steps: Step[]) => { steps.at(-1)!.tracking_url = { href: 'https://colisprive.com/' }; },
      (steps: Step[]) => { steps.at(-1)!.hp_tracking_url = 5; },
    ]) {
      expect(() => parseHappyPost(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the API’s empty 404 as not found, and recognizes by the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(absent())).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(absent())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // Wall clocks date the parcel's last activity only on its local clock.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-09T12:47:00' });
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    // The site's HTML 404 page is a route the API no longer has, and a bare 404 is not the API's answer.
    await expect(lookup(new Response(SITE_404, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    // The API view's 404 with a body is not its answer for an unknown number.
    await expect(lookup(new Response('{"detail":"Not found."}', { status: 404, headers: { Allow: 'GET, OPTIONS' } })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(new Response(null, { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 302, headers: { Location: 'https://app.happy-post.com/fr/login/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('{"detail":"Forbidden"}', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A browser check, even with HTTP 200 or 404, is never a missing parcel.
    await expect(lookup(new Response(CHECK, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response(CHECK, { status: 404, headers: { 'Content-Type': 'text/html', Allow: 'GET' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Happy-Post</title></html>', { status: 200 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply({ detail: 'Not found.' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      // An HTTP status is never sent again.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a lookup that does not reach the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new HappyPostTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses numbers Happy-Post does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The service reads the number as an integer: a leading zero would name another parcel.
    for (const number of ['012340001', '01234000', '123456', '123400011', 'HP123400', `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHappyPostNumber(' 1234-0001 ')).toBe(DELIVERED);
    expect(normalizeHappyPostNumber('1234000')).toBe('1234000');
  });

  it('routes a number filed under Happy-Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(HAPPY_POST_API)
      ? reply(fixture('in-transit')) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'happy-post' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'happy-post', source: 'happy-post', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${HAPPY_POST_API}${IN_TRANSIT}`)).toBe(true);
  });
});

describe('Happy-Post status vocabulary', () => {
  it('records every step code the map knows with the stage it gives', () => {
    const coded = (statuses.entries as { code?: string; wording: string; stage: string; language: string }[]).filter((entry) => entry.code);
    expect(coded.length).toBeGreaterThan(0);
    for (const entry of coded) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(happyPostStage(entry.code!), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      if (entry.language === 'fr') expect(happyPostLabel(entry.code!), entry.code).toBe(entry.wording);
    }
    expect(statusMapAnswer({ carrier: 'happy-post', providerCode: 'notified', description: 'Avisage' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'happy-post', providerCode: 'synthetic-step', description: 'synthetic-step' })).toEqual({ kind: 'unknown' });
    expect(happyPostStage('synthetic-step')).toBeNull();
  });
});
