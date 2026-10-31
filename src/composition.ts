import { createHash, randomUUID } from 'node:crypto';
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ContentBlock, UserMessage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';

export type CurrentContribution =
  | { kind: 'instruction'; role: 'system' | 'developer' | 'user'; text: string }
  | { kind: 'capability'; name?: string; description: string; parameters: ToolSchema['parameters']; output: JsonSchemaNode }
  | { kind: 'projection'; service: string };

export type Contribution =
  | { op: 'put'; key: string; value: CurrentContribution }
  | { op: 'remove'; key: string }
  | { op: 'append'; key: string; value: { messages: readonly UserMessage[] } | { records: readonly SessionEvent[] } }
  | { op: 'answer'; requestId: string; value: JsonValue; content?: readonly ContentBlock[] };

export interface RuntimeEventData {
  'run/initialize': { restoring: boolean };
  'agent/prepare-step': { turn: number; step: number; messages: readonly UserMessage[] };
  'tools/execute': { arguments: JsonValue; callId: string; rootCallId: string; nested: boolean };
  'session/event': { record: SessionEvent };
  'run/settled': { events: readonly SessionEvent[]; closing?: boolean; outcome: TurnEndReason | { kind: 'disposed' | 'error' | 'aborted'; phase?: string; message?: string } };
}

interface EventEnvelope {
  readonly runId: string;
  readonly id: string;
  readonly signal: AbortSignal;
}
export interface ConnectorRequest { readonly id: string; readonly key: string; readonly callId: string; }
/** Add source event payloads as the generic argument; runtime payloads stay discriminated. */
type RuntimeConnectorEvent = {
  [Name in keyof RuntimeEventData]: EventEnvelope & {
    readonly type: Name;
    readonly data: RuntimeEventData[Name];
  } & (Name extends 'tools/execute' ? { readonly request: ConnectorRequest } : { readonly request?: never });
}[keyof RuntimeEventData];
export type ConnectorEvent<Sources extends object = {}> = RuntimeConnectorEvent | {
  [Name in Exclude<keyof Sources, keyof RuntimeEventData>]: EventEnvelope & {
    readonly type: Name; readonly data: Sources[Name]; readonly request?: never;
  };
}[Exclude<keyof Sources, keyof RuntimeEventData>];

interface ConnectorHandler<Event> {
  readonly id: string;
  /** Explicit source subscriptions. Omission is retained for early prototype callers. */
  readonly events?: readonly string[];
  handle(event: Event): Promise<readonly Contribution[] | void>;
}
export type ContextConnector<Sources extends object = {}> = ConnectorHandler<ConnectorEvent<Sources>>;

export interface OwnedCurrent {
  readonly owner: string;
  readonly key: string;
  readonly value: CurrentContribution;
}

export interface Answer { value: JsonValue; content?: readonly ContentBlock[]; }

export function capabilityName(owner: string, key: string): string {
  return `cc_${createHash('sha256').update(JSON.stringify([owner, key])).digest('hex').slice(0, 24)}`;
}

