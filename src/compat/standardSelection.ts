/** Host defaults and native compatibility. This module is not imported by the framework entry. */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PreparedComposition } from '../registry.ts';
import type { PreparedComposition as LegacyPrepared } from './registry.ts';
import type { ContextConnector } from '../composition.ts';
import { baseTools, subagentSupport } from './defaultConnectors.ts';
import { ownNativeResource } from './nativeResource.ts';
import { adaptLegacyProvider, copiedNativeContext, legacySource } from './adapter.ts';

export async function standardSelection(ctx: Context, prepared: PreparedComposition | LegacyPrepared, cwd: string, _restoring = false, sessionReference?: string) {
  const connectors = [...prepared.connectors];
  // Compatibility tests and old consumers may still supply already prepared descriptions.
  if ('contributions' in prepared) for (const [index, source] of prepared.contributions.entries()) {
    const id = prepared.contributionOwners[index]!;
    connectors.push(await adaptLegacyProvider(ctx, { id, async list() { return []; }, async prepare() { return source; } }).connect({ id }, { cwd }));
  }
  const ordered = prepared.selection.bindings.map(binding => connectors.find(source => source.id === binding.id)!);
  const agentTools = [...baseTools, ...subagentSupport].filter(name => ctx.tools.get(name));
  const agentProvider = adaptLegacyProvider(ctx, { id: 'agent-default', async list() { return []; }, async prepare() {
    return ownNativeResource({ toolNames: agentTools }, { ownsPrompt: name => name === 'harness:identity'
      || name.startsWith('deployment:persona-') || agentTools.some(tool => name === `tool:${tool}`) });
  } });
  if (!ordered.some(source => source.id === 'agent:runtime')) ordered.unshift(await agentProvider.connect({ id: 'agent:runtime' }, { cwd }));
  if (!prepared.cards.some(card => card.kind === 'session')) {
    const sessionProvider = adaptLegacyProvider(ctx, { id: 'session-default', async list() { return []; }, async prepare() {
      return ownNativeResource({ instructions: sessionReference }, { session: true });
    } });
    ordered.push(await sessionProvider.connect({ id: 'session:current' }, { cwd }));
  }
  if (!ordered.some(source => source.id === 'prompt')) ordered.push({ id: 'prompt', events: ['chat/submit', 'agent/prepare-step'], async handle(event) {
    const messages = event.type === 'agent/prepare-step'
      ? event.data.messages
      : [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: String(event.data) }] })];
    return messages.length ? [{ op: 'append', key: event.id, value: { messages } }] : [];
  } });
  return { connectors: ordered,
    async installNativeCompatibility(scope: Context, agent: Agent) {
      // Parent native sections copied by compatibility services must not duplicate child context.
      scope.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next();
        if (context.contextCompositionProbe || context.agent === agent) return assembly;
        const copied = copiedNativeContext(agent);
        return { ...assembly, sections: assembly.sections.filter(section => copied.get(`system/${section.name}`) !== section.text),
          contexts: assembly.contexts.filter(section => copied.get(`user/${section.name}`) !== section.text) };
      });
      scope.on('agent/pre-step', async (event, next) => {
        const decision = await next();
        if (event.agent !== agent || decision.kind === 'reject') return decision;
        const selectedSkills = new Set(ordered.flatMap(connector => {
          const source = legacySource(connector);
          return [...source?.skillNames ?? [], ...source?.skills?.map(skill => skill.name) ?? []];
        }));
        return { ...decision, messages: decision.messages.filter(message => {
          const source = message.source as { kind: string; name?: string };
          return source.kind !== 'agent-instructions' && source.kind !== 'skill-catalog'
            && (source.kind !== 'skill-invocation' || selectedSkills.has(source.name ?? ''));
        }) };
      });
    },
    async dispose() { if ('dispose' in prepared) await prepared.dispose(); },
  };
}
