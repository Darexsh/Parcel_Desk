import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterFactory } from '../core/adapter/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/trawl.js';
import { adapter as proCarrier } from '../carriers/pro-carrier/adapter.js';
import { adapter as delnext } from '../carriers/delnext/adapter.js';
import { adapter as mrl } from '../carriers/mrl-global/adapter.js';
import { adapter as ait } from '../carriers/ait-worldwide/adapter.js';
import { adapter as hitch } from '../carriers/hitch/adapter.js';
import { adapter as pbt } from '../carriers/pbt/adapter.js';
import { adapter as celeritas } from '../carriers/celeritas/adapter.js';
import { adapter as dpdPt } from '../carriers/dpd-pt/adapter.js';
import { adapter as fleetoptics } from '../carriers/fleetoptics/adapter.js';
import { adapter as horoz } from '../carriers/horoz/adapter.js';
import { adapter as ocasa } from '../carriers/ocasa/adapter.js';
import { adapter as speedex } from '../carriers/speedex/adapter.js';
import { adapter as whistl } from '../carriers/whistl/adapter.js';
import { adapter as citymail } from '../carriers/citymail/adapter.js';
import { adapter as apcOvernight } from '../carriers/apc-overnight/adapter.js';
import { adapter as dhlFreight } from '../carriers/dhl-freight/adapter.js';
import { adapter as globalpost } from '../carriers/globalpost/adapter.js';
import { adapter as hrvatskaPosta } from '../carriers/hrvatska-posta/adapter.js';
import { adapter as loomis } from '../carriers/loomis-express/adapter.js';
import { adapter as mAndP } from '../carriers/m-and-p/adapter.js';
import { adapter as tciExpress } from '../carriers/tci-express/adapter.js';
import { adapter as zeleris } from '../carriers/zeleris/adapter.js';
import { DPD_PT_MAX_BYTES } from '../carriers/dpd-pt/parser.js';
import { FLEETOPTICS_MAX_BYTES } from '../carriers/fleetoptics/parser.js';
import { HOROZ_MAX_BYTES } from '../carriers/horoz/parser.js';
import { OCASA_MAX_BYTES } from '../carriers/ocasa/parser.js';
import { SPEEDEX_MAX_BYTES } from '../carriers/speedex/parser.js';
import { WHISTL_MAX_BYTES } from '../carriers/whistl/parser.js';
import { CITYMAIL_MAX_BYTES } from '../carriers/citymail/parser.js';
import { APC_OVERNIGHT_MAX_BYTES } from '../carriers/apc-overnight/parser.js';
import { DHL_FREIGHT_MAX_BYTES } from '../carriers/dhl-freight/parser.js';
import { GLOBALPOST_MAX_BYTES } from '../carriers/globalpost/parser.js';
import { HRVATSKA_POSTA_MAX_BYTES } from '../carriers/hrvatska-posta/parser.js';
import { LOOMIS_MAX_BYTES } from '../carriers/loomis-express/parser.js';
import { M_AND_P_MAX_BYTES } from '../carriers/m-and-p/parser.js';
import { TCI_EXPRESS_MAX_BYTES } from '../carriers/tci-express/parser.js';
import { ZELERIS_MAX_BYTES } from '../carriers/zeleris/parser.js';

const SERVICE = 'https://browser.test/scrape';
const BLOCK = '<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>';
const pageCaps: Record<string, number> = { 'dpd-pt': DPD_PT_MAX_BYTES, fleetoptics: FLEETOPTICS_MAX_BYTES,
  horoz: HOROZ_MAX_BYTES, ocasa: OCASA_MAX_BYTES, speedex: SPEEDEX_MAX_BYTES, whistl: WHISTL_MAX_BYTES, citymail: CITYMAIL_MAX_BYTES,
  'apc-overnight': APC_OVERNIGHT_MAX_BYTES, 'dhl-freight': DHL_FREIGHT_MAX_BYTES, globalpost: GLOBALPOST_MAX_BYTES,
  'hrvatska-posta': HRVATSKA_POSTA_MAX_BYTES, 'loomis-express': LOOMIS_MAX_BYTES, 'm-and-p': M_AND_P_MAX_BYTES,
  'tci-express': TCI_EXPRESS_MAX_BYTES, zeleris: ZELERIS_MAX_BYTES };
