import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { fedexDestination, publicAddress, resolveDestination, createFedExIpv6Proxy } from './fedex-ipv6-proxy.mjs';

test('only the page and API require IPv6; public dependencies keep normal resolution', () => {
  assert.equal(fedexDestination('www.fedex.com:443').family, 6);
  assert.equal(fedexDestination('api.fedex.com:443').family, 6);
  assert.equal(fedexDestination('cdn.example.com:443').family, 0);
  for (const input of ['api.fedex.com:80', 'user@api.fedex.com:443', '127.0.0.1:443', '[::1]:443', 'api.fedex.com:443/']) {
    assert.throws(() => fedexDestination(input));
  }
});

test('private, mapped and special addresses cannot be proxy destinations', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '100.64.0.1', '224.0.0.1',
    '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('a missing AAAA or an IPv4 answer never downgrades a FedEx connection', async () => {
  const calls = [];
  await assert.rejects(resolveDestination('api.fedex.com:443', async (_host, options) => { calls.push(options.family); return []; }));
  assert.deepEqual(calls, [6]);
  await assert.rejects(resolveDestination('api.fedex.com:443', async () => [{ address: '8.8.8.8', family: 4 }]));
  await assert.rejects(resolveDestination('cdn.example.com:443', async () => [{ address: '127.0.0.1', family: 4 }]));
  assert.equal((await resolveDestination('cdn.example.com:443', async () => [{ address: '8.8.8.8', family: 4 }])).family, 4);
});

test('the proxy reports no IPv6 proof without real page and API sockets and closes clients', async () => {
  let connected = 0;
  const proxy = await createFedExIpv6Proxy({ resolve: async () => [], connect: () => { connected++; throw new Error('unexpected'); } });
  const url = new URL(proxy.url);
  await new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => socket.write('CONNECT api.fedex.com:443 HTTP/1.1\r\nHost: api.fedex.com:443\r\n\r\n'));
    socket.on('error', reject); socket.on('close', resolve);
  });
  assert.equal(connected, 0); assert.equal(proxy.proof().family, 'unknown');
  assert.equal(proxy.proof().apiConnections, 0);
  await proxy.close();
});

test('an IPv4 socket is refused even if DNS resolution promised IPv6', async () => {
  const proxy = await createFedExIpv6Proxy({
    resolve: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
    connect: () => {
      const socket = new PassThrough(); socket.remoteFamily = 'IPv4';
      queueMicrotask(() => socket.emit('connect')); return socket;
    },
  });
  const url = new URL(proxy.url);
  await new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => socket.write('CONNECT api.fedex.com:443 HTTP/1.1\r\nHost: api.fedex.com:443\r\n\r\n'));
    socket.on('error', reject); socket.on('close', resolve);
  });
  assert.equal(proxy.proof().apiConnections, 0);
  assert.equal(proxy.proof().family, 'unknown');
  await proxy.close();
});
