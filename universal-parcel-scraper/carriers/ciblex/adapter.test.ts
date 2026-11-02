import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import {
  CiblexTracker,
  adapter,
  ciblexTrackingUrl,
  normalizeCiblexTrackingNumber,
  parseCiblexTrackingHtml,
} from './adapter.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { classifyCiblexStatus, comparableText, isCiblexNotice } from './status.js';

// Fully synthetic identifier paired with a deterministic provider-shaped HTML
// fixture. Ciblex does not publish a reusable demo shipment number.
const TEST_TRACKING_NUMBER = '12345678901234';

type Row = [string, string, string, string];

function json(relativePath: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));
}

const carrier = json('./carrier.json') as { capabilities: readonly string[] };
const timeline = json('./fixtures/delivered-timeline.json') as { rows: Row[]; pickupRows: Row[] };

function trackingPage(options: {
  trackingNumber?: string;
  rows?: Row[];
  privateDetail?: string;
} = {}): string {
  const trackingNumber = options.trackingNumber ?? TEST_TRACKING_NUMBER;
  const rows = options.rows ?? timeline.rows;
  return `<!doctype html><html><body>
    <table class="t_bandeau_detail"><tr><td>&nbsp;SUIVI COLIS : ${trackingNumber}</td></tr></table>
    <table class="private"><tr><td>${options.privateDetail ?? 'PRIVATE CUSTOMER AND ORDER'}</td></tr></table>
    <table border="2" bgcolor="#205AA7" cellpadding="2" cellspacing="2">
      <tr class="t_liste_titre">
        <td>&nbsp;Date&nbsp;</td><td>&nbsp;Heure livraison&nbsp;</td>
        <td>&nbsp;Action&nbsp;</td><td>&nbsp;Lieu&nbsp;</td>
      </tr>
      ${rows.map(([date, time, action, location]) => `<tr class="t_liste_ligne">
        <td>${date}</td><td>${time}</td><td>${action}</td><td>${location}</td>
      </tr>`).join('')}
    </table>
    <script>window.privateEmail = 'private@example.test';</script>
  </body></html>`;
}

function emptyTrackingPage(trackingNumber = TEST_TRACKING_NUMBER): string {
  return trackingPage({ trackingNumber, rows: [] });
}

afterEach(() => vi.restoreAllMocks());

describe('Ciblex anonymous tracking input', () => {
  it('accepts fourteen-digit labels and full twenty-four digit barcodes without extracting aliases', () => {
    expect(normalizeCiblexTrackingNumber('12 3456 7890 1234')).toBe(TEST_TRACKING_NUMBER);
    const url = new URL(ciblexTrackingUrl(TEST_TRACKING_NUMBER));
    expect(url.origin).toBe('https://secure.extranet.ciblex.fr');
    expect(url.pathname).toBe('/extranet/client/corps.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      module: 'colis',
      colis: TEST_TRACKING_NUMBER,
    });
    const full = '990000000000000000000001';
    expect(normalizeCiblexTrackingNumber('9900 0000 0000 0000 0000 0001')).toBe(full);
    expect(new URL(ciblexTrackingUrl(full)).searchParams.get('colis')).toBe(full);
  });

  it('rejects unsupported lengths, non-ASCII input, and parameter injection', () => {
    for (const value of [
      '1234567890123',
      '123456789012345',
      '1234567890123A',
      '1234567890123É',
      '12345678901234&module=admin',
      '99000000000000000000001',
      '9900000000000000000000001',
    ]) expect(() => normalizeCiblexTrackingNumber(value)).toThrow('14 or 24 digits');
  });
});

