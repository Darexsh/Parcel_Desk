/**
 * The published HTTP contract against the running server: every documented
 * status of every operation is produced and its body validated, and a reply
 * whose status, body or `Retry-After` the document does not give for that
 * operation fails the call. Paths the document does not list are outside it.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Ajv } from 'ajv';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment, type CarrierAdapter } from '../core/adapter/index.js';
import { InputRequiredError, InvalidInputError, NotFoundError, RateLimitedError, TransportError } from '../core/errors/index.js';
import type { CarrierResult } from '../core/result/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { createTracker, type Tracker } from '../facade/index.js';
import { createTrackingServer, type TrackingServerOptions } from './index.js';

interface Operation { operationId: string; responses: Record<string, { headers?: Record<string, unknown> }>; requestBody?: unknown }
const contract = JSON.parse(readFileSync(new URL('./openapi.json', import.meta.url), 'utf8')) as {
  info: { version: string }; paths: Record<string, Record<string, Operation>>;
};
const ajv = new Ajv({ strict: false, allowUnionTypes: true }).addSchema(contract, 'contract');
const operations = Object.entries(contract.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method: method.toUpperCase(), ...operation })));
const pointer = (path: string, method: string, tail: string) =>
  `contract#/paths/${path.replaceAll('/', '~1')}/${method.toLowerCase()}/${tail}`;

const number = '1Z999AA10123456784';
const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} };
const delivered: CarrierResult = { status: 'delivered', service_name: 'Example Ground',
  events: [{ time: '2026-01-02T12:00:00Z', description: 'Delivered', stage: 'delivered' }] };

/** The real tracker over one synthetic UPS adapter, so success bodies are the facade's own. */
function tracker(track: CarrierAdapter['track'] = async () => delivered): Tracker {
  const registry = new AdapterRegistry({ factories: { ups: () => ({ id: 'ups', steps: ['direct'], track,
    recognize: async () => ({ known: true }) }) }, carriers: { ups: 'ups' } }, environment);
  return createTracker({ registry, providers: [] });
}

