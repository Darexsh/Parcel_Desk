import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeSeurNumber, normalizeSeurRecognitionNumber, parseSeur } from './parser.js';

export class SeurTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeSeurNumber(raw);
    return runSteps({ carrier: 'seur', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const deadline = performance.now() + remainingMs;
      const body = { telefono: null, email: null, identificador_busqueda: number, idioma: 'es', cod_postal: '',
        tipo_actor: 'DST', cipher: false, origen_mkt: false };
      const { response, bytes } = await fetchBounded('https://www.seur.com/miseur/backend/consultarEnvioLTSimple',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) }, body: JSON.stringify(body), signal },
        { provider: 'SEUR', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
          redirect: 'manual', allowHttpStatuses: [302, 404, 410], fetcher: this.options.fetcher });
      if (performance.now() >= deadline) throw new BudgetExceededError('SEUR', context.budgetMs ?? 15_000);
      signal.throwIfAborted();
      if (response.status !== 200) throw new IndeterminateError('SEUR', 'SEUR tracking endpoint is unavailable');
      // The firewall answers a request it holds with a script page under HTTP 200.
      const head = decodeText(bytes.subarray(0, 4_000));
      if (/^\s*</.test(head) && /_Incapsula_Resource/i.test(head)) throw new ChallengeError('SEUR', 'SEUR answered with a browser challenge');
      return parseSeur(parseJsonBytes(bytes, 'SEUR'), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SeurTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'seur', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeSeurRecognitionNumber(number))) };
};
