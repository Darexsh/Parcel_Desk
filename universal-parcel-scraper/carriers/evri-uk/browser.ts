/** Runs in the official page. No issued key or browser token leaves this context. */
export async function requestEvriUkInPage({ number, budgetMs }: { number: string; budgetMs: number }) {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const sdk = (globalThis as typeof globalThis & { AwsWafIntegration?: {
    getToken(): Promise<string>;
    fetch(url: string, options: RequestInit): Promise<Response>;
  } }).AwsWafIntegration;
  if (location.origin !== 'https://www.evri.com' || !/^\/track-a-parcel\/?$/.test(location.pathname)
    || !/^[A-Z0-9]{16}$/.test(number) || !sdk || !(budgetMs > 0)) return { kind: 'context' as const };
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(budgetMs, 20_000))));
  let total = 0;
  let phase = 'keys';
  const failure = (kind: 'http' | 'schema' | 'transport', status?: number, retryAfter?: string | null) =>
    Object.assign(new Error('Evri UK request failed'), { kind, phase, status, retryAfter });
  const json = async (response: Response, maxBytes: number): Promise<unknown> => {
    if (response.status !== 200) throw failure('http', response.status, response.headers.get('retry-after'));
    if (!(response.headers.get('content-type') ?? '').includes('application/json')
      || Number(response.headers.get('content-length') ?? 0) > maxBytes || !response.body) throw failure('schema');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength; total += value.byteLength;
        if (size > maxBytes || total > 3_000_000) { await reader.cancel(); throw failure('schema'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    try { return JSON.parse(text) as unknown; } catch { throw failure('schema'); }
  };
  try {
    await Promise.race([sdk.getToken(), new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(failure('transport')), { once: true });
    })]);
    const keyData = await json(await sdk.fetch('/protected/keys.json', { method: 'GET', signal,
      headers: { 'Content-Type': 'application/json' } }), 100_000);
    if (!record(keyData) || !record(keyData.keys)) return { kind: 'schema' as const, phase };
    const customerKey = keyData.keys['spa-customer-track-key'];
    const trackKey = keyData.keys['spa-track-key'];
    if (typeof customerKey !== 'string' || !customerKey || typeof trackKey !== 'string' || !trackKey) return { kind: 'schema' as const, phase };
    phase = 'search';
    const data = await json(await fetch(`https://api.evri.com/customer-tracking/v1/search/${number}`, {
      signal, redirect: 'error', headers: { apiKey: customerKey, 'Content-Type': 'application/json' },
    }), 200_000);
    if (!record(data) || !Array.isArray(data.parcels) || data.parcels.length > 50) return { kind: 'schema' as const, phase };
    if (data.parcels.length !== 1) return { kind: 'indeterminate' as const, phase };
    const parcel: unknown = data.parcels[0];
    if (!record(parcel) || !Array.isArray(parcel.identifiers) || !record(parcel.brand)) return { kind: 'schema' as const, phase };
    if (parcel.brand.name !== 'EVRI' || parcel.externalRedirectUrl) return { kind: 'scope' as const, phase };
    const parcelIds = parcel.identifiers.filter(id => record(id) && id.type === 'PARCEL_ID');
    const barcodes = parcel.identifiers.filter(id => record(id) && id.type === 'BARCODE');
    if (parcelIds.length !== 1 || barcodes.length !== 1 || !record(parcelIds[0]) || !record(barcodes[0])
      || typeof parcelIds[0].value !== 'string' || !/^\d{1,30}$/.test(parcelIds[0].value) || barcodes[0].value !== number) {
      return { kind: 'identity' as const, phase };
    }
    // The current application constructs this URN from the search identifiers
    // and the lookup's UTC calendar day, rather than accepting a reused handle.
    const urn = `urn:parcel_id:barcode:date:${parcelIds[0].value}:${number}:${new Date().toISOString().slice(0, 10)}`;
    phase = 'history';
    const endpoint = new URL('https://tracking.platform-apis.evri.com/v1/parcels');
    endpoint.searchParams.set('uniqueIds', urn);
    const history = await json(await fetch(endpoint.href, { signal, redirect: 'error',
      headers: { apiKey: trackKey, 'Content-Type': 'application/json' } }), 2_000_000);
    if (!record(history) || !Array.isArray(history.results) || !Array.isArray(history.failures)) return { kind: 'schema' as const, phase };
    if (history.failures.length || history.results.length === 0) return { kind: 'indeterminate' as const, phase };
    if (history.results.length !== 1 || !record(history.results[0])) return { kind: 'schema' as const, phase };
    const result = history.results[0];
    if (!Array.isArray(result.parcelIdentifiers) || result.parcelIdentifiers.length > 50
      || !result.parcelIdentifiers.every(id => record(id) && typeof id.type === 'string' && typeof id.value === 'string')) {
      return { kind: 'identity' as const, phase };
    }
    const returnedBarcodes = result.parcelIdentifiers.filter(id => record(id) && id.type === 'BARCODE');
    if (!returnedBarcodes.length || returnedBarcodes.some(id => !record(id) || id.value !== number)
      || result.uniqueId !== urn) return { kind: 'identity' as const, phase };
    if (!Array.isArray(result.trackingEvents) || result.trackingEvents.length > 500) {
      return { kind: 'schema' as const, phase };
    }
    const scalar = (value: unknown, limit: number): value is string =>
      typeof value === 'string' && value.length <= limit && value.trim().length > 0;
    const events = [];
    for (const event of result.trackingEvents) {
      if (!record(event) || !record(event.trackingPoint) || !record(event.trackingStage)
        || !scalar(event.dateTime, 64) || !scalar(event.trackingPoint.trackingPointCode, 64)
        || !scalar(event.trackingPoint.description, 1000) || !scalar(event.trackingStage.trackingStageCode, 64)
        || !/^[A-Za-z0-9_-]{1,64}$/.test(event.trackingPoint.trackingPointCode)
        || !/^[A-Za-z0-9_-]{1,64}$/.test(event.trackingStage.trackingStageCode)) {
        return { kind: 'schema' as const, phase };
      }
      const stageCode = event.trackingStage.trackingStageCode.trim();
      const description = event.trackingPoint.description;
      const safeDescription = stageCode === '5_COURIER' || stageCode === '5_SHOP' ? 'Delivered'
        : /\b(?:delivered (?:to|by)|signed (?:for )?by)\b/i.test(description) ? 'Delivery update' : description;
      const eta = record(event.eta) && scalar(event.eta.start, 64) && scalar(event.eta.end, 64)
        ? { start: event.eta.start, end: event.eta.end } : undefined;
      events.push({ dateTime: event.dateTime,
        trackingPoint: { trackingPointCode: event.trackingPoint.trackingPointCode, description: safeDescription },
        trackingStage: { trackingStageCode: stageCode }, ...(eta ? { eta } : {}) });
    }
    // A consumer's parcel or a customer return can name a private person or the retailer.
    const business = result.c2cClient === false && result.returnParcel === false;
    const sender = business && record(result.sender) && scalar(result.sender.displayName, 200)
      ? { displayName: result.sender.displayName } : undefined;
    // Copy only validated identity and scan scalars. Ownership, contacts,
    // photos, map links, GPS, instructions and issued credentials stay here.
    return { kind: 'ok' as const, urn, payload: { failures: [], results: [{
      uniqueId: urn, parcelIdentifiers: returnedBarcodes.map(() => ({ type: 'BARCODE', value: number })),
      ...(sender ? { c2cClient: false, returnParcel: false, sender } : {}),
      trackingEvents: events,
    }] } };
  } catch (error) {
    if (record(error) && ['http', 'schema', 'transport'].includes(String(error.kind))) {
      return { kind: error.kind as 'http' | 'schema' | 'transport', phase,
        ...(typeof error.status === 'number' ? { status: error.status } : {}),
        ...(typeof error.retryAfter === 'string' ? { retryAfter: error.retryAfter.slice(0, 100) } : {}) };
    }
    return { kind: 'transport' as const, phase };
  }
}
