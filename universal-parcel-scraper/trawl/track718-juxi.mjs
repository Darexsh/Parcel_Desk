const API = 'https://apigetway.track718.net/track/real_query_multi';
const KEY = 'www.juxiex.com';

export function track718JuxiNumber(raw, capture = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const number = url.searchParams.get('nums');
  return url.origin === 'https://www.track718.com' && !url.username && !url.password
    && url.pathname === '/en/detail' && !url.hash && [...url.searchParams].length === 2
    && url.searchParams.get('cb') === '678' && /^JXC[A-Z]{2}\d{10}YQ$/.test(number ?? '')
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === API ? number : null;
}

/** Project only the requested carrier's scan fields, never account or recipient data. */
export function projectTrack718(payload, number) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length !== 1 || !payload.status
    || !Number.isInteger(payload.status.code)) return null;
  const row = payload.data[0];
  if (!row || row.track !== number || row.fromKey !== KEY || (row.logisId != null && row.logisId !== 678)) return null;
  const projected = {};
  let count = 0;
  for (const field of ['from', 'to', 'frist', 'wms']) {
    if (!Array.isArray(row[field])) return null;
    count += row[field].length;
    if (count > 500) return null;
    projected[field] = row[field].map(scan => scan && typeof scan === 'object'
      ? { ondate: scan.ondate, status: scan.status, address: scan.address } : null);
  }
  return { status: { code: payload.status.code }, data: [{ ...projected, track: number, fromKey: KEY,
    result: row.result, origin: row.origin, isMerge: row.isMerge, mergeType: row.mergeType }],
  pending: Array.isArray(payload.packTracks) && payload.packTracks.includes(number) };
}

export async function runTrack718Juxi({ url, capture, handle, tier, maxTimeout, installPolicy, signal }) {
  const number = track718JuxiNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now(), entries = [], sockets = [];
  let context, page, timer, quiet, abort, requestObserver, responseObserver, socketObserver;
  let expired = false, statusCode = 0, uuid, sentUuid, done;
  const terminal = new Promise(resolve => { done = resolve; });
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - started)));
  const close = async target => {
    let closed = false, cleanup;
    try {
      await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { cleanup = setTimeout(resolve, 1500); })]);
    } finally { clearTimeout(cleanup); if (!closed) handle.requestBrowserReplacement?.('Track718 context cleanup failed'); }
  };
  const append = (payload, status = 200) => {
    if (expired) return;
    const projected = projectTrack718(payload, number);
    const code = payload?.status?.code;
    if (!projected && ![2, 5, 6, 7, 8].includes(code) && status === 200) return;
    if (entries.length === 8) entries.shift();
    entries.push({ url: API, status, headers: {}, body: JSON.stringify(projected ?? { status: { code } }),
      error: null, truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
    if (status >= 400 || [2, 5, 6, 7, 8].includes(code)) done();
    else if (projected && code === 0) {
      clearTimeout(quiet);
      // Keep closely spaced replies for both legs, rather than stopping on the first scan list.
      quiet = setTimeout(done, 1000);
    }
  };
  const result = () => ({ tier, status: statusCode || entries.length ? 'success' : 'error', statusCode,
    durationMs: Date.now() - started, effectiveUrl: url, html: '', body: new Uint8Array(), cookies: [], capturedResponses: entries });
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || signal?.aborted) return result();
    return await Promise.race([
      (async () => {
        const created = await handle.browser.newContext(); handle.noteTemporaryContext?.();
        if (expired) { await close(created); return result(); }
        context = created; page = await context.newPage();
        if (expired) return result();
        await installPolicy?.(page);
        requestObserver = request => {
          if (expired || request.url() !== API || request.method() !== 'POST') return;
          let body;
          try { body = JSON.parse(request.postData() ?? ''); } catch { return; }
          if (body.tracks?.length === 1 && body.tracks[0].track === number && body.tracks[0].key === KEY
            && typeof body.uuid === 'string' && body.uuid.length <= 100) uuid = body.uuid;
        };
        responseObserver = async response => {
          const request = response.request();
          if (expired || !uuid || response.url() !== API || request.method() !== 'POST') return;
          let body;
          try { body = JSON.parse(request.postData() ?? ''); } catch { return; }
          if (body.uuid !== uuid || body.tracks?.length !== 1 || body.tracks[0].track !== number || body.tracks[0].key !== KEY) return;
          if (response.status() >= 400) { append(null, response.status()); return; }
          const headers = response.headers(), size = Number(headers['content-length']);
          if (!Number.isSafeInteger(size) || size < 1 || size > 1_000_000 || (headers['content-encoding'] ?? 'identity') !== 'identity') return;
          try {
            const bytes = await response.body();
            if (!expired && bytes.length <= 1_000_000) append(JSON.parse(bytes.toString('utf8')));
          } catch { /* The WebSocket may still deliver the bound reply. */ }
        };
        socketObserver = socket => {
          if (socket.url() !== 'wss://socket.track718.net/' || expired) return;
          const sent = frame => { if (typeof frame.payload === 'string' && frame.payload.length <= 100) sentUuid = frame.payload; };
          const received = frame => {
            if (expired || !uuid || sentUuid !== uuid || typeof frame.payload !== 'string' || frame.payload.length > 1_000_000) return;
            try { append(JSON.parse(frame.payload)); } catch { /* No usable tracking reply. */ }
          };
          socket.on('framesent', sent); socket.on('framereceived', received); sockets.push({ socket, sent, received });
        };
        page.on('request', requestObserver); page.on('response', responseObserver); page.on('websocket', socketObserver);
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        await terminal; return result();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Track718 deadline')); }, maxTimeout);
        abort = () => { expired = true; reject(new Error('Track718 cancelled')); };
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      }),
    ]);
  } catch { return result(); }
  finally {
    expired = true; clearTimeout(timer); clearTimeout(quiet); signal?.removeEventListener('abort', abort);
    if (page && requestObserver) page.off('request', requestObserver);
    if (page && responseObserver) page.off('response', responseObserver);
    if (page && socketObserver) page.off('websocket', socketObserver);
    for (const { socket, sent, received } of sockets) { socket.off('framesent', sent); socket.off('framereceived', received); }
    if (context) await close(context);
  }
}
