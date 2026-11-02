import { AdapterRegistry, trackCarrier, REGISTRY } from '../node.js';
import expected from './registeredCarrierResults.json' with { type: 'json' };
const createAdapterRegistry = (environment: ConstructorParameters<typeof AdapterRegistry>[1]) => new AdapterRegistry(REGISTRY, environment);
class CarrierTrackingAdapter {
 constructor(readonly universal: UniversalTracker, readonly registry: AdapterRegistry, readonly recorder = NOOP_RECORDER) {}
 fetch(carrier: string, number: string, trackingUrl: string | null) {
   return trackCarrier(carrier, { number, trackingUrl }, this);
 }
}
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import type { TrawlClient } from '../core/transport/index.js';
import type { UniversalTracker } from '../providers/universal.js';
import { CorreiosOcr } from '../carriers/correios-br/ocr.js';
import { UkrposhtaTracker } from '../carriers/ukrposhta/adapter.js';
import { parseUkrposhtaHistory, parseUkrposhtaOverview } from '../carriers/ukrposhta/parser.js';
import * as yundaChallenge from '../carriers/yunda/challenge.js';

const cases = [
  { carrier: 'austrian-post', number: '1000000000000000000001', fixture: 'delivered.json' },
  { carrier: 'tnt', number: '1000000000000001', fixture: 'registered.html' },
  { carrier: 'ontrac', number: '1LS0000000000001', fixture: 'delivered.json' },
  { carrier: 'blue-dart', number: '00000000001', fixture: 'delivered.html' },
  { carrier: 'delhivery', number: '0000000000001', fixture: 'delivered.json' },
  { carrier: 'aramex', number: '00000000001', fixture: 'delivered.html', unresolved: true },
  { carrier: 'four-px', number: '4PX0000000000001CN', fixture: 'delivered.json', unresolved: true },
  { carrier: 'singapore-post', number: 'CZ000000014SG', fixtureNumber: 'CZ000000005SG', fixture: 'speedpost.json', unresolved: true },
  { carrier: 'korea-post', number: 'EE000000014KR', fixtureNumber: 'EE000000005KR', fixture: 'delivered.html', unresolved: true },
  { carrier: 'yamato', number: '123456789023', fixtureNumber: '1234-5678-9012', fixture: 'delivered.html', unresolved: true },
  { carrier: 'yanwen', number: 'UK000000014YP', fixtureNumber: 'UK000000005YP', fixture: 'delivered.html' },
  { carrier: 'dtdc', number: 'N00000001', fixture: 'delivered.json' },
  { carrier: 'yunexpress', number: 'YT0000000000000001', fixture: 'in-transit.json', unresolved: true },
  { carrier: 'postnord', number: '00573000000000000001', fixture: 'delivered.json' },
  { carrier: 'bpost', number: '000000000000000000000001', fixture: 'delivered.json' },
  { carrier: 'purolator', number: '100000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'yto', number: 'YT0000000000001', fixture: 'delivered.json' },
  { carrier: 'correios-br', number: 'AA000000014BR', fixtureNumber: 'AA000000005BR', fixture: 'delivered.json' },
  { carrier: 'yunda', number: '0000000000001', fixture: 'delivered.json' },
  { carrier: 'ems', number: 'EB000000014CN', fixture: 'positive.html', unresolved: true },
  { carrier: 'spring-gds', number: 'LX123456799NL', fixtureNumber: 'LX123456785NL', fixture: 'delivered.json', unresolved: true },
  { carrier: 'uniuni', number: 'UUS0000000000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'ctt-express', number: '0000000000000000000001', fixture: 'pickup.json', unresolved: true },
  { carrier: 'pos-malaysia', number: 'RR000000014MY', fixtureNumber: 'RR000000005MY', fixture: 'international.json', unresolved: true },
  { carrier: 'canpar', number: 'C000000000000000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'ninja-van', number: 'NLMYA00000001', fixtureNumber: 'NLMYA00000000', fixture: 'returned.json', unresolved: true },
  { carrier: 'correos-chile', number: 'SX000000014CL', fixtureNumber: 'SX000000005CL', fixture: 'customs.json', unresolved: true },
  { carrier: 'gofo', number: 'GFUS00000000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'ecoscooting', number: '000000000000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'landmark-global', number: 'LTN00000001N1', fixture: 'delivered.html', unresolved: true },
  { carrier: 'correos-express', number: '9900000000000002', fixture: 'history.html', unresolved: true },
  { carrier: 'nz-post', number: '00000000000000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'poczta-polska', number: '00000000000000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'the-courier-guy', number: 'TESTA1', fixture: 'delivered.json', unresolved: true },
  { carrier: 'bring-posten', number: '00000000000000001', fixture: 'delivered.json', unresolved: true },
  { carrier: 'estafeta', number: '9000000001', fixture: 'delivered-lookup.html', unresolved: true },
  { carrier: 'canada-post', number: '0073938000999999', fixture: 'delivered.json', unresolved: true },
  { carrier: 'nacex', number: '9900/99000002', fixture: 'history.html', unresolved: true },
  { carrier: 'ukrposhta', number: 'RR000000014UA', fixtureNumber: 'RR000000005UA', fixture: 'delivered.json', unresolved: true },
  { carrier: 'seur', number: '9900002', fixture: 'history.json', unresolved: true },
  { carrier: 'brt', number: '99000000000002', fixture: 'history.html', unresolved: true },
  { carrier: 'landmark-global', number: 'LTN000000009', fixture: 'in-transit-nine-digit.html', unresolved: true },
  { carrier: 'gofo', number: 'GFUS00000000000001', fixture: 'public-counter.json', unresolved: true },
  { carrier: 'ecoscooting', number: 'CNPRT00000000000000000001', fixture: 'delivered-portugal.json', unresolved: true },
  { carrier: 'uniuni', number: 'UUSC000000000001', fixture: 'uusc-delivered.json', unresolved: true },
  { carrier: 'estafeta', number: '900000000001A000000002', fixture: 'full-guide-lookup.html', unresolved: true },
  { carrier: 'the-courier-guy', number: 'LD000001', fixture: 'pudo-delivered.json', unresolved: true },
  { carrier: 'the-courier-guy', number: 'DD000001', fixture: 'collection-cancelled.json', unresolved: true },
  { carrier: 'relais-colis', number: 'CC200000000401', fixture: 'grouped-history.html', unresolved: true },
  { carrier: 'ciblex', number: '000000000000000000000001', fixture: 'full-barcode.html', unresolved: true },

];

function setup(entry: typeof cases[number], transform = (body: string) => body) {
  let body = readFileSync(new URL(`../carriers/${entry.carrier}/fixtures/${entry.fixture}`, import.meta.url), 'utf8');
  // A fixture written for a placeholder number answers here for a number lookups accept.
  if (entry.fixtureNumber) body = body.replaceAll(entry.fixtureNumber, entry.number);
  if (entry.carrier === 'four-px') {
    const value = JSON.parse(body);
    for (const scan of value.data[0].tracks) scan.tkTimezone = '';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'yunexpress') {
    const value = JSON.parse(body);
    value.ResultList[0].TrackInfo.LastTrackEvent.GmtProcessTimezone = '';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'spring-gds') {
    const value = JSON.parse(body);
    value.data.items[0].events[0].country_code = 'US';
    value.data.items[0].events[0].country_name = 'United States';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'uniuni') {
    const value = JSON.parse(body);
    delete value.data.valid_tno[0].spath_list.at(-1).dateTime.ts;
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'ctt-express') {
    const value = JSON.parse(body);
    value.data.shipping_history.events.at(-1).event_date = '2026-01-04T10:00:00';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'pos-malaysia') {
    body = JSON.stringify({ code: 'S0000', message: 'Success', data: [JSON.parse(body)] });
  }
  if (entry.carrier === 'ninja-van') {
    const value = JSON.parse(body);
    value.events.at(-2).time = '2026-02-30T09:00:00Z';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'seur') {
    const value = JSON.parse(body);
    value.situaciones[0].fecha = '2026-01-23T13:13:05';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'landmark-global') body = body.replace(/<input id="utc_server_offset"[^>]*>/, '');
  if (entry.carrier === 'nz-post') {
    const value = JSON.parse(body);
    value.results[0].tracking_events.at(-1).date_time = '2026-01-05T10:00:00';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'gofo') {
    // The newest scan without its offset, on its own wall clock.
    const value = JSON.parse(body);
    const newest = entry.fixture === 'public-counter.json' ? '2026-01-20T15:00:00.000' : '2026-01-04T12:00:00.000';
    value.data.success[0].trackEventList[0].processDate = newest;
    value.data.success[0].lastTrackEvent.processDate = newest;
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'ecoscooting') {
    const value = JSON.parse(body);
    delete value.statuses[0].opTimestamp;
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'the-courier-guy') {
    const value = JSON.parse(body);
    value.shipments[0].tracking_events[0].date = '2026-01-06T12:00:00';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'bring-posten') {
    const value = JSON.parse(body);
    const parcel = value.consignmentWithDomainAsync.packageSet[0];
    parcel.eventSet[0].dateIso = parcel.domain.latestSignificantEvent.dateIso = '2026-01-06T12:00:00';
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'canada-post') {
    const value = JSON.parse(body);
    delete value.events[0].datetime.zoneOffset;
    body = JSON.stringify(value);
  }
  if (entry.carrier === 'relais-colis') body = body.replace('28-04-2026 à 15h21', '28-04-2026');
  if (entry.carrier === 'ciblex') body = body.replace('10:01:23', 'invalid clock');
  body = transform(body);
  if (entry.carrier === 'ukrposhta') {
    const payload = JSON.parse(body);
    vi.spyOn(UkrposhtaTracker.prototype, 'fetch').mockResolvedValue(
      parseUkrposhtaHistory(payload.history, parseUkrposhtaOverview(payload.overview, entry.number)));
  }
  if (entry.carrier === 'correios-br') vi.spyOn(CorreiosOcr.prototype, 'solve').mockResolvedValue('abcd');
  if (entry.carrier === 'yunda') vi.spyOn(yundaChallenge, 'solveYundaSlider').mockResolvedValue({ x: 100, y: 40 });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (entry.carrier === 'correos-chile' && init?.method !== 'POST') {
      const page = readFileSync(new URL('../carriers/correos-chile/fixtures/bootstrap.html', import.meta.url), 'utf8');
      return new Response(page, { headers: [
        ['set-cookie', 'JSESSIONID=syntheticSession123; Path=/; Secure; HttpOnly'],
        ['set-cookie', 'SERVER_ID=syntheticServer123; Path=/; Secure'],
      ] });
    }
    if (entry.carrier === 'relais-colis' && init?.method !== 'POST') {
      return new Response('<input id="track_package__token" value="synthetic-csrf-token">');
    }
    if (entry.carrier === 'nacex') {
      if (String(url).endsWith('/irSeguimiento.do')) {
        return new Response('<form name="seguimientoFormulario" method="post" action="/seguimientoFormulario.do"><input name="agencia_origen"><input name="numero_albaran"></form>',
          { headers: { 'set-cookie': 'JSESSIONID=synthetic-session; Path=/' } });
      }
      if (String(url).endsWith('/seguimientoFormulario.do')) {
        return new Response(null, { status: 302, headers: {
          location: '/seguimientoDetalle.do?agencia_origen=9900&numero_albaran=99000002&estado=1&internacional=0&externo=N&usr=null&pas=null',
        } });
      }
      return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (entry.carrier === 'estafeta' && String(url).endsWith('/GetTrackingItemHistory')) {
      return new Response(readFileSync(new URL(`../carriers/estafeta/fixtures/${entry.fixture === 'full-guide-lookup.html' ? 'full-guide-history.html' : 'delivered-history.html'}`, import.meta.url), 'utf8'));
    }
    if (entry.carrier === 'poczta-polska' && String(url) === 'https://emonitoring.poczta-polska.pl/') {
      return new Response(readFileSync(new URL('../carriers/poczta-polska/fixtures/bootstrap.html', import.meta.url), 'utf8'));
    }
    if (entry.carrier === 'spring-gds' && String(url).endsWith('/auth/token')) return Response.json({ access_token: 'synthetic-visitor-token' });
    if (entry.carrier === 'yunda') {
      if (String(url).includes('/captcha_type?')) return Response.json({ code: 200, data: 1 });
      if (String(url).includes('/captcha?')) return Response.json({ code: 200, data: {} });
    }
    if (entry.carrier === 'correios-br') {
      if (String(url).includes('/app/index.php')) return new Response('<html>Tracking</html>');
      if (String(url).includes('/securimage_show.php')) return new Response('synthetic image', { headers: { 'content-type': 'image/png' } });
    }
    if (entry.carrier === 'aramex' && String(url).includes('/track/shipments')) {
      return new Response(`<a class="shipment-card" href="/track/details?q=synthetic"><div class="shipment-num"><h5>${entry.number}</h5></div></a>`);
    }
    return new Response(body, { headers: { 'content-type': entry.carrier === 'brt' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' } });
  });
  const trawl = entry.carrier === 'yunexpress' ? { scrape: vi.fn().mockResolvedValue({
    capturedResponses: [{ url: 'https://services.yuntrack.com/Track/Query', status: 200,
      body, base64Encoded: false, truncated: false, error: null }],
  }) } : null;
  const registry = createAdapterRegistry({ fetcher, trawl: trawl as unknown as TrawlClient | null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
  const universal = { fetch: vi.fn() };
  const adapter = new CarrierTrackingAdapter(universal as unknown as UniversalTracker, registry, NOOP_RECORDER);
  return { adapter, registry, fetcher };
}


afterEach(() => vi.restoreAllMocks());
describe('registered adapter result contracts', () => {
 it.each(cases)('$carrier normalizes its synthetic response', async entry => {
  const test = setup(entry);
  expect(await test.adapter.fetch(entry.carrier, entry.number, null)).toEqual(
    (expected as Record<string, { result?: unknown }>)[`${entry.carrier}/${entry.fixture}/`]!.result);
 });
});