describe('Ciblex status vocabulary', () => {
  it('compares wording without case or diacritics and leaves new wording unmapped', () => {
    expect(comparableText('COLIS LIVRÉ')).toBe('colis livre');
    expect(classifyCiblexStatus('Colis Livré')).toMatchObject({ stage: 'delivered' });
    expect(classifyCiblexStatus('COLIS LIVRE')).toMatchObject({ stage: 'delivered' });
    expect(classifyCiblexStatus('Statut provider nouveau')).toMatchObject({
      status: 'unknown',
      stage: 'in_transit',
      description: 'Ciblex tracking update',
    });
    for (const wording of ['Colis livré demain', 'Sera remis au destinataire', 'Pas livraison effectuée', 'Retour expéditeur prévu']) {
      expect(classifyCiblexStatus(wording).status).toBe('unknown');
    }
  });

  it('leaves the service notice and the ambiguous non-handover without a stage', () => {
    // Seen only before the first scan, where it can mean the shipper did not hand the parcel
    // over; the same words also say a parcel was not delivered.
    expect(classifyCiblexStatus('COLIS NON REMIS')).toMatchObject({ status: 'unknown', description: 'Ciblex tracking update' });
    expect(classifyCiblexStatus('Acheminement contractuel du colis en 48h00')).toMatchObject({ status: 'unknown' });
    expect(isCiblexNotice('Acheminement contractuel du colis en 48h00')).toBe(true);
    expect(isCiblexNotice('ACHEMINEMENT CONTRACTUEL DU COLIS EN 24H')).toBe(true);
    for (const wording of ['COLIS NON REMIS', 'Colis Contrôle', 'Acheminement contractuel du colis en retard']) {
      expect(isCiblexNotice(wording)).toBe(false);
    }
  });
});

