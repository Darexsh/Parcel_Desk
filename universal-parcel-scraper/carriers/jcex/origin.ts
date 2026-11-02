import { setTimeout as pause } from 'node:timers/promises';
import type { Dispatcher } from 'undici';

const HOST = 'track.jcex.com';
// The same guest API is served by this origin when JCEX's CDN stops answering.
const ORIGIN = '45.113.202.100';

/** Pin only the socket address: the URL, HTTP host, SNI and certificate checks stay JCEX's. */
export async function withJcexOrigin<T>(signal: AbortSignal, timeoutMs: number, read: (dispatcher: Dispatcher) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const { Agent } = await import('undici');
  signal.throwIfAborted();
  const dispatcher = new Agent({ autoSelectFamily: false, connect: {
    timeout: Math.max(1, Math.floor(timeoutMs)), servername: HOST,
    lookup(hostname, _options, callback) {
      if (hostname !== HOST) { callback(new Error('JCEX origin is restricted to its tracking host'), '', 4); return; }
      callback(null, ORIGIN, 4);
    },
  } });
  try { return await read(dispatcher); }
  finally {
    const cleanup = new AbortController();
    try {
      await Promise.race([dispatcher.destroy().catch(() => {}),
        pause(1_000, undefined, { signal: AbortSignal.any([signal, cleanup.signal]), ref: false }).catch(() => {})]);
    } finally { cleanup.abort(); }
  }
}
