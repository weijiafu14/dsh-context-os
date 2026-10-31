import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { ScopeKey, Scoped } from '@deepseek-ai/dsh-scope';

/** A native assembly boundary, not a resource category. Owned by the host adapter. */
export interface AssemblyWindow<Input, Value> {
  readonly name: string;
  /** Snapshot/validate input before any connector sees it. */
  readonly input: (input: Input) => Readonly<Input>;
  /** Snapshot/validate a contribution before another connector runs. */
  readonly accept: (value: unknown) => Value;
}

export interface ContextEvent<Input> {
  readonly id: string;
  readonly type: string;
  readonly input: Readonly<Input>;
  readonly signal: AbortSignal;
}

export interface ContextContribution<Value> {
  readonly key: string;
  readonly value: Value;
}

export interface EventConnector<Input, Value> {
  /** Instance identity, not a provider/package name. */
  readonly id: string;
  handle(event: ContextEvent<Input>): Promise<readonly ContextContribution<Value>[] | void>;
}

export interface OwnedContribution<Value> extends ContextContribution<Value> {
  readonly owner: string;
}

export interface ContextAssembly<Value> {
  readonly eventId: string;
  readonly contributions: readonly OwnedContribution<Value>[];
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'context-connectors/assemble'(this: Scoped<Context>, event: ContextEvent<unknown>,
      next: () => Promise<readonly OwnedContribution<unknown>[]>): Promise<readonly OwnedContribution<unknown>[]>;
  }
}

/** Use Cordis for event routing, order and disposal; this is not a second plugin registry. */
export function connectContext<Input, Value>(ctx: Context, window: AssemblyWindow<Input, Value>, connector: EventConnector<Input, Value>): () => void {
  if (!connector.id) throw new Error('Connector instance identity is required');
  return ctx.on('context-connectors/assemble', async (event, next) => {
    if (event.type !== window.name) return next();
    event.signal.throwIfAborted();
    const output = await connector.handle(event as ContextEvent<Input>);
    event.signal.throwIfAborted();
    if (output !== undefined && !Array.isArray(output)) throw new Error(`Connector ${connector.id} must return contributions`);
    const own = (output ?? []).map(item => {
      if (!item || typeof item.key !== 'string' || !item.key) throw new Error(`Connector ${connector.id} returned an invalid contribution identity`);
      try {
        return Object.freeze({ owner: connector.id, key: item.key, value: window.accept(item.value) });
      } catch (cause) {
        throw new Error(`Invalid contribution ${connector.id}/${item.key} at ${window.name}`, { cause });
      }
    });
    // Explicit Cordis registration order, never asynchronous completion order.
    return [...own, ...await next()];
  });
}

/** Collect a complete candidate. The caller commits only after this returns successfully. */
export async function assembleContext<Input, Value>(ctx: Context, scope: ScopeKey,
  window: AssemblyWindow<Input, Value>, input: Input, signal: AbortSignal): Promise<ContextAssembly<Value>> {
  signal.throwIfAborted();
  const event = Object.freeze({ id: randomUUID(), type: window.name, input: window.input(input), signal });
  const contributions = await ctx.waterfall(scopeTarget(ctx, scope), 'context-connectors/assemble', event, async () => []);
  signal.throwIfAborted();
  const identities = new Set<string>();
  const accepted = contributions.map(item => {
    const identity = JSON.stringify([item.owner, item.key]);
    if (identities.has(identity)) throw new Error(`Duplicate contribution ${item.owner}/${item.key} at ${window.name}`);
    identities.add(identity);
    return Object.freeze({ owner: item.owner, key: item.key, value: window.accept(item.value) });
  });
  return Object.freeze({ eventId: event.id, contributions: Object.freeze(accepted) });
}