describe('Ciblex response normalization', () => {
  it('projects a full native banner while excluding all parenthesized annotations and private places', () => {
    const html = readFileSync(new URL('./fixtures/full-barcode.html', import.meta.url), 'utf8');
    const result = parseCiblexTrackingHtml(html, '000000000000000000000001');
    expect(result.status).toBe('delivered'); expect(result.events).toHaveLength(8);
    expect(result.events?.[0]!.time).toBe('2026-01-23T10:01:23+01:00');
    expect(result.events?.[4]!.stage).toBeUndefined(); expect(result.events?.[7]!.stage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    for (const invalid of [html.replace('(0000000000001)', 'other shipment 0000000000001'), html.replace('(0000000000001)', '(nested (0000000000001))')]) {
      expect(() => parseCiblexTrackingHtml(invalid, '000000000000000000000001')).toThrow(SchemaError);
    }
  });

  it('keeps ambiguous or nonexistent Paris DST clocks local without inventing an instant', () => {
    for (const [day, local] of [['29/03/2026', '2026-03-29T02:30:00'], ['25/10/2026', '2026-10-25T02:30:00']] as const) {
      const result = parseCiblexTrackingHtml(trackingPage({ rows: [[day, '02:30', 'Colis Livré', ''], ['22/01/2026', '09:00', 'Colis Contrôle', '']] }), TEST_TRACKING_NUMBER);
      expect(result.status).toBe('delivered'); expect(result.last_update).toBeNull(); expect(result.last_update_local).toBe(local);
      expect(result.events?.[0]!.local_time).toBe(local); expect(result.events?.[0]!.time).toBeUndefined(); expect(result.delivered_at).toBeUndefined();
    }
  });
  it('requires the complete full barcode, rejecting suffix aliases, truncated and duplicate banners', () => {
    const full = '990000000000000000000001';
    expect(parseCiblexTrackingHtml(trackingPage({ trackingNumber: full }), full).events).toHaveLength(4);
    for (const [returned, requested] of [[full.slice(-14), full], [full, full.slice(0, 14)], [full + '0', full]] as const) {
      expect(() => parseCiblexTrackingHtml(trackingPage({ trackingNumber: returned }), requested)).toThrow(SchemaError);
    }
    const duplicated = load(trackingPage({ trackingNumber: full })); duplicated('body').append(duplicated('.t_bandeau_detail').clone());
    expect(() => parseCiblexTrackingHtml(duplicated.html(), full)).toThrow(SchemaError);
  });

  it('retains unresolved newest clocks and unknown statuses without borrowing older delivery', () => {
    for (const [day, time] of [['31/02/2026', '09:00'], ['23/01/2026', '24:00'], ['23/01/2026', '09:99'], ['31/02/2026', ''], ['', '']] as const) {
      const rows: Row[] = [[day, time, 'Statut provider nouveau', 'PRIVATE ADDRESS'], ['22/01/2026', '09:00', 'Colis Livré', '']];
      const result = parseCiblexTrackingHtml(trackingPage({ rows }), TEST_TRACKING_NUMBER);
      expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined(); expect(result.last_update).toBeNull();
      expect(result.events?.[0]!.time).toBeUndefined(); expect(result.events?.[0]!.provider_time_text).toBe([day, time].filter(Boolean).join(' ') || undefined);
      expect(result.events?.[0]!.stage).toBeUndefined(); expect(result.events?.[1]!.stage).toBe('delivered');
      expect(JSON.stringify(result)).not.toContain('PRIVATE ADDRESS');
    }
    // A scan dated by its day alone keeps that day, and still borrows no older delivery.
    const dayOnly = parseCiblexTrackingHtml(trackingPage({ rows: [['23/01/2026', '', 'Statut provider nouveau', ''], ['22/01/2026', '09:00', 'Colis Livré', '']] }), TEST_TRACKING_NUMBER);
    expect(dayOnly).toMatchObject({ status: 'unknown', last_update: null, last_update_local: '2026-01-23' });
    expect(dayOnly.events?.[0]).toMatchObject({ local_time: '2026-01-23' }); expect(dayOnly.events?.[0]!.provider_time_text).toBeUndefined();
    const knownTime: Row[] = [['23/01/2026', '09:00', 'Statut provider nouveau', ''], ['22/01/2026', '09:00', 'Colis Livré', '']];
    expect(parseCiblexTrackingHtml(trackingPage({ rows: knownTime }), TEST_TRACKING_NUMBER).status).toBe('unknown');
  });

  it('reads the depot town without its department and depot codes', () => {
    const rows: Row[] = [
      ['22/07/2026', '05:55:02', 'Mis en livraison', 'EXAMPLEVILLE 99 (99 99X)'],
      ['10/07/2026', '06:02', 'Colis Contrôle', 'SAINT-EXEMPLE SUR MER 98 (98 7)'],
      ['10/07/2026', '06:01', 'Colis Contrôle', 'Exampletown 99 (99)'],
      ['09/07/2026', '15:39', 'Colis Contrôle', 'EXAMPLEVILLE 99 (98 99X)'],
      ['09/07/2026', '15:38', 'Colis Contrôle', 'EXAMPLEVILLE 99'],
      ['09/07/2026', '15:37', 'Colis Contrôle', '10 PRIVATE STREET 99 (99 99X)'],
      ['09/07/2026', '15:36', 'COMPLEMENT ADRESSE', 'PRIVATE PLACE 99 (99 99X)'],
    ];
    const result = parseCiblexTrackingHtml(trackingPage({ rows }), TEST_TRACKING_NUMBER);
    expect(result.events?.map(event => event.location)).toEqual(['EXAMPLEVILLE', 'SAINT-EXEMPLE SUR MER', 'Exampletown 99 (99)', '', '', '', '']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|99X/);
  });

  it('reads the town alone of a hub written with its department only', () => {
    const rows: Row[] = [
      ['10/07/2026', '06:02', 'Colis Contrôle', 'EXAMPLEVILLE 44 (44 49X)'],
      ['09/07/2026', '15:39', 'Colis Contrôle', 'SAINT-EXEMPLE 69'],
      ['09/07/2026', '15:38', 'Colis Contrôle', "L'EXEMPLE-SUR-MER 06"],
      ['09/07/2026', '15:37', 'Colis Contrôle', 'Exampletown 974'],
      ['09/07/2026', '15:36', 'Colis Contrôle', 'EXAMPLEVILLE 00'],
      ['09/07/2026', '15:35', 'Colis Contrôle', 'EXAMPLEVILLE 96'],
      ['09/07/2026', '15:34', 'Colis Contrôle', 'EXAMPLEVILLE 6'],
      ['09/07/2026', '15:33', 'Colis Contrôle', 'EXAMPLEVILLE 977'],
      ['09/07/2026', '15:32', 'Colis Contrôle', 'PRIVATE STREET 75 10'],
      ['09/07/2026', '15:31', 'Colis Contrôle', '10 PRIVATE STREET 75'],
      ['09/07/2026', '15:30', 'COMPLEMENT ADRESSE', 'PRIVATE PLACE 75'],
    ];
    const result = parseCiblexTrackingHtml(trackingPage({ rows }), TEST_TRACKING_NUMBER);
    expect(result.events?.map(event => event.location)).toEqual([
      'EXAMPLEVILLE', 'SAINT-EXEMPLE', "L'EXEMPLE-SUR-MER", 'Exampletown', '', '', '', '', '', '', '',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|49X/);
  });

  it('lets a stored hub scan without its town gain it in place', () => {
    const rows: Row[] = [['09/07/2026', '15:39', 'Colis Contrôle', 'SAINT-EXEMPLE 69'], ['09/07/2026', '15:39', 'Colis Contrôle', 'SAINT-EXEMPLE 69']];
    const [scan] = parseCiblexTrackingHtml(trackingPage({ rows }), TEST_TRACKING_NUMBER).events ?? [];
    const incoming = { stage: scan!.stage ?? '', description: scan!.description ?? '', location: scan!.location ?? '', providerCode: '' };
    const policy = sameInstantIdentityPolicy('ciblex', { supportsScanMatching: true });
    expect(incoming.location).toBe('SAINT-EXEMPLE');
    expect(policy?.matches?.(incoming, { ...incoming, location: '' })).toBe(true);
    expect(policy?.matches?.(incoming, { ...incoming, location: 'EXAMPLEVILLE' })).toBe(false);
  });

  it('keeps the newest scan deciding over a later service notice', () => {
    const rows: Row[] = [
      ['10/07/2026', '06:03', 'Acheminement contractuel du colis en 48h00', ''],
      ['10/07/2026', '06:02', 'Colis Contrôle', 'EXAMPLEVILLE 99 (99 99X)'],
      ['09/07/2026', '08:17', 'COLIS NON REMIS', ''],
    ];
    const result = parseCiblexTrackingHtml(trackingPage({ rows }), TEST_TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Ciblex tracking update', last_update: '2026-07-10T06:03:00+02:00' });
    expect(result.events?.map(event => event.stage)).toEqual([undefined, 'in_transit', undefined]);
    // Before its first scan, the parcel's state stays unknown.
    const waiting = parseCiblexTrackingHtml(trackingPage({ rows: rows.slice(2) }), TEST_TRACKING_NUMBER);
    expect(waiting.status).toBe('unknown');
    expect(waiting.current_stage).toBeUndefined();
    expect(parseCiblexTrackingHtml(trackingPage({ rows: rows.slice(0, 1) }), TEST_TRACKING_NUMBER).status).toBe('unknown');
  });

  it('keeps equal-clock native positions and distinct redacted sites while collapsing only identical scans', () => {
    const rows: Row[] = [['23/01/2026', '09:00', 'Colis Livré', 'PRIVATE SITE A'], ['23/01/2026', '09:00', 'Mis en livraison', 'PRIVATE SITE B'],
      ['23/01/2026', '09:00', 'Colis Livré', 'PRIVATE SITE C'], ['23/01/2026', '09:00', 'Colis Livré', 'PRIVATE SITE A']];
    const result = parseCiblexTrackingHtml(trackingPage({ rows }), TEST_TRACKING_NUMBER);
    expect(result.status).toBe('delivered'); expect(result.events?.map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'delivered']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE SITE');
  });

  it('rejects changed, incomplete or excessive histories instead of treating malformed scans as unknown parcels', () => {
    const header = trackingPage().replace('Heure livraison', 'Different heading');
    const malformed = load(trackingPage()); malformed('.t_liste_ligne').first().children().last().remove();
    const table = load(trackingPage()); table('body').append(table('table[border="2"]').clone());
    for (const html of [header, malformed.html(), table.html(), trackingPage({ rows: [['23/01/2026', '09:00', '', '']] }),
      trackingPage({ rows: Array(501).fill(['23/01/2026', '09:00', 'Colis Contrôle', '']) })]) {
      expect(() => parseCiblexTrackingHtml(html, TEST_TRACKING_NUMBER)).toThrow(SchemaError);
    }
    const many: Row[] = Array.from({ length: 120 }, (_,i) => ['23/01/2026', '09:00', `Provider wording ${i}`, '']);
    expect(parseCiblexTrackingHtml(trackingPage({ rows: many }), TEST_TRACKING_NUMBER).events).toHaveLength(100);
  });
  it('normalizes a provider-shaped history without retaining unrelated or unsafe fields', () => {
    const result = parseCiblexTrackingHtml(trackingPage(), TEST_TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2021-12-30T05:29:00+01:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([{
      time: '2021-12-30T05:29:00+01:00',
      location: '',
      description: 'Delivered',
      stage: 'delivered',
      provider_status: 'Colis Livré',
    }, {
      time: '2021-12-30T05:24:00+01:00',
      location: 'Sausheim 68 (68)',
      description: 'Out for delivery',
      stage: 'out_for_delivery',
      provider_status: 'Mis en livraison',
    }, {
      time: '2021-12-30T05:24:00+01:00',
      location: 'Sausheim 68 (68)',
      description: 'Parcel processed at Ciblex facility',
      stage: 'in_transit',
      provider_status: 'Colis Contrôle',
    }, {
      time: '2021-12-28T09:27:00+01:00',
      location: '',
      description: 'Shipment exception',
      stage: 'exception',
      provider_status: 'COMPLEMENT ADRESSE',
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE CUSTOMER AND ORDER');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('PRIVATE STREET');
  });

  it('produces every capability carrier.json declares', () => {
    const result: CarrierResult = parseCiblexTrackingHtml(trackingPage(), TEST_TRACKING_NUMBER);
    const events = result.events ?? [];
    const produced = new Set([
      ...(events.length > 0 ? ['history'] : []),
      ...(events.some((event) => event.location) ? ['location'] : []),
      ...(events.some((event) => event.provider_code) ? ['provider_code'] : []),
      ...(result.expected_delivery ? ['eta'] : []),
      ...(result.expected_delivery_from ? ['eta_window'] : []),
      ...(result.sender_name ? ['sender_name'] : []),
      ...(result.pickup_point ? ['pickup_point'] : []),
      ...(result.weight_kg != null ? ['weight'] : []),
      ...(result.dimensions_text ? ['dimensions'] : []),
      ...(result.delivered_at ? ['delivered_at'] : []),
    ]);
    expect(carrier.capabilities.length).toBeGreaterThan(0);
    for (const capability of carrier.capabilities) expect([...produced]).toContain(capability);
  });

  it('maps pickup, returned, unknown, and accepted events to safe descriptions', () => {
    const result = parseCiblexTrackingHtml(
      trackingPage({ rows: timeline.pickupRows }),
      TEST_TRACKING_NUMBER,
    );
    expect(result).toMatchObject({
      status: 'exception',
      events: [
        { description: 'Returned to sender', stage: 'returned' },
        { description: 'Ready for pickup', stage: 'ready_for_pickup' },
        { description: 'Shipment collected', stage: 'accepted' },
        { description: 'Ciblex tracking update', provider_status: 'Statut provider nouveau' },
      ],
    });
  });

  it('separates the echoed empty table from a bare empty response', () => {
    let error: unknown;
    try {
      parseCiblexTrackingHtml(emptyTrackingPage(), TEST_TRACKING_NUMBER);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NoHistoryError);
    expect(error).toMatchObject({
      kind: 'indeterminate',
      status: 502,
      provider: 'Ciblex',
      message: 'Ciblex returned no parcel history',
    });

    let empty: unknown;
    try {
      parseCiblexTrackingHtml('', TEST_TRACKING_NUMBER);
    } catch (caught) {
      empty = caught;
    }
    expect(empty).toBeInstanceOf(IndeterminateError);
    expect(empty).not.toBeInstanceOf(NoHistoryError);
    expect(empty).toMatchObject({
      kind: 'indeterminate',
      status: 502,
      message: 'Ciblex returned an empty tracking response',
    });
  });

  it('rejects mismatched and malformed provider pages', () => {
    expect(() => parseCiblexTrackingHtml(
      trackingPage({ trackingNumber: '99999999999999' }),
      TEST_TRACKING_NUMBER,
    )).toThrow(SchemaError);
    expect(() => parseCiblexTrackingHtml(
      trackingPage({ trackingNumber: '99999999999999' }),
      TEST_TRACKING_NUMBER,
    )).toThrow('different shipment');
    expect(() => parseCiblexTrackingHtml('<html>generic page</html>', TEST_TRACKING_NUMBER))
      .toThrow('shipment identifier');
    let form: unknown;
    try {
      parseCiblexTrackingHtml('<html><p class="f_erreur">CODE BORDEREAU OBLIGATOIRE !</p></html>', TEST_TRACKING_NUMBER);
    } catch (caught) {
      form = caught;
    }
    expect(form).toBeInstanceOf(IndeterminateError);
    expect(form).not.toBeInstanceOf(NoHistoryError);
  });
});

describe('Ciblex tracker', () => {
  it('tracks full barcodes through the factory without rewriting them and skips unsupported recognition shapes', async () => {
    const full = '990000000000000000000001';
    const fetcher = vi.fn<typeof fetch>(async url => {
      expect(new URL(String(url)).searchParams.get('colis')).toBe(full);
      return new Response(trackingPage({ trackingNumber: full }));
    });
    const instance = adapter({ fetcher, env: {}, recorder: { step() {}, lookup() {} }, trawl: null, browserExecutablePath: null });
    expect(await instance.recognize!('unsupported')).toEqual({ known: false }); expect(fetcher).not.toHaveBeenCalled();
    expect((await instance.track({ number: full })).status).toBe('delivered'); expect(fetcher).toHaveBeenCalledTimes(1);
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(new Response(emptyTrackingPage(full)));
    await expect(adapter({ fetcher: unknown, env: {}, recorder: { step() {}, lookup() {} }, trawl: null, browserExecutablePath: null }).recognize!(full)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('classifies endpoint errors and bounds actual response allocation', async () => {
    for (const [status,kind] of [[302,'indeterminate'],[404,'indeterminate'],[410,'indeterminate'],[403,'challenge'],[429,'rate_limited'],[503,'maintenance']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('',{status}));
      await expect(new CiblexTracker({fetcher}).fetch(TEST_TRACKING_NUMBER)).rejects.toMatchObject({kind}); expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(750_001)));
    await expect(new CiblexTracker({fetcher:oversized}).fetch(TEST_TRACKING_NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('honors the current HTTP encoding over the stale HTML meta tag', async () => {
    const body = trackingPage().replace('<body>', '<meta charset="ISO-8859-1"><body>');
    const utf8 = vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{headers:{'Content-Type':'text/html;charset=UTF-8'}}));
    expect((await new CiblexTracker({fetcher:utf8}).fetch(TEST_TRACKING_NUMBER)).status).toBe('delivered');
    const latin = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from(body,'latin1'),{headers:{'Content-Type':'text/html;charset=ISO-8859-1'}}));
    expect((await new CiblexTracker({fetcher:latin}).fetch(TEST_TRACKING_NUMBER)).status).toBe('delivered');
    const changed = vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{headers:{'Content-Type':'text/html;charset=UTF-16'}}));
    await expect(new CiblexTracker({fetcher:changed}).fetch(TEST_TRACKING_NUMBER)).rejects.toMatchObject({kind:'schema'});
  });

  it('propagates caller cancellation and rejects late successes after a fractional total deadline', async () => {
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(new Response(trackingPage()));
    await expect(new CiblexTracker({fetcher:immediate}).fetch(TEST_TRACKING_NUMBER,{signal:AbortSignal.abort()})).rejects.toBeInstanceOf(Error);
    await expect(new CiblexTracker({fetcher:immediate}).fetch(TEST_TRACKING_NUMBER,{budgetMs:0})).rejects.toMatchObject({kind:'budget'}); expect(immediate).not.toHaveBeenCalled();
    const controller=new AbortController();
    const pending=vi.fn<typeof fetch>(async (_url,init)=>{await new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});});return new Response('');});
    const active=new CiblexTracker({fetcher:pending}).fetch(TEST_TRACKING_NUMBER,{signal:controller.signal}); controller.abort();
    await expect(active).rejects.toMatchObject({kind:'transport'});
    const late=vi.fn<typeof fetch>(async()=>{await new Promise(resolve=>setTimeout(resolve,35));return new Response(trackingPage());});
    await expect(new CiblexTracker({fetcher:late}).fetch(TEST_TRACKING_NUMBER,{budgetMs:20.5})).rejects.toMatchObject({kind:'budget'});
  });
  it('fetches and parses the bounded anonymous official page', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      trackingPage(),
      { headers: { 'Content-Type': 'text/html; charset=UTF-8' } },
    ));

    await expect(new CiblexTracker({ timeoutMs: 1_000 }).fetch(TEST_TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(ciblexTrackingUrl(TEST_TRACKING_NUMBER));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'manual' });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('cookie')).toBe(false);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('recognizes the live wrong-number shape even though Ciblex returns HTTP 200', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(emptyTrackingPage('12345678901234')));
    await expect(new CiblexTracker({ timeoutMs: 1_000 }).fetch('12345678901234')).rejects.toMatchObject({
      name: 'NoHistoryError',
      kind: 'indeterminate',
      status: 502,
      message: 'Ciblex returned no parcel history',
    });

    fetcher.mockResolvedValueOnce(new Response(''));
    await expect(new CiblexTracker({ timeoutMs: 1_000 }).fetch('12345678901234'))
      .rejects.toThrow('empty tracking response');
  });
});
