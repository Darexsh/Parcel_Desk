import { describe, expect, it } from 'vitest';
import { ProxyAgent } from 'undici';
import { RoadieTracker } from './adapter.js';

describe('Roadie live guest tracking', () => {
  it.skipIf(!process.env.ROADIE_TRACKING_NUMBER || !process.env.ROADIE_PROXY_URL)('retrieves the identified delivery through US egress', async () => {
    const proxy = new URL(process.env.ROADIE_PROXY_URL!);
    const dispatcher = new ProxyAgent({ uri: proxy.origin,
      token: `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` });
    try {
      const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit);
      const result = await new RoadieTracker({ fetcher }).fetch(process.env.ROADIE_TRACKING_NUMBER!);
      expect(result.events?.length).toBeGreaterThan(0);
      expect(result.current_stage).toBeDefined();
    } finally { await dispatcher.close(); }
  }, 20_000);
});
