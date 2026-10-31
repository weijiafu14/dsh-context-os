import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { agentEvents } from '@deepseek-ai/dsh-agent';
import type { Agent, AgentHandle, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent';
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, UserMessage, DeveloperMessage, ToolSchema } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition, ToolExecutor, JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import type { Scoped } from '@deepseek-ai/dsh-scope';
import type { AssembledSection, AssembledContext } from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-subagent';
import { Composition, capabilityName } from './composition.ts';
import type { ContextConnector, OwnedCurrent } from './composition.ts';
import { nativeActivation, nativeDefinition, withNativeInvocation } from './nativeBindings.ts';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';

/** Internal native admission uses the existing durable surface replacement mechanism. */
interface ContextAdmission {
  messages: UserMessage[];
  developerMessages: DeveloperMessage[];
  messageReplacements: { seq: SessionSeq; message: DeveloperMessage | UserMessage }[];
  tools: ToolSchema[];
  sections: AssembledSection[];
  contexts: AssembledContext[];
}
export interface SendReceipt {
  /** Resolves after the accepted work and resource settlement drain; rejects on execution/save errors. */
  readonly completed: Promise<TurnEndReason | undefined>;
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'context-composition': { kind: 'context-composition'; slot?: 'background' }; }
}
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext { contextCompositionProbe?: boolean; }
  interface PromptPresentation { admission?: ContextAdmission; }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/prepare-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: readonly UserMessage[]; turn: number; step: number; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }): void | Promise<void>;
  }
}

export { capabilityName };

export interface ComposedRunOptions {
  readonly connectors: readonly ContextConnector[];
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly model: AgentOptions;
  readonly signal?: AbortSignal;
  /** Native host integration; it is not a connector contribution type. */
  readonly agent?: Agent;
  readonly setup?: (scope: Context, agent: Agent) => Promise<void>;
}

const composedAgents = new WeakSet<Agent>();
export const isComposedAgent = (agent: Agent): boolean => composedAgents.has(agent);

