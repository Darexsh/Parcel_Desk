import { EventEmitter } from 'node:events';
import { request, type Agent } from 'node:https';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTrusting } from './https.js';

vi.mock('node:https', async (importOriginal) => ({ ...await importOriginal<typeof import('node:https')>(), request: vi.fn() }));

const INTERMEDIATE = '-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----\n';
const URL = 'https://tracking.example.test/track?reference=0';

/** Every request gets this reply, and its written body is kept. */
function answer(statusCode: number, rawHeaders: string[], body = '') {
  const written: (string | undefined)[] = [];
  vi.mocked(request).mockImplementation(((_url: string, _options: unknown, callback: (incoming: unknown) => void) => {
    const outgoing = Object.assign(new EventEmitter(), { end: (sent?: string) => {
      written.push(sent);
      callback(Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { statusCode, statusMessage: 'Synthetic', rawHeaders }));
    } });
    return outgoing;
  }) as unknown as typeof request);
  return written;
}

afterEach(() => vi.mocked(request).mockReset());

describe('fetch trusting extra intermediates', () => {
  it('sends the request through an agent that trusts Node’s roots and the intermediates, and answers its reply', async () => {
    const written = answer(200, ['Content-Type', 'text/html', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2'], '<html>ok</html>');
    const response = await fetchTrusting([INTERMEDIATE])(URL, { method: 'POST', headers: { Accept: 'text/html' },
      body: new URLSearchParams({ reference: '0' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    await expect(response.text()).resolves.toBe('<html>ok</html>');
    const [url, options] = vi.mocked(request).mock.calls[0]! as unknown as [string, { agent: Agent; method: string; headers: Record<string, string> }];
    expect(url).toBe(URL);
    expect(options).toMatchObject({ method: 'POST', headers: { accept: 'text/html', 'content-length': '11' } });
    expect(options.agent.options.ca).toEqual([...rootCertificates, INTERMEDIATE]);
    expect(written).toEqual(['reference=0']);
  });

  it('answers a redirect only to a manual redirect, and an empty reply without a body', async () => {
    answer(302, ['Location', '/elsewhere']);
    const trusting = fetchTrusting([INTERMEDIATE]);
    await expect(trusting(URL, { redirect: 'manual' })).resolves.toMatchObject({ status: 302 });
    await expect(trusting(URL)).rejects.toThrow(TypeError);
    await expect(trusting(URL, { redirect: 'follow' })).rejects.toThrow(TypeError);
    answer(204, []);
    expect((await trusting(URL)).body).toBeNull();
  });

  it('refuses a body that is not text, and rejects when the request fails', async () => {
    const trusting = fetchTrusting([INTERMEDIATE]);
    await expect(trusting(URL, { method: 'POST', body: new Uint8Array([1]) })).rejects.toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
    const failure = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    vi.mocked(request).mockImplementation((() => {
      const outgoing = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => outgoing.emit('error', failure)) });
      return outgoing;
    }) as unknown as typeof request);
    await expect(trusting(URL)).rejects.toBe(failure);
  });
});
