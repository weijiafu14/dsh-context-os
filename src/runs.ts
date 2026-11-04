import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { createComposedRun } from './composedRun.ts';
import type { SendReceipt } from './composedRun.ts';
import { ConnectorRegistry } from './registry.ts';
import { parseSelection } from './core.ts';
import type { ConnectorBinding, ConnectorCard, RunSelection } from './core.ts';

export interface SourceEvent {
  type: string;
  data: JsonValue;
  connector?: string;
}

export interface RunRequest {
  /** Stable within the caller's scope. Retries with a different specification are rejected. */
  key: string;
  selection: RunSelection;
  entry?: SourceEvent;
  model?: ModelSelection;
}

export interface RunReference { readonly id: string; }

export interface RunControl {
  catalog(): Promise<readonly ConnectorCard[]>;
  start(request: RunRequest): Promise<RunReference>;
  send(id: string, event: SourceEvent): Promise<SendReceipt>;
  /** Wait for admitted work and persistence to settle. An idle run can accept later events. */
  wait(id: string): SendReceipt['completed'];
  /** Stop this run and its attached descendants, then release their resources. */
  stop(id: string): Promise<void>;
}

export interface RunCaller {
  readonly subject: string;
  readonly parentId?: string;
  readonly connectorId?: string;
}

export interface RunAuthority {
  readonly id: string;
  readonly subject: string;
  readonly cwd: string;
  readonly model: ModelSelection;
  canUse(binding: ConnectorBinding, caller: RunCaller): boolean | Promise<boolean>;
  canStart(request: RunRequest, caller: RunCaller): boolean | Promise<boolean>;
}

type ComposedRun = Awaited<ReturnType<typeof createComposedRun>>;
type Completion = Awaited<SendReceipt['completed']>;
interface ManagedRun {
  id: string;
  authorityId: string;
  creator: RunCaller;
  fingerprint: string;
  abort: AbortController;
  ready: Promise<ComposedRun>;
  accepted: Promise<RunReference>;
  completed: Promise<Completion>;
  stopped: boolean;
  initialized: boolean;
  stopping?: Promise<void>;
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function copiedEvent(event: SourceEvent): SourceEvent {
  if (!event || typeof event.type !== 'string' || !event.type || /^(run|agent|session|tools)\//.test(event.type)) {
    throw new Error('Expected a source-owned event name');
  }
  if (event.connector !== undefined && (typeof event.connector !== 'string' || !event.connector)) {
    throw new Error('Invalid event target');
  }
  const data = snapshotJsonValue(event.data);
  if (data === undefined) throw new Error('Source event data must be JSON-compatible');
  return { type: event.type, data, ...(event.connector ? { connector: event.connector } : {}) };
}

/** Generic host service. Resource and application behavior remain in registered providers. */
export class RunManager {
  private readonly runs = new Map<string, ManagedRun>();
  private closed = false;
  private readonly ctx: Context;
  private readonly registry: ConnectorRegistry;

  constructor(ctx: Context, registry: ConnectorRegistry) {
    this.ctx = ctx;
    this.registry = registry;
  }

  /** Only the host creates authorities. A provider receives the returned, restricted object. */
  scope(authority: RunAuthority): RunControl {
    return this.control(authority, Object.freeze({ subject: authority.subject }));
  }

  private control(authority: RunAuthority, caller: RunCaller): RunControl {
    const control: RunControl = {
      catalog: async () => {
        this.assertOpen(caller);
        const cards = await this.registry.catalog({ cwd: authority.cwd, subject: authority.subject });
        const visible: ConnectorCard[] = [];
        for (const card of cards) if (await authority.canUse({ id: card.id }, caller)) visible.push(card);
        return visible;
      },
      start: request => this.start(authority, caller, request),
      send: async (id, event) => {
        this.assertOpen(caller);
        const input = copiedEvent(event);
        // A resource may deliver its own asynchronous observations back to its
        // current loop, without gaining control over another connector there.
        const self = caller.parentId === id && caller.connectorId !== undefined;
        if (self && input.connector !== undefined && input.connector !== caller.connectorId) throw new Error('A connector can only publish to its own binding');
        const record = self ? this.runs.get(id)! : this.owned(authority, caller, id);
        if (record.stopped) throw new Error('Run is stopped');
        if (self && !record.initialized) throw new Error('Use initialization contributions before the run is ready');
        if (self) input.connector = caller.connectorId;
        const run = await record.ready;
        const receipt = await run.send(input.type, input.data, input.connector);
        record.completed = receipt.completed;
        return receipt;
      },
      wait: id => this.owned(authority, caller, id).completed,
      stop: id => this.stop(this.owned(authority, caller, id)),
    };
    return Object.freeze(control);
  }