const subjects: [string, AdapterFactory, string, string][] = [
  ['pro-carrier', proCarrier, 'DG00000000001', 'delivered'],
  ['delnext', delnext, 'DNX4T7', 'delivered'],
  ['mrl-global', mrl, 'CAAA000001', 'delivered'],
  ['ait-worldwide', ait, '555000111', 'delivered'],
  ['hitch', hitch, 'ZIP0SYNTHETIC01', 'delivered'],
  ['pbt', pbt, 'ZZD00000002', 'delivered'],
  ['celeritas', celeritas, '912345670', 'transit'],
  ['dpd-pt', dpdPt, '09990000000101', 'delivered'],
  ['fleetoptics', fleetoptics, 'FOAESH1234567', 'delivered'],
  ['horoz', horoz, '12340678901234', 'delivered'],
  ['ocasa', ocasa, '40000000017', 'delivered'],
  ['speedex', speedex, '700000000017', 'delivered'],
  ['whistl', whistl, 'WHI0000GB00000000123', 'own'],
  ['citymail', citymail, 'BCMXY900000001', 'delivered'],
  ['apc-overnight', apcOvernight, '2026010599000010009012', 'delivered'],
  ['dhl-freight', dhlFreight, 'SMP-DL-0000001', 'delivered'],
  ['globalpost', globalpost, 'GPSIZZ9900000017US', 'delivered'],
  ['hrvatska-posta', hrvatskaPosta, 'LW900000019HR', 'locker'],
  ['loomis-express', loomis, 'NET10000001', 'delivered'],
  ['m-and-p', mAndP, '100000000000001', 'delivered'],
  ['tci-express', tciExpress, '100000001', 'delivered'],
  ['zeleris', zeleris, '2472CA19900000123Q', 'delivered'],
];

function harness(subject: typeof subjects[number], direct: () => Response, change: (page: Record<string, unknown>) => void = () => {}) {
  const [id, factory, number, fixture] = subject;
  const html = readFileSync(new URL(`../carriers/${id}/fixtures/${fixture}.html`, import.meta.url), 'utf8');
  const requests: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    urls.push(String(url));
    if (String(url) !== SERVICE) return direct();
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    const page = { url: request.url, html, statusCode: 200, tier: 3 };
    change(page);
    return Response.json(page);
  });
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  const adapter = factory({ fetcher, trawl: new TrawlClient(SERVICE), recorder, env: {}, browserExecutablePath: null });
  return { adapter, requests, urls, recorder, number, html };
}