/** Experimental engine entry; requires the reviewed native preparation/admission patch. */
export async function createComposedRun(ctx: Context, options: ComposedRunOptions) {
  const bootstrap = (globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')] as { version: number } | undefined;
  if (bootstrap && bootstrap.version < 3) throw new Error('Update the context runtime bootstrap before using this framework');
  const runId = options.agent?.id || options.sessionId || randomUUID();
  const composition = new Composition(options.connectors, value => {
    if (value.kind === 'capability') {
      assertSupportedJsonSchema(value.output);
    }
  }, runId);
  const lifetime = new AbortController();
  const initialization = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
  let replay: readonly SessionEvent[];
  try { replay = await composition.initialize(initialization, { restoring: Boolean(options.agent?.session.deriveMessages().length) }); }
  catch (error) {
    try {
      await composition.dispatch('run/settled', { events: [], closing: true, outcome: { kind: 'error', phase: 'initialize',
        message: error instanceof Error ? error.message : String(error) } }, lifetime.signal);
    } catch (cleanup) { throw new AggregateError([error, cleanup], 'Initialization and cleanup failed'); }
    finally { await composition.close(); lifetime.abort(); }
    throw error;
  }
  let handle: AgentHandle | undefined;
  let records: Promise<void> = Promise.resolve();
  const saveErrors: unknown[] = [];
  let sourceQueue: Promise<unknown> = Promise.resolve();
  let completion: Promise<TurnEndReason | undefined> | undefined;
  let finalizedSeq = -1;
  let finalization: Promise<void> = Promise.resolve();
  let disposed = false;
  const sourceDeliveries = new Set<AbortController>();
  const acceptedInputs = new Map<string, UserMessage>();

  const setup = async (scope: Context, agent: Agent) => {
        if (composedAgents.has(agent)) throw new Error('Agent already has a context composition');
        composedAgents.add(agent);
        const projections = composition.snapshot.filter(item => item.value.kind === 'projection');
        if (projections.length > 1) throw new Error('Multiple execution projections selected for one run');
        const dependencies = ['tools', 'systemPrompt', ...projections.flatMap(item => item.value.kind === 'projection' ? [item.value.service] : [])];
        const fiber = scope.inject(dependencies, inner => {
          let installed = new Map<string, { value: string; native?: ToolDefinition; remove: () => void }>();
          let system = '';
          let developer = '';
          let background = '';
          let prepared = '';
          let pending: UserMessage[] = [];
          let admission: ContextAdmission | undefined;
          let capabilityOrder = new Map<string, number>();
          const children = new Set<string>();
          let maintaining = false;

          // Only capabilities contributed to this composition are model-callable.
          // Native PTC owns its transport outside this registry restriction.
          let restriction = inner.tools.restrict({ allow: [] });
          inner.systemPrompt.section({ name: 'context-composition', order: 100, text: () => system, interpolate: false });
          inner.systemPrompt.context({ name: 'context-composition/background', order: 100, text: () => background, interpolate: false });
          if (projections[0]?.value.kind === 'projection') {
            const executor = inner.get(projections[0].value.service) as ToolExecutor | undefined;
            if (!executor || typeof executor.describe !== 'function' || typeof executor.execute !== 'function') throw new Error('Selected service is not a native execution projection');
            inner.tools.setExecutor(executor);
          }
          // A composed run admits only its selected services' contributions.
          // Compatibility providers can read native context, but ambient plugin
          // registrations never become an implicit second assembly channel.
          inner.on('system-prompt/assemble', async (_assembly, context, next) => {
            const assembly = await next();
            if (context.contextCompositionProbe || context.agent !== agent) return assembly;
            const bridge = inner.tools as unknown as { selectExecutor(scope: Agent): ToolExecutor };
            const executor = bridge.selectExecutor(agent);
            const executorSections = new Set(executor.sections?.map(section => section.name));
            const definitions = inner.tools.definitions(agent, context.toolSet)
              .filter(tool => capabilityOrder.has(tool.name))
              .sort((a, b) => capabilityOrder.get(a.name)! - capabilityOrder.get(b.name)!);
            const sections = [{ name: 'context-composition', text: system, interpolate: false },
              ...structuredClone(assembly.sections.filter(section => executorSections.has(section.name)))];
            const contexts: AssembledContext[] = []; // Current user context is admitted with durable replacement semantics below.
            admission ??= { messages: [], developerMessages: [], messageReplacements: [], tools: structuredClone([...executor.describe(definitions).schemas]),
              sections: structuredClone(sections), contexts: structuredClone(contexts) };
            // Legacy waterfalls may mutate their working copy. Final admission
            // uses the independent snapshot, not that mutable draft.
            return { ...assembly, admission, sections, contexts };
          });

          const definition = (item: OwnedCurrent): ToolDefinition => {
            if (item.value.kind !== 'capability') throw new Error('Expected a capability');
            const value = item.value;
            const native = nativeDefinition(options.connectors, item.owner, item.key);
            assertSupportedJsonSchema(value.output);
            if (!native) assertSupportedJsonSchema(value.parameters as JsonSchemaNode);
            const content = new Map<symbol, readonly ContentBlock[]>();
            return {
              ...native,
              name: value.name || capabilityName(item.owner, item.key), description: value.description, parameters: value.parameters,
              output: native ? { ...native.output, schema: value.output } : { schema: value.output, render: (_args, result) => [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] },
              async execute(args, execution) {
                const violations = native ? [] : validateJsonSchemaValue(value.parameters as JsonSchemaNode, args);
                if (violations.length) throw new Error(violations.join('; '));
                const requestId = randomUUID();
                const answer = await withNativeInvocation(requestId, execution, () => composition.dispatch('tools/execute', { arguments: args,
                  callId: execution.callId, rootCallId: execution.rootCallId, nested: execution.parent !== undefined },
                  execution.signal, item.owner, { id: requestId, key: item.key, callId: execution.callId }, answer => {
                    const errors = validateJsonSchemaValue(value.output, answer.value);
                    if (errors.length) throw new Error(errors.join('; '));
                  }), native);
                if (!answer) throw new Error('Missing connector response');
                if (answer.content) content.set(execution.token, answer.content);
                return answer.value;
              },
              projectContent(execution, result) { return (result.isError ? undefined : content.get(execution.token)?.map(block => structuredClone(block))) ?? native?.projectContent?.(execution, result); },
              finalizeContent(execution, result) { content.delete(execution.token); return native?.finalizeContent?.(execution, result); },
            };
          };

          inner.on('agent/prepare-step', async event => {
            if (event.agent !== agent) return;
            await records;
            event.signal.throwIfAborted();
            await composition.dispatch('agent/prepare-step', { turn: event.turn, step: event.step, messages: event.messages }, event.signal);
            const snapshot = composition.snapshot;
            // Validate every schema before changing the current registrations.
            const desired = new Map<string, { serialized: string; definition: ToolDefinition; native?: ToolDefinition }>();
            for (const item of snapshot) {
              if (item.value.kind !== 'capability') continue;
              const name = item.value.name || capabilityName(item.owner, item.key);
              if (desired.has(name)) throw new Error(`Conflicting capability name: ${name}`);
              desired.set(name, { serialized: JSON.stringify(item.value), definition: definition(item), native: nativeDefinition(options.connectors, item.owner, item.key) });
            }
            for (const [name, entry] of installed) if (desired.get(name)?.serialized !== entry.value || desired.get(name)?.native !== entry.native) { entry.remove(); installed.delete(name); }
            for (const [name, entry] of desired) if (!installed.has(name)) installed.set(name, { value: entry.serialized, native: entry.native, remove: inner.tools.register(entry.definition, { when: nativeActivation(entry.native) }) });
            restriction();
            const inherited = new Set(inner.tools.definitions().map(tool => tool.name));
            restriction = inner.tools.restrict({ allow: [...desired.keys()].filter(name => inherited.has(name)) });
            capabilityOrder = new Map([...desired.keys()].map((name, index) => [name, index]));
            const instructions = (role: 'system' | 'developer' | 'user') => snapshot.flatMap(item =>
              item.value.kind === 'instruction' && item.value.role === role ? [item.value.text] : []).join('\n\n');
            system = instructions('system'); developer = instructions('developer');
            background = instructions('user');
            pending = composition.takeMessages();
            admission = undefined;
            prepared = `${event.turn}/${event.step}`;
          });

          inner.on('agent/pre-step', async (event, next) => {
            const decision = await next();
            if (event.agent !== agent || decision.kind === 'reject') return decision;
            if (prepared !== `${event.turn}/${event.step}`) throw new Error('This DSH runtime lacks the required context preparation hook');
            const contributedIds = new Set(pending.map(message => message.id));
            const claimedIds = new Set(event.messages.map(message => message.id));
            const allowedIds = new Set(decision.messages.map(message => message.id));
            const messages = [...decision.messages.flatMap(message => !contributedIds.has(message.id) && acceptedInputs.has(message.id)
              ? [acceptedInputs.get(message.id)!] : []), ...pending.filter(message => !claimedIds.has(message.id) || allowedIds.has(message.id))];
            const ids = new Set(messages.map(message => message.id));
            if (ids.size !== messages.length) throw new Error('Duplicate native input identity');
            if (event.step === 1 && event.messages.length && !messages.length) throw new Error('No selected service admitted the input');
            const developerMessages: DeveloperMessage[] = [];
            const messageReplacements: ContextAdmission['messageReplacements'] = [];
            const visible = new Set(agent.session.surface.nodes);
            const records = agent.session.snapshotEvents().filter(record => visible.has(record.seq));
            for (const role of ['developer', 'user'] as const) {
              const text = role === 'developer' ? developer : background;
              const source = role === 'developer' ? { kind: 'context-composition' as const }
                : { kind: 'context-composition' as const, slot: 'background' as const };
              const content = text ? [{ type: 'text' as const, text }] : [];
              const previous = records.flatMap(record => {
                const message = record.type === 'user/message' ? record.data
                  : record.type === 'developer/message' ? record.data.message : undefined;
                if (!message) return [];
                const owned = message.source.kind === 'context-composition' && message.source.slot === source.slot;
                const legacyBackground = role === 'user' && String(message.source.kind) === 'runtime-context';
                return owned || legacyBackground ? [{ seq: record.seq, message }] : [];
              });
              // An empty developer node preserves position in the durable surface
              // without emitting a content-less wire message (DSH's native contract).
              const message = role === 'user' && text ? createUserMessage({ source, content }) : createDeveloperMessage({ source, content });
              if (!previous.length) {
                if (text) {
                  if (message.role === 'developer') developerMessages.push(message);
                  else messages.push(message);
                }
              } else for (const [index, record] of previous.entries()) {
                const next = index === 0 ? message : createDeveloperMessage({ source, content: [] });
                if (JSON.stringify(record.message.content) !== JSON.stringify(next.content) || record.message.role !== next.role) {
                  messageReplacements.push({ seq: record.seq, message: next });
                }
              }
            }
            if (!admission) throw new Error('Missing compiled context admission');
            admission.messages = structuredClone(messages); admission.developerMessages = structuredClone(developerMessages);
            admission.messageReplacements = structuredClone(messageReplacements);
            deepFreeze(admission);
            return { ...decision, messages, developerMessages, messageReplacements };
          });

          inner.on('session/event', (session, event) => {
            if (session !== agent.session) return;
            if (event.type === 'user/message') acceptedInputs.delete(event.data.id);
            const snapshot = structuredClone(event);
            records = records.then(async () => {
              await composition.dispatch('session/event', { record: snapshot }, lifetime.signal);
            }).catch(error => { saveErrors.push(error); });
          });
          const finalizeIfIdle = () => {
            if (agent.status !== 'idle' || children.size || maintaining) return;
            const end = [...agent.session.snapshotEvents()].reverse().find(event => event.type === 'turn/end');
            if (!end || end.seq <= finalizedSeq) return;
            finalizedSeq = end.seq;
            maintaining = true;
            // DSH's maintenance gate keeps whenIdle/SDK waits behind persistence,
            // including native Web follow-ups that do not call run.send().
            finalization = agent.runMaintenance(async () => {
              await records;
              await composition.dispatch('run/settled', { events: agent.session.snapshotEvents(), outcome: end.data.reason },
                lifetime.signal);
            }).catch(error => {
              saveErrors.push(error);
              agentEvents(inner, agent).emit('agent/error', { turn: end.data.turn, step: 0, error });
            }).finally(() => { maintaining = false; });
          };
          inner.on('agent/status', ({ agent: changed, status }) => { if (changed === agent && status === 'idle') finalizeIfIdle(); });
          inner.on('subagent/start', info => { children.add(info.runId); });
          inner.on('subagent/end', info => { children.delete(info.runId); queueMicrotask(finalizeIfIdle); });
          inner.effect(() => () => { for (const item of installed.values()) item.remove(); installed = new Map(); });
        });
        await fiber; await fiber.await();
        if (fiber.state !== 2) throw new Error('Composition dependencies are not ready');
  };

  try {
    if (options.agent) {
      if (replay.length) throw new Error("A live Agent already owns its replay state");
      await setup(options.agent.ctx, options.agent);
      handle = { agent: options.agent, dispose: async () => {} } as AgentHandle;
    } else handle = await ctx.agents.create({ sessionId: SessionId(runId), signal: initialization,
      agentOptions: options.model,
      meta: { ...(options.cwd ? { cwd: options.cwd } : {}), ...(replay.length ? { isSeeded: true } : {}) },
      ...(replay.length ? { seed: [...replay], inheritedEventCount: SessionLogOffset(replay.length) } : {}),
      setup: async (scope, agent) => { await options.setup?.(scope, agent); await setup(scope, agent); }
    });
  } catch (error) {
    await handle?.dispose(); await records;
    try {
      await composition.dispatch('run/settled', { events: [], closing: true, outcome: { kind: 'error', phase: 'create',
        message: error instanceof Error ? error.message : String(error) } }, lifetime.signal);
    } catch (cleanup) { throw new AggregateError([error, cleanup], 'Creation and cleanup failed'); }
    finally { await composition.close(); lifetime.abort(); }
    throw error;
  }

  const agent = handle.agent;
  const waitForCompletion = (): Promise<TurnEndReason | undefined> => {
    if (completion) return completion;
    completion = (async () => {
      for (;;) {
        await agent.whenIdle();
        const sequence = agent.session.seq;
        const children = await ctx.get('subagents')?.waitForChildren(agent);
        await records; await finalization;
        if (!children && agent.status === 'idle' && agent.session.seq === sequence) break;
      }
      if (saveErrors.length) throw new AggregateError(saveErrors.splice(0), 'Connector persistence failed');
      const end = [...agent.session.snapshotEvents()].reverse().find(event => event.type === 'turn/end');
      if (end?.data.reason.kind === 'error') throw new Error(end.data.reason.error.message);
      return end?.data.reason;
    })().finally(() => { completion = undefined; });
    // Callers can consume the receipt now and await completion later.
    void completion.catch(() => {});
    return completion;
  };
  let disposal: Promise<void> | undefined;
  return {
    agent,
    /** Always acknowledges admission. Await receipt.completed for execution and persistence. */
    send(type: string, data: unknown, owner?: string): Promise<SendReceipt> {
      if (/^(agent|tools|session|run)\//.test(type)) return Promise.reject(new Error('External sources cannot impersonate runtime events'));
      if (disposed) return Promise.reject(new Error('Run is disposed'));
      const delivery = new AbortController(); sourceDeliveries.add(delivery);
      const operation = sourceQueue.then(async () => {
        if (disposed) throw new Error('Run is disposed');
        await composition.dispatch(type, data, AbortSignal.any([delivery.signal, lifetime.signal]), owner);
        const messages = composition.takeMessages();
        for (const message of messages) acceptedInputs.set(message.id, message);
        if (agent.status === 'idle' && messages.length) agent.followup(messages.shift()!);
        for (const message of messages) agent.inject(message);
        return Object.freeze({ completed: agent.status !== 'idle' || completion ? waitForCompletion() : Promise.resolve(undefined) });
      }).finally(() => { sourceDeliveries.delete(delivery); });
      sourceQueue = operation.catch(() => {});
      return operation;
    },
    cancel() { for (const delivery of sourceDeliveries) delivery.abort(new Error('Run cancelled')); agent.cancel({ kind: 'user' }); },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      for (const delivery of sourceDeliveries) delivery.abort(new Error('Run disposed'));
      agent.cancel({ kind: 'disposed' });
      disposal = (async () => {
        await sourceQueue;
        await agent.whenIdle(); await records; await finalization;
        try {
          await composition.dispatch('run/settled', { events: agent.session.snapshotEvents(), outcome: { kind: 'disposed' }, closing: true }, lifetime.signal);
        } finally { try { await handle!.dispose(); } finally { await composition.close(); lifetime.abort(); } }
      })();
      return disposal;
    },
  };
}
