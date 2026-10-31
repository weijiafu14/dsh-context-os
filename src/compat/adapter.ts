/** Compatibility for old provider.prepare(). The framework only sees complete handlers. */
import { SessionId } from '@deepseek-ai/dsh-session';
import { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import type { ContextConnector, ConnectorEvent, Contribution } from '../composition.ts';
import type { ConnectorProvider, PreparedComposition } from '../registry.ts';
import type { ConnectorContribution, ConnectorProvider as LegacyProvider, PreparedComposition as LegacyPrepared } from './registry.ts';
import { releaseContribution } from './registry.ts';
import { nativeResource, resourceOwnership } from './nativeResource.ts';
import { copyNativeBindings } from '../nativeBindings.ts';

interface CompatibilityState {
  descriptors: WeakMap<ContextConnector, { resolve(): Promise<ConnectorContribution>; source?: ConnectorContribution }>;
  captured: WeakMap<Agent, { id: string; assembly: Promise<PromptAssembly>; originals: Map<string, string> }>;
}
const key = Symbol.for('dsh.context-compatibility.v1');
const globals = globalThis as typeof globalThis & { [key]?: CompatibilityState };
const { descriptors, captured } = globals[key] ??= { descriptors: new WeakMap(), captured: new WeakMap() };
export function copiedNativeContext(agent: Agent): ReadonlyMap<string, string> { return captured.get(agent)?.originals ?? new Map(); }
export function legacySource(connector: ContextConnector) { return descriptors.get(connector)?.source; }

async function describe(ctx: Context, agent: Agent, event: ConnectorEvent, owns: (name: string) => boolean): Promise<Contribution[]> {
  let state = captured.get(agent);
  if (state?.id !== event.id) {
    state = { id: event.id, assembly: ctx.systemPrompt.assemble({ scope: agent, agent, signal: event.signal,
      modelSelection: agent.model.current(), contextCompositionProbe: true }), originals: new Map() };
    captured.set(agent, state);
  }
  const assembly = await state.assembly; const changes: Contribution[] = [];
  for (const section of assembly.sections) if (owns(section.name)) {
    state.originals.set(`system/${section.name}`, section.text);
    changes.push({ op: 'put', key: `system/${section.name}`, value: { kind: 'instruction', role: 'system', text: renderPrompt({ ...assembly, sections: [section] }) } });
  }
  for (const section of renderContextSections(assembly)) if (owns(section.name)) {
    state.originals.set(`user/${section.name}`, assembly.contexts.find(item => item.name === section.name)!.text);
    changes.push({ op: 'put', key: `user/${section.name}`, value: { kind: 'instruction', role: 'user', text: section.text } });
  }
  return changes;
}

export function adaptLegacyProvider(ctx: Context, provider: LegacyProvider): ConnectorProvider {
  return { id: provider.id, list: context => provider.list(context), async connect(binding, context) {
    if (provider.connect) return provider.connect(binding, context);
    let inner: ContextConnector | undefined;
    let agent: Agent | undefined;
    let pending: Promise<ConnectorContribution> | undefined;
    let adapterScope: Context | undefined;
    let releaseAdapter: (() => Promise<void>) | undefined;
    const descriptor = { source: undefined as ConnectorContribution | undefined, resolve() {
      return pending ??= (async () => {
        if (!provider.prepare) throw new Error('Compatibility provider has no implementation');
        return descriptor.source = await provider.prepare(binding, context);
      })();
    } };
    const connector: ContextConnector = { id: binding.id,
      events: ['run/initialize', 'agent/prepare-step', 'tools/execute', 'session/event', 'run/settled'],
      async handle(event) {
        if (!inner && event.type === 'run/settled') {
          if (descriptor.source && (event.data as { closing?: boolean }).closing) await releaseContribution(descriptor.source);
          await releaseAdapter?.();
          return;
        }
        if (!inner) {
          const dependencies = ['agents', 'tools', 'sessions', 'systemPrompt', ...(ctx.get('skills') ? ['skills'] : [])];
          const fiber = ctx.inject(dependencies, scope => { adapterScope = scope; });
          releaseAdapter = async () => { await fiber.dispose(); };
          await fiber; await fiber.await();
          if (fiber.state !== 2 || !adapterScope) throw new Error('Native compatibility dependencies are unavailable');
          const source = await descriptor.resolve();
          adapterScope.effect(() => () => releaseContribution(source), 'context-compatibility-resource');
          inner = nativeResource({ ctx: adapterScope, cwd: context.cwd, restoring: Boolean((event.data as { restoring?: boolean }).restoring), agent: () => agent,
            describe: (event, owns) => agent ? describe(adapterScope!, agent, event, owns) : Promise.resolve([]),
          }, { id: binding.id, contribution: source, ...resourceOwnership(source) });
        }
        agent = adapterScope!.agents.get(SessionId(event.runId));
        try {
          const result = await inner.handle(event);
          copyNativeBindings(inner, connector);
          return result;
        } finally {
          if (event.type === 'run/settled' && (event.data as { closing?: boolean }).closing) await releaseAdapter?.();
        }
      },
    };
    descriptors.set(connector, descriptor);
    return connector;
  } };
}

/** Only the unpatched legacy entry consumes these old fields. */
export async function materializeLegacy(prepared: PreparedComposition): Promise<LegacyPrepared> {
  const contributions: ConnectorContribution[] = [];
  const owners: string[] = [];
  try {
    for (const connector of prepared.connectors) {
      const descriptor = descriptors.get(connector);
      if (!descriptor) throw new Error('This service requires the event runtime bootstrap');
      contributions.push(await descriptor.resolve()); owners.push(connector.id);
    }
    if (contributions.filter(source => source.seed !== undefined).length > 1) throw new Error('Multiple native session histories cannot be concatenated');
  } catch (error) { await Promise.allSettled(contributions.map(releaseContribution)); throw error; }
  return { ...prepared, contributions, contributionOwners: owners, connectors: [],
    async dispose() { const failures = (await Promise.allSettled(contributions.map(releaseContribution))).filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Compatibility cleanup failed'); },
  };
}
