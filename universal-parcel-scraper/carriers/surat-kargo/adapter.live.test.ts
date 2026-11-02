import { describe, expect, it } from 'vitest';
import { ProxyAgent } from 'undici';
import { SuratKargoTracker } from './adapter.js';

describe('surat-kargo country-scoped retrieval', () => {
  const ready = Boolean(process.env.SURAT_KARGO_PROXY_URL);
  async function lookup(number: string) {
    const proxy = new URL(process.env.SURAT_KARGO_PROXY_URL!);
    const dispatcher = new ProxyAgent({ uri: proxy.origin,
      token: `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` });
    try {
      const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
      return await new SuratKargoTracker({ fetcher }).fetch(number);
    } finally { await dispatcher.close(); }
  }

  it.skipIf(!ready || !process.env.SURAT_KARGO_TRACKING_NUMBER)('reads operational history through country egress', async () => {
    const result = await lookup(process.env.SURAT_KARGO_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.time)).toBe(true);
  }, 40_000);

  it.skipIf(!ready || !process.env.SURAT_KARGO_UNKNOWN_NUMBER)('preserves the carrier negative-answer semantics', async () => {
    await expect(lookup(process.env.SURAT_KARGO_UNKNOWN_NUMBER!)).rejects.toHaveProperty('kind', 'indeterminate');
  }, 40_000);
});
