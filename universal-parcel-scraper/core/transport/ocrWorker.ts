import { Worker } from 'node:worker_threads';
import { ChallengeError, TransportError } from '../errors/index.js';

function withAbort<T>(operation: Promise<T>, signal: AbortSignal, abort?: () => void): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => { abort?.(); reject(signal.reason); };
    signal.addEventListener('abort', cancelled, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}

/**
 * The host's Node flags for the worker, without `--input-type`: a worker refuses
 * it, so a host that reads its own code as a module from stdin could start none.
 */
export function workerExecArgv(argv: readonly string[]): string[] {
  return argv.filter((flag, index) => !flag.startsWith('--input-type') && argv[index - 1] !== '--input-type');
}

/** One lazy CPU worker reuses its model; queued work shares the lookup deadline. */
export class OcrWorker {
  private worker: Worker | null = null;
  private tail: Promise<void> = Promise.resolve();
  private nextId = 0;
  private queued = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly provider: string, private readonly workerUrl: URL,
    private readonly workerData?: Readonly<Record<string, unknown>>) {}

  async solve(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.queued >= 8) throw new TransportError(this.provider, `${this.provider} OCR worker is busy`);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.queued += 1;
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await withAbort(previous, signal);
      signal.throwIfAborted();
      const worker = this.worker ??= new Worker(this.workerUrl, { workerData: this.workerData, execArgv: workerExecArgv(process.execArgv) });
      worker.ref();
      const id = ++this.nextId;
      const operation = new Promise<string>((resolve, reject) => {
        const cleanup = () => { worker.off('message', message); worker.off('error', error); worker.off('exit', exited); };
        const message = (reply: { id?: number; answer?: unknown; error?: string }) => {
          if (reply.id !== id) return;
          cleanup();
          if (reply.error === 'unsupported-image') reject(new ChallengeError(this.provider, `${this.provider} returned an unsupported text CAPTCHA`));
          else if (reply.error || typeof reply.answer !== 'string') reject(new TransportError(this.provider, `${this.provider} OCR could not run`));
          else resolve(reply.answer);
        };
        const error = () => { cleanup(); if (this.worker === worker) this.worker = null; reject(new TransportError(this.provider, `${this.provider} OCR worker failed`)); };
        const exited = () => { cleanup(); if (this.worker === worker) this.worker = null; reject(new TransportError(this.provider, `${this.provider} OCR worker stopped`)); };
        worker.on('message', message); worker.once('error', error); worker.once('exit', exited);
        worker.postMessage({ id, bytes });
      });
      try {
        return await withAbort(operation, signal, () => { this.worker = null; void worker.terminate(); });
      } finally { worker.unref(); }
    } finally {
      this.queued -= 1;
      if (this.queued === 0 && this.worker) {
        this.idleTimer = setTimeout(() => { void this.close(); }, 30_000);
        this.idleTimer.unref();
      }
      // If cancelled while queued, preserve the preceding operation's lock.
      void previous.finally(release);
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
