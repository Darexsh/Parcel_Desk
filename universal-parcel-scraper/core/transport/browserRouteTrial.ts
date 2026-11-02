import type { CarrierResult } from '../result/index.js';
import { NOOP_RECORDER, type StepRecord, type StepRecorder } from '../telemetry/index.js';

export function retryShare(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('Browser retry share must be between zero and one');
  return value;
}

/** One lookup's opt-in route assignment. The adapter owns eligibility, attempts and deadlines. */
export class BrowserRouteTrial<T> {
  readonly recorder: StepRecorder;
  private selected: boolean | undefined;
  private pending = false;
  private route: StepRecord['networkRoute'] = 'default';
  private attempt: StepRecord['networkAttempt'] = 'initial';
  private family: StepRecord['networkFamily'] = 'unknown';
  private history = false;
  private partial = false;

  constructor(private readonly options: { primary: T; alternative: T | null; route: 'ipv6' | 'residential'; share: number;
    steps: readonly string[]; recorder?: StepRecorder }) {
    retryShare(options.share);
    const sink = options.recorder ?? NOOP_RECORDER;
    this.recorder = {
      step: record => {
        const observed = this.pending && options.steps.includes(record.step);
        this.pending = false;
        sink.step(observed ? { ...record, networkRoute: this.route, networkAttempt: this.attempt,
          networkFamily: this.family, historyAvailable: this.history, historyPartial: this.partial } : record);
      },
      lookup: record => sink.lookup(record),
    };
  }

  primary(): T { return this.begin(false, 'initial'); }

  get isAlternate(): boolean { return this.route !== 'default'; }

  /** Choose once, only when an existing eligible retry actually starts. */
  retry(): T {
    this.selected ??= this.options.alternative !== null && Math.random() < this.options.share;
    return this.begin(this.selected, 'retry');
  }

  private begin(alternate: boolean, attempt: 'initial' | 'retry'): T {
    this.pending = true; this.attempt = attempt; this.family = 'unknown'; this.history = false; this.partial = false;
    this.route = alternate ? this.options.route : 'default';
    return alternate ? this.options.alternative! : this.options.primary;
  }

  observeFamily(family: 'IPv4' | 'IPv6' | 'unknown'): void { this.family = family; }

  result(result: CarrierResult): CarrierResult {
    this.history = Boolean(result.events?.some(event => event.time || event.local_time));
    this.partial = result.history_truncated === true || result.summary_only === true;
    return result;
  }
}

export interface BrowserContextProxy { server: string; username?: string; password?: string }

/** Credentials are passed to a fresh browser context, never to a URL, diagnostic or metric. */
export function browserContextProxy(value: string): BrowserContextProxy {
  let url: URL | undefined;
  try { url = new URL(value.trim()); } catch { /* Use a fixed error without the configured value. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname || !['', '/'].includes(url.pathname)
    || url.search || url.hash) throw new TypeError('Browser retry proxy must be an HTTP(S) origin');
  try {
    return { server: url.origin, ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}) };
  } catch { throw new TypeError('Browser retry proxy has invalid credentials'); }
}
