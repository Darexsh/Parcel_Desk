/* global Bun */
// Run with Bun inside the same pinned image as the primary TRAWL service.
import { BrowserPool } from '../../../browser/src/pool.ts';
import { FedExSessions, fedexSessionNumber } from './fedex-session.mjs';
import { createFedExIpv6Proxy } from './fedex-ipv6-proxy.mjs';

const pool = new BrowserPool({ poolSize: 1, recycleAfterTemporaryContexts: 0, contentProcesses: 2,
  label: 'fedex-ipv6', blockAds: true });
const sessions = new FedExSessions();
const proxies = new Set();
const bindings = new WeakMap();
let active = false, stopping = false;
await pool.init();

async function bind(browser) {
  if (bindings.has(browser)) return bindings.get(browser);
  const original = browser.newContext.bind(browser);
  const binding = { current: null };
  browser.newContext = async options => {
    const proxy = await createFedExIpv6Proxy(); proxies.add(proxy);
    try {
      const context = await original({ ...options, proxy: { server: proxy.url } });
      binding.current = proxy;
      context.once('close', () => { proxies.delete(proxy); void proxy.close(); });
      return context;
    } catch (error) { proxies.delete(proxy); await proxy.close(); throw error; }
  };
  bindings.set(browser, binding);
  return binding;
}

const server = Bun.serve({
  hostname: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8192),
  maxRequestBodySize: 16_384, idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ status: stopping ? 'stopping' : 'ok', mode: 'fedex-ipv6' }, { status: stopping ? 503 : 200 });
    if (path !== '/scrape' || request.method !== 'POST') return new Response(null, { status: 404 });
    let body;
    try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
    if (!fedexSessionNumber(body?.url, body) || body.skipHttp !== true || body.maxTier !== 3
      || !Number.isFinite(body.maxTimeout) || body.maxTimeout < 1) return new Response(null, { status: 400 });
    if (stopping || active) return new Response(null, { status: 503, headers: { 'Retry-After': '1' } });
    active = true;
    const started = Date.now(); let handle, context;
    try {
      const budget = Math.min(40_000, body.maxTimeout);
      handle = await pool.acquire('www.fedex.com', budget);
      const binding = await bind(handle.browser);
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0 || request.signal.aborted) return new Response(null, { status: 504 });
      const cancel = () => { handle.requestBrowserReplacement?.('FedEx IPv6 request cancelled'); };
      request.signal.addEventListener('abort', cancel, { once: true });
      let result;
      try {
        result = await sessions.run({ url: body.url, handle, tier: 3, maxTimeout: remaining,
          capture: { captureResponses: body.captureResponses, settleTimeout: 250 } });
      } finally { request.signal.removeEventListener('abort', cancel); }
      context = binding.current;
      const proof = context?.proof() ?? { family: 'unknown', pageConnections: 0, apiConnections: 0 };
      // No rendered page, cookies, proxy address or destination addresses leave this endpoint.
      return Response.json({ ...result, html: '', body: '', cookies: [], fedexEgress: proof });
    } catch { return new Response(null, { status: 502 }); }
    finally { if (handle) pool.release(handle.id, handle.lease); active = false; }
  },
});

async function shutdown() {
  if (stopping) return;
  stopping = true; server.stop(true);
  await pool.shutdown();
  await Promise.allSettled([...proxies].map(proxy => proxy.close()));
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
