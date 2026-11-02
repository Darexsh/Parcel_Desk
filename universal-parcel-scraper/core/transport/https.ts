import { Agent, request } from 'node:https';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const EMPTY = new Set([204, 205, 304]);

/**
 * A fetch over Node's HTTPS client that trusts Node's root certificates and the
 * given intermediates, for a server that sends its certificate without the
 * intermediate. Browsers fetch a missing intermediate themselves; Node refuses
 * the connection. The intermediates apply to this fetch only, never to the
 * process. It sends text bodies only, asks for no compression and follows no
 * redirect: a redirect is answered only to `redirect: 'manual'`.
 */
export function fetchTrusting(intermediates: readonly string[]): typeof fetch {
  const agent = new Agent({ ca: [...rootCertificates, ...intermediates] });
  return (input, init = {}) => new Promise<Response>((resolve, reject) => {
    const url = input instanceof Request ? input.url : String(input);
    const sent = init.body ?? undefined;
    if (sent !== undefined && typeof sent !== 'string' && !(sent instanceof URLSearchParams)) {
      reject(new TypeError('Only text bodies are sent'));
      return;
    }
    const body = sent?.toString();
    const headers = Object.fromEntries(new Headers(init.headers));
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const outgoing = request(url, { agent, method: init.method ?? 'GET', headers, signal: init.signal ?? undefined }, (incoming) => {
      const status = incoming.statusCode ?? 0;
      if (REDIRECTS.has(status) && init.redirect !== 'manual') {
        incoming.destroy();
        reject(new TypeError(`Redirect ${status} not followed`));
        return;
      }
      const replied = new Headers();
      for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) replied.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      try {
        const stream = EMPTY.has(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (stream === null) incoming.resume();
        resolve(new Response(stream, { status, statusText: incoming.statusMessage, headers: replied }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