describe.each(subjects)('%s browser recovery', (id, factory, number, fixture) => {
  const subject: typeof subjects[number] = [id, factory, number, fixture];

  it('recovers the whole history after a 403, with the original failure recorded', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }));
    const result = await h.adapter.track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    const direct = harness(subject, () => new Response(h.html));
    expect(result).toEqual(await direct.adapter.track({ number }));
    expect(direct.requests).toHaveLength(0);
    expect(h.requests).toEqual([expect.objectContaining({ url: h.urls[0], skipHttp: true, maxTier: 3 })]);
    expect(Number(h.requests[0]!.maxTimeout)).toBeGreaterThan(0);
    expect(Number(h.requests[0]!.maxTimeout)).toBeLessThanOrEqual(30_000);
    expect(h.recorder.step.mock.calls.map(([step]) => [step.step, step.outcome, step.fallbackFrom]))
      .toEqual([['direct', 'challenge', null], ['trawl', 'ok', 'direct']]);
    expect(h.recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', attempts: 2, finalStep: 'trawl' }));
  });

  it('recovers an HTTP 200 challenge too', async () => {
    const h = harness(subject, () => new Response(BLOCK));
    await expect(h.adapter.track({ number })).resolves.toHaveProperty('events');
    expect(h.requests).toHaveLength(1);
  });

  it('does not open a browser after a rate limit', async () => {
    const h = harness(subject, () => new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(h.adapter.track({ number })).rejects.toMatchObject({ status: 429 });
    expect(h.requests).toHaveLength(0);
  });

  it('does not open a browser for a changed tracking page', async () => {
    const h = harness(subject, () => new Response('<html><title>Tracking</title><body>Unexpected page</body></html>'));
    await expect(h.adapter.track({ number })).rejects.toBeInstanceOf(Error);
    expect(h.requests).toHaveLength(0);
  });

  if (pageCaps[id]) it('rejects an otherwise valid remote page that exceeds the carrier’s own limit', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => {
      page.html = `${String(page.html)}<!--${'x'.repeat(pageCaps[id]! + 1)}-->`;
    });
    await expect(h.adapter.track({ number })).rejects.toMatchObject({ kind: 'schema' });
    expect(h.requests).toHaveLength(1);
  });

  it('passes cancellation to a service call already in progress', async () => {
    const controller = new AbortController();
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), () => { controller.abort(new Error('cancelled')); });
    await expect(h.adapter.track({ number }, { signal: controller.signal })).rejects.toBeInstanceOf(Error);
    expect(h.requests).toHaveLength(1);
  });

  it('leaves an unresolved HTTP 200 browser challenge challenged', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => { page.html = BLOCK; });
    await expect(h.adapter.track({ number })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('rejects a browser redirect before accepting even a valid history', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => { page.url = 'https://other.test/'; });
    await expect(h.adapter.track({ number })).rejects.toMatchObject({ kind: id === 'zeleris' ? 'indeterminate' : 'transport' });
  });

  it('starts no browser when the caller has insufficient time for recovery', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }));
    await expect(h.adapter.track({ number }, { budgetMs: 200 })).rejects.toMatchObject({ kind: 'budget' });
    expect(h.requests).toHaveLength(0);
  });

  it('starts nothing after cancellation', async () => {
    const h = harness(subject, () => new Response(BLOCK));
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(h.adapter.track({ number }, { signal: controller.signal })).rejects.toBe(reason);
    expect(h.urls).toHaveLength(0);
  });

  it('rejects a complete browser history belonging to another number', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => {
      const before = String(page.html);
      if (id === 'apc-overnight') {
        const $ = load(before);
        $('.con-summary tr').filter((_, row) => $(row).children('th').text().trim() === 'Consignment number:').children('td').text('0009019');
        page.html = $.html();
      } else if (id === 'zeleris') {
        // The printed code is a verified alias of the label code used to ask.
        const $ = load(before);
        $('.zeleris-shipping-tracking-detail-description').text('Pedido 2472F129900000124Q');
        page.html = $.html();
      } else page.html = before.replaceAll(number, `${number.slice(0, -1)}9`);
      expect(page.html).not.toBe(before);
    });
    await expect(h.adapter.track({ number })).rejects.toBeInstanceOf(Error);
  });

  if (!['mrl-global', 'globalpost', 'tci-express'].includes(id)) it('keeps recognition HTTP-only with the service configured', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }));
    await expect(h.adapter.recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
    expect(h.requests).toHaveLength(0);
  });
});

describe.each(subjects.filter(([id]) => ['globalpost', 'zeleris'].includes(id)))('%s browser absence redirects', (id, factory, number, fixture) => {
  const subject: typeof subjects[number] = [id, factory, number, fixture];
  const target = (requested = number, absent = true) => id === 'globalpost'
    ? `https://www.goglobalpost.com/tracking/?${new URLSearchParams({ t: requested, status: absent ? 'not_found' : 'error' })}`
    : `https://www.zeleris.com/seguimiento-de-envios/?${new URLSearchParams({ tracking_number: requested, [absent ? 'not_found' : 'tracking_error']: '1' })}`;

  it('accepts absence only from the carrier’s explicit flag for the whole number', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => { page.url = target(); });
    await expect(h.adapter.track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    expect(h.recorder.step.mock.calls.map(([step]) => [step.step, step.outcome, step.fallbackFrom]))
      .toEqual([['direct', 'challenge', null], ['trawl', 'not_found', 'direct']]);
  });

  it('does not confuse another whole number, a foreign host or a technical error with absence', async () => {
    for (const url of [target(`${number}9`), target().replace('https://www.', 'https://other.'), target(number, false)]) {
      const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => { page.url = url; });
      await expect(h.adapter.track({ number })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|indeterminate)$/) });
    }
  });

  it('preserves a rate limit even when the browser URL has the absence flag', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => { page.url = target(); page.statusCode = 429; });
    await expect(h.adapter.track({ number })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('keeps an HTTP 200 challenge on the redirected page challenged', async () => {
    const h = harness(subject, () => new Response(BLOCK, { status: 403 }), page => { page.url = target(); page.html = BLOCK; });
    await expect(h.adapter.track({ number })).rejects.toMatchObject({ kind: 'challenge' });
  });
});