  private assertOpen(caller: RunCaller): void {
    if (this.closed) throw new Error('Run manager is closed');
    if (caller.parentId && this.runs.get(caller.parentId)?.stopped) throw new Error('Calling run is stopped');
  }

  private owned(authority: RunAuthority, caller: RunCaller, id: string): ManagedRun {
    const record = this.runs.get(id);
    const sameCreator = record?.creator.parentId === caller.parentId && record?.creator.connectorId === caller.connectorId;
    if (!record || record.authorityId !== authority.id || record.creator.subject !== caller.subject
      || (caller.parentId !== undefined && !sameCreator)) throw new Error('Run is outside this control scope');
    return record;
  }

  private async start(authority: RunAuthority, caller: RunCaller, input: RunRequest): Promise<RunReference> {
    this.assertOpen(caller);
    if (!input || typeof input.key !== 'string' || !input.key || input.key.length > 512) throw new Error('A stable start key is required');
    const request: RunRequest = {
      key: input.key,
      selection: parseSelection(input.selection),
      ...(input.entry === undefined ? {} : { entry: copiedEvent(input.entry) }),
      model: structuredClone(input.model ?? authority.model),
    };
    if (!(await authority.canStart(request, caller))) throw new Error('Starting this composition is not authorized');
    for (const binding of request.selection.bindings) {
      if (!(await authority.canUse(binding, caller))) throw new Error(`Connector binding is not authorized: ${binding.id}`);
    }
    this.assertOpen(caller);
    const identity = canonical([authority.id, caller.subject, caller.parentId ?? null, caller.connectorId ?? null, request.key]);
    const id = `cos-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    const fingerprint = createHash('sha256').update(canonical(snapshotJsonValue(request as unknown as JsonValue)!)).digest('hex');
    const previous = this.runs.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Start key already belongs to a different composition');
      return previous.accepted;
    }

    const abort = new AbortController();
    const pending = Promise.withResolvers<ComposedRun>();
    const accepted = Promise.withResolvers<RunReference>();
    const completion = Promise.withResolvers<Completion>();
    const record: ManagedRun = { id, authorityId: authority.id, creator: caller, fingerprint, abort,
      ready: pending.promise, accepted: accepted.promise, completed: completion.promise, stopped: false, initialized: false };
    this.runs.set(id, record);
    void record.ready.catch(() => {});
    void record.accepted.catch(() => {});
    void record.completed.catch(() => {});
    try {
      const discovery = { cwd: authority.cwd, subject: authority.subject, runId: id, signal: abort.signal };
      const prepared = await this.registry.prepare(request.selection, discovery, binding => ({
        ...discovery,
        os: this.control(authority, Object.freeze({ subject: authority.subject, parentId: id, connectorId: binding.id })),
      }));
      const run = await createComposedRun(this.ctx, {
        sessionId: id, cwd: authority.cwd, model: request.model!, connectors: prepared.connectors, signal: abort.signal,
      });
      record.initialized = true;
      pending.resolve(run);
      try {
        if (request.entry) {
          const receipt = await run.send(request.entry.type, request.entry.data, request.entry.connector);
          receipt.completed.then(completion.resolve, completion.reject);
        } else completion.resolve(undefined);
      } catch (error) {
        await this.stop(record);
        throw error;
      }
      const reference = Object.freeze({ id });
      accepted.resolve(reference);
      return reference;
    } catch (error) {
      record.stopped = true;
      abort.abort(error);
      pending.reject(error);
      accepted.reject(error);
      completion.reject(error);
      await this.stop(record);
      throw error;
    }
  }

  private stop(record: ManagedRun): Promise<void> {
    if (record.stopping) return record.stopping;
    record.stopped = true;
    record.abort.abort(new Error('Run stopped'));
    record.stopping = (async () => {
      const children = [...this.runs.values()].filter(child => child.creator.parentId === record.id);
      const results = await Promise.allSettled(children.map(child => this.stop(child)));
      const run = await record.ready.catch(() => undefined);
      await run?.dispose();
      // Keep the idempotency receipt, not the disposed agent and its entire
      // history. Long-lived hosts accumulate many completed compositions.
      record.ready = Promise.reject(new Error('Run is stopped'));
      void record.ready.catch(() => {});
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Child run cleanup failed');
    })();
    return record.stopping;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.runs.values()].map(record => this.stop(record)));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Run cleanup failed');
  }
}