/** One selected composition. Plugin construction and service dependencies remain with Cordis. */
export class Composition {
  private current = new Map<string, OwnedCurrent>();
  private revision = 0;
  // Tombstones also retain their revision, preventing stale resurrection after remove.
  private currentRevisions = new Map<string, number>();
  private appended = new Set<string>();
  private messages: UserMessage[] = [];
  private records: SessionEvent[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly requests = new Set<Promise<unknown>>();
  private initialized = false;
  private initializationStarted = false;
  private replayOwner?: string;
  private closed = false;
  readonly connectors: readonly ContextConnector[];
  private readonly validateCurrent: (value: CurrentContribution) => void;
  readonly runId: string;

  constructor(connectors: readonly ContextConnector[], validateCurrent: (value: CurrentContribution) => void = () => {}, runId: string = randomUUID()) {
    const ids = connectors.map(connector => connector.id);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Connector instances must have distinct identities');
    this.connectors = Object.freeze(connectors.map(connector => Object.freeze({
      id: connector.id, events: connector.events ? Object.freeze([...connector.events]) : undefined, handle: connector.handle.bind(connector),
    })));
    this.validateCurrent = validateCurrent;
    this.runId = runId;
  }

  get snapshot(): readonly OwnedCurrent[] {
    // Installation order is a property of the selection, not completion timing.
    return this.connectors.flatMap(connector => [...this.current.values()].filter(item => item.owner === connector.id));
  }

  async initialize(signal: AbortSignal, data: unknown = { restoring: false }): Promise<readonly SessionEvent[]> {
    if (this.initializationStarted) throw new Error('Composition already initialized');
    this.initializationStarted = true;
    await this.dispatch('run/initialize', data, signal);
    this.initialized = true;
    const records = this.records; this.records = [];
    return records;
  }

  takeMessages(): UserMessage[] { const values = this.messages; this.messages = []; return values; }

  dispatch(type: string, data: unknown, signal: AbortSignal, owner?: string,
    request?: ConnectorRequest, checkAnswer?: (answer: Answer) => void): Promise<Answer | undefined> {
    if (request) {
      // A delegate may await a child that invokes another connector. Do not hold
      // the observation/preparation queue across external request execution.
      const operation = this.deliver(type, data, signal, owner, request, checkAnswer);
      this.requests.add(operation);
      void operation.then(() => this.requests.delete(operation), () => this.requests.delete(operation));
      return operation;
    }
    const operation = this.queue.then(() => this.deliver(type, data, signal, owner, request, checkAnswer));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.requests]); await this.queue; }

  private async deliver(type: string, data: unknown, signal: AbortSignal, owner?: string,
    request?: ConnectorRequest, checkAnswer?: (answer: Answer) => void): Promise<Answer | undefined> {
    if (this.closed) throw new Error('Composition is closed');
    signal.throwIfAborted();
    const input = snapshotJsonValue(data);
    if (input === undefined && data !== undefined) throw new Error('Event data must be JSON-compatible');
    const revision = ++this.revision;
    const event = Object.freeze({ id: randomUUID(), runId: this.runId, type, data: deepFreeze(input), signal,
      ...(request ? { request: Object.freeze({ ...request }) } : {}) }) as ConnectorEvent;
    const selected = this.connectors.filter(connector => (owner === undefined || connector.id === owner)
      && (connector.events === undefined || connector.events.includes(type)));
    if (!selected.length && owner !== undefined) throw new Error('Request owner is unavailable');
    const batches: { connector: ContextConnector; contributions: readonly Contribution[] }[] = [];
    const observationErrors: unknown[] = [];
    for (const connector of selected) {
      try {
        const contributions = await connector.handle(event);
        signal.throwIfAborted();
        if (contributions !== undefined && !Array.isArray(contributions)) throw new Error(`Invalid feedback from ${connector.id}`);
        const snapshot = snapshotJsonValue(contributions ?? []);
        if (!Array.isArray(snapshot)) throw new Error(`Feedback must be JSON-compatible: ${connector.id}`);
        batches.push({ connector, contributions: deepFreeze(snapshot) as readonly Contribution[] });
      } catch (error) {
        if (type !== 'session/event' && type !== 'run/settled') throw error;
        observationErrors.push(error);
      }
    }
    if (observationErrors.length) throw new AggregateError(observationErrors,
      observationErrors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
    if (this.closed) throw new Error('Composition is closed');
    // The commit is synchronous and starts from the latest state, after all I/O.
    // Nested or concurrent requests cannot restore an obsolete state snapshot.
    const current = new Map(this.current); const appended = new Set(this.appended);
    const revisions = new Map(this.currentRevisions);
    const messages: UserMessage[] = []; const records: SessionEvent[] = [];
    let replayOwner = this.replayOwner;
    let answer: Answer | undefined;
    for (const { connector, contributions } of batches) {
      // A superseded response still owns its answer and historical facts. Its
      // current-state batch is discarded together, without repeating external I/O.
      const superseded = contributions.some(item => (item.op === 'put' || item.op === 'remove')
        && (revisions.get(JSON.stringify([connector.id, item.key])) ?? 0) > revision);
      for (const raw of contributions) {
        const item = deepFreeze(snapshotJsonValue(raw)) as Contribution;
        if (!item || typeof item !== 'object') throw new Error('Invalid contribution');
        if (item.op === 'answer') {
          if (!request || owner !== connector.id || item.requestId !== request.id || answer !== undefined) throw new Error('Answer does not match the pending request');
          answer = { value: item.value, ...(item.content ? { content: item.content } : {}) };
          continue;
        }
        if (typeof item.key !== 'string' || !item.key) throw new Error('Contribution key is required');
        const identity = JSON.stringify([connector.id, item.key]);
        if (superseded && (item.op === 'put' || item.op === 'remove')) continue;
        if (item.op === 'put') {
          if (item.value?.kind === 'instruction') {
            if (!['system', 'developer', 'user'].includes(item.value.role) || typeof item.value.text !== 'string') throw new Error('Invalid instruction fragment');
          } else if (item.value?.kind === 'capability') {
            if (typeof item.value.description !== 'string' || !item.value.parameters || !item.value.output) throw new Error('Invalid capability description');
            if (item.value.name !== undefined && (typeof item.value.name !== 'string' || !item.value.name)) throw new Error('Invalid capability name');
          } else if (item.value?.kind === 'projection') {
            if (!item.value.service || this.initialized) throw new Error('Execution projection is selected during initialization');
          } else throw new Error('Unsupported current contribution');
          this.validateCurrent(item.value);
          current.set(identity, Object.freeze({ owner: connector.id, key: item.key, value: item.value }));
          revisions.set(identity, revision);
        } else if (item.op === 'remove') {
          if (current.get(identity)?.value.kind === 'projection' && this.initialized) throw new Error('Execution projection is fixed for this composition');
          current.delete(identity);
          revisions.set(identity, revision);
        } else if (item.op === 'append') {
          if (appended.has(identity)) throw new Error(`Sequence already appended: ${connector.id}/${item.key}`);
          if ('records' in item.value) {
            if (this.initialized) throw new Error('Native replay records can only initialize a composition');
            if (item.value.records.length) {
              if (replayOwner !== undefined && replayOwner !== connector.id) throw new Error('Native replay has multiple owners; provide one coherent history');
              replayOwner = connector.id;
            }
            records.push(...item.value.records);
          } else {
            for (const message of item.value.messages) {
              if (message.role !== 'user' || !message.id || !Array.isArray(message.content)) throw new Error('Expected native user context');
              messages.push(message);
            }
          }
          appended.add(identity);
        } else throw new Error('Unknown contribution operation');
      }
    }
    if (request && !answer) throw new Error('Connector did not answer its request');
    const names = new Set<string>(); let projections = 0;
    for (const item of current.values()) {
      if (item.value.kind === 'capability') {
        const name = item.value.name ?? capabilityName(item.owner, item.key);
        if (names.has(name)) throw new Error(`Conflicting capability name: ${name}`);
        names.add(name);
      }
      if (item.value.kind === 'projection' && ++projections > 1) throw new Error('Multiple execution projections selected for one run');
    }
    if (answer) checkAnswer?.(answer);
    signal.throwIfAborted();
    this.current = current; this.currentRevisions = revisions; this.appended = appended; this.replayOwner = replayOwner;
    this.messages.push(...messages); this.records.push(...records);
    return answer;
  }
}