const servers: Server[] = [];
async function serve(options: TrackingServerOptions = {}): Promise<string> {
  const server = createTrackingServer({ tracker: tracker(), ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const exercised = new Set<string>();

/** Send one request for an operation and hold the reply to the document. */
async function call(base: string, operationId: string, init: { method?: string; body?: unknown; raw?: string; type?: string; token?: string } = {}) {
  const operation = operations.find((candidate) => candidate.operationId === operationId)!;
  const method = init.method ?? operation.method;
  const response = await fetch(base + operation.path, {
    method,
    headers: { ...(method === 'POST' ? { 'Content-Type': init.type ?? 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: method === 'POST' ? init.raw ?? JSON.stringify(init.body ?? {}) : undefined,
  });
  const status = String(response.status);
  expect(Object.keys(operation.responses), `${operationId} ${status}`).toContain(status);
  const body: unknown = await response.json();
  const validate = ajv.getSchema(pointer(operation.path, operation.method, `responses/${status}/content/application~1json/schema`))!;
  expect(validate(body), `${operationId} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  const wait = response.headers.get('retry-after');
  if (wait !== null) {
    expect(Object.keys(operation.responses[status]!.headers ?? {}), `${operationId} ${status} headers`).toContain('Retry-After');
    expect(wait).toMatch(/^\d+$/);
  }
  exercised.add(`${operationId} ${status}`);
  return { status: response.status, body: body as Record<string, unknown>, headers: response.headers };
}

const posts = { detect: { text: number }, recognize: { number }, track: { number, carrier: 'ups' } } as const;

describe('HTTP contract', () => {
  it('names the package version and is the document the server serves', async () => {
    const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    expect(contract.info.version).toBe(version);
    expect((await call(await serve(), 'openapi')).body).toEqual(contract);
  });

  it('answers each operation as documented', async () => {
    const base = await serve();
    expect((await call(base, 'health')).body).toEqual({ ok: true });
    expect(Object.keys((await call(base, 'carriers')).body)).toContain('ups');
    expect((await call(base, 'detect', { body: posts.detect })).body).toMatchObject({ carrier: 'ups', confidence: 'high' });
    expect((await call(base, 'recognize', { body: posts.recognize })).body).toMatchObject({ asked: expect.any(Array) });
    expect((await call(base, 'track', { body: posts.track })).body).toMatchObject({
      carrier: 'ups', source: 'ups', attempts: [{ source: 'ups', kind: 'ok' }], result: { current_stage: 'delivered', service_name: 'Example Ground' },
    });
  });

  it('accepts exactly the request fields it documents', async () => {
    const base = await serve({ rateLimit: 1_000 });
    const samples: Record<string, unknown> = { text: number, number, carrier: 'ups', postcode: null, trackingUrl: null, budgetMs: 5_000 };
    for (const operation of operations.filter((candidate) => candidate.requestBody)) {
      const schema = ajv.getSchema(pointer(operation.path, operation.method, 'requestBody/content/application~1json/schema'))!
        .schema as { properties?: Record<string, unknown>; $ref?: string };
      const properties = schema.properties ?? (ajv.getSchema(`contract${schema.$ref}`)!.schema as { properties: Record<string, unknown> }).properties;
      const documented = Object.fromEntries(Object.keys(properties).map((name) => [name, samples[name]]));
      expect((await call(base, operation.operationId, { body: documented })).status).toBe(200);
      expect(await call(base, operation.operationId, { body: { ...documented, undocumented: true } }))
        .toMatchObject({ status: 400, body: { error: 'Unknown request field' } });
    }
  });

  it('refuses unauthenticated, limited, malformed and oversized requests as documented', async () => {
    const guarded = await serve({ token: 'synthetic-token' });
    const limited = await serve({ rateLimit: 1 });
    const open = await serve({ rateLimit: 1_000 });
    await call(limited, 'health');
    await call(limited, 'carriers');
    for (const operationId of ['carriers', 'openapi', 'detect', 'recognize', 'track'] as const) {
      const body = operationId === 'carriers' || operationId === 'openapi' ? undefined : posts[operationId];
      expect((await call(guarded, operationId, { body })).status).toBe(401);
      const refused = await call(limited, operationId, { body });
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('60');
      if (!body) continue;
      expect((await call(open, operationId, { method: 'GET' })).status).toBe(405);
      expect((await call(open, operationId, { raw: '{', type: 'application/json' })).status).toBe(400);
      expect((await call(open, operationId, { raw: 'number', type: 'text/plain' })).status).toBe(415);
      expect((await call(open, operationId, { body: { number: 'x'.repeat(17_000) } })).status).toBe(413);
    }
  });

  it('reports failed lookups with the documented status, attempts and hint', async () => {
    const failing = (error: Error) => serve({ tracker: tracker(async () => { throw error; }), now: () => 0 });
    // A held failure says when the server asks again, in the header and in the hint.
    const unknown = await call(await failing(new NotFoundError('UPS')), 'track', { body: posts.track });
    expect(unknown).toMatchObject({ status: 404,
      body: { hint: { kind: 'not_found', retryAfterMs: 60_000 }, attempts: [{ source: 'ups', kind: 'not_found' }] } });
    expect(unknown.headers.get('retry-after')).toBe('60');
    const refused = await call(await failing(new InvalidInputError('UPS')), 'track', { body: posts.track });
    expect(refused).toMatchObject({ status: 400, body: { hint: { kind: 'invalid_input' } } });
    expect(refused.headers.get('retry-after')).toBeNull();
    const throttled = await call(await failing(new RateLimitedError('UPS', 2_000)), 'track', { body: posts.track });
    expect(throttled).toMatchObject({ status: 429, body: { hint: { kind: 'rate_limited', retryAfterMs: 60_000 } } });
    expect(throttled.headers.get('retry-after')).toBe('60');
    const unreachable = await call(await failing(new TransportError('UPS')), 'track', { body: posts.track });
    expect(unreachable).toMatchObject({ status: 502, body: { hint: { kind: 'transport', retryAfterMs: 60_000 } } });
    expect(unreachable.headers.get('retry-after')).toBe('60');
    // A malformed reply is not a network failure: retrying at once cannot help.
    expect(await call(await failing(new TypeError('Cannot read properties of undefined')), 'track', { body: posts.track }))
      .toMatchObject({ status: 502, body: { hint: { kind: 'schema' } } });
    const broken: Tracker = { ...tracker(), recognize: async () => { throw new Error('synthetic failure'); } };
    expect((await call(await serve({ tracker: broken }), 'recognize', { body: posts.recognize })).status).toBe(502);
    expect(await call(await serve(), 'recognize', { body: { number: '!' } })).toMatchObject({ status: 400 });
    expect(await call(await serve(), 'detect', { body: { text: 7 } })).toMatchObject({ status: 400 });
    expect(await call(await serve(), 'track', { body: { ...posts.track, budgetMs: 0 } }))
      .toMatchObject({ status: 400, body: { error: 'Invalid lookup budget' } });
  });

  it('answers a lookup that needs a carrier chosen, or finds every slot taken, as documented', async () => {
    // The one reply that carries `field`: unrelated carriers both know the number.
    const undecided: Tracker = { ...tracker(), track: async () => { throw new InputRequiredError('Tracking', 'carrier', 'Choose a carrier for this number'); } };
    expect(await call(await serve({ tracker: undecided }), 'track', { body: posts.track }))
      .toMatchObject({ status: 400, body: { field: 'carrier' } });
    let entered!: () => void, release!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<CarrierResult>((resolve) => { release = () => resolve(delivered); });
    const busy = await serve({ tracker: tracker(() => { entered(); return held; }), maxConcurrent: 1 });
    const first = call(busy, 'track', { body: posts.track });
    await running;
    // Another parcel, so the request cannot join the lookup in progress.
    const turnedAway = await call(busy, 'track', { body: { ...posts.track, postcode: '0000' } });
    expect(turnedAway).toMatchObject({ status: 429, body: { error: 'Tracking is busy; retry later' } });
    expect(turnedAway.headers.get('retry-after')).toBe('60');
    release();
    expect((await first).status).toBe(200);
  });

  afterAll(() => {
    const documented = operations.flatMap((operation) => Object.keys(operation.responses).map((status) => `${operation.operationId} ${status}`));
    expect([...exercised].sort()).toEqual(documented.sort());
  });
});
