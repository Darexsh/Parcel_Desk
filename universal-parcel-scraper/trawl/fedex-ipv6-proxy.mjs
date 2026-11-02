import { createServer } from 'node:http';
import { BlockList, connect as connectSocket, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const private4 = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) private4.addSubnet(ip, prefix, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const special6 = new BlockList();
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) special6.addSubnet(ip, prefix, 'ipv6');

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !private4.check(address, 'ipv4')
    : family === 6 && global6.check(address, 'ipv6') && !special6.check(address, 'ipv6');
}

export function fedexDestination(authority) {
  const match = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):443$/i.exec(authority ?? '');
  if (!match || match[1].includes('..') || isIP(match[1])) throw new Error('Invalid proxy destination');
  const host = match[1].toLowerCase();
  return { host, target: host === 'www.fedex.com' ? 'page' : host === 'api.fedex.com' ? 'api' : 'resource',
    family: ['www.fedex.com', 'api.fedex.com'].includes(host) ? 6 : 0 };
}

/** Resolve once and connect to that checked address. FedEx has no IPv4 fallback. */
export async function resolveDestination(authority, resolve = lookup) {
  const destination = fedexDestination(authority);
  const addresses = await resolve(destination.host, { family: destination.family, all: true });
  if (!addresses.length || addresses.some(row => !publicAddress(row.address)
    || row.family !== isIP(row.address) || destination.family && row.family !== destination.family)) {
    throw new Error('No allowed destination address');
  }
  return { ...destination, ...addresses[0] };
}

/** A loopback-only TLS tunnel, owned by one browser context. */
export async function createFedExIpv6Proxy({ resolve = lookup, connect = connectSocket } = {}) {
  let closed = false;
  const sockets = new Set();
  const counts = { page: 0, api: 0, resource: 0, failures: 0 };
  const server = createServer((_request, response) => { response.writeHead(405); response.end(); });
  server.maxConnections = 64;
  server.headersTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', async (request, client, head) => {
    let upstream, timer;
    const fail = () => { counts.failures++; client.destroy(); upstream?.destroy(); };
    client.once('error', fail);
    try {
      timer = setTimeout(fail, 5000);
      const destination = await resolveDestination(request.url, resolve);
      if (closed || client.destroyed) { clearTimeout(timer); return; }
      upstream = connect({ host: destination.address, port: 443, family: isIP(destination.address) });
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      upstream.once('error', fail);
      client.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        clearTimeout(timer);
        // The socket, not DNS or the configured URL, establishes the family.
        if (destination.target !== 'resource' && upstream.remoteFamily !== 'IPv6') { fail(); return; }
        counts[destination.target]++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.once('close', () => clearTimeout(timer));
    } catch { fail(); clearTimeout(timer); }
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    proof: () => ({ family: counts.page > 0 && counts.api > 0 ? 'IPv6' : 'unknown',
      pageConnections: counts.page, apiConnections: counts.api, connectionFailures: counts.failures }),
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolveDone => server.close(resolveDone));
    },
  };
}
