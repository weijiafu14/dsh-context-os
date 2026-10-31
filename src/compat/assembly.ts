import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-working-directory';
import type { RunSelection } from '../core.ts';
import type { PreparedComposition } from './registry.ts';
import { baseTools } from './defaultConnectors.ts';
import { connectContext } from './events.ts';
import { installInputAssembly, stepInputWindow } from './dshInput.ts';
import { inputConnector } from './input.ts';

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:context-connectors/selection': { selection: RunSelection; labels: string[]; protocol?: 'events' }; }
}

/** Compose an Agent's native scope. No loop replacement and no workspace skill files. */
export async function installComposition(ctx: Context, agent: Agent, prepared: PreparedComposition): Promise<void> {
  if (prepared.connectors.length) throw new Error('Event connector providers require the event composition runtime');
  const fiber = ctx.inject(['tools', 'skills', 'systemPrompt'], async scope => {
    await installInScope(scope, agent, prepared);
  });
  await fiber;
  await fiber.await();
  if (fiber.state !== 2) throw new Error('Connector assembly dependencies did not become ready');
}

async function installInScope(ctx: Context, agent: Agent, prepared: PreparedComposition): Promise<void> {
  connectContext(ctx, stepInputWindow, inputConnector);
  installInputAssembly(ctx, agent);
  const inherited = ctx.tools.definitions(agent).map(tool => tool.name);
  const names = new Set<string>();
  const allowed = new Set<string>([...baseTools].filter(name => ctx.tools.get(name, agent)));
  const selectedMcp = new Set<string>();
  for (const card of prepared.cards) if (card.kind === 'mcp' && card.id.startsWith('mcp:')) selectedMcp.add(card.id.slice(4));
  for (const [index, contribution] of prepared.contributions.entries()) {
    if (contribution.instructions) ctx.systemPrompt.context({ name: `context-connectors:${index}`, order: 80 + index, interpolate: false, text: contribution.instructions });
    for (const skill of contribution.skills ?? []) {
      if (names.has(skill.name)) throw new Error(`Duplicate selected skill: ${skill.name}`);
      ctx.skills.register(skill);
      names.add(skill.name);
    }
    for (const name of contribution.skillNames ?? []) names.add(name);
    for (const name of contribution.toolNames ?? []) {
      if (!ctx.tools.get(name, agent)) throw new Error(`Tool unavailable in this run: ${name}`);
      allowed.add(name);
    }
    for (const tool of contribution.tools ?? []) { ctx.tools.register(tool); allowed.add(tool.name); }
  }
  // Native restrictions cover both ordinary calls and nested PTC calls.
  ctx.tools.restrict({ allow: inherited.filter(name => allowed.has(name)) });
  // MCP instructions are separate from tool schemas; keep this filter active across reconnects.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    return { ...assembly, sections: assembly.sections.filter(section => !section.name.startsWith('mcp:') || selectedMcp.has(section.name.slice(4))) };
  });

  if (names.size) {
    const summaries = (await ctx.skills.list({ scope: agent, cwd: agent.session.header.cwd })).filter(skill => names.has(skill.name));
    for (const name of names) if (!summaries.some(skill => skill.name === name)) throw new Error(`Selected skill unavailable: ${name}`);
    ctx.systemPrompt.context({ name: 'context-connectors:skills', order: 79, interpolate: false,
      text: 'Skills available for this run (call skill to load instructions before using):\n' + summaries.map(skill => `${skill.name}: ${skill.description}`).join('\n') });
    ctx.tools.register(defineTool({
      name: 'skill', description: 'Load the full instructions of a skill selected for this run.',
      parameters: { name: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args, exec) {
        if (!names.has(args.name)) throw new Error('Skill was not selected for this run');
        const skill = await ctx.skills.get(args.name, { scope: exec.agent, cwd: agent.session.header.cwd, signal: exec.signal });
        if (!skill || !skill.invocation.modelInvocable) throw new Error('Skill is unavailable for model invocation');
        return { text: renderSkillContent(skill) };
      },
    }));
  }
  // Root native skill plugins may inject explicit /skill messages. Retain only selected ones;
  // our scoped skill tool owns the catalog, so remove the global catalog projection.
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    return { ...decision, messages: decision.messages.filter(message => {
      const source = message.source as { kind: string; name?: string };
      return source.kind !== 'skill-catalog' && (source.kind !== 'skill-invocation' || names.has(source.name ?? ''));
    }) };
  });
  for (const contribution of prepared.contributions) for (const message of contribution.messages ?? []) agent.inject(message);
  appendPluginRecord(agent.session, 'plugin:context-connectors/selection', { selection: prepared.selection, labels: prepared.cards.map(card => card.label) });
  ctx.effect(() => () => prepared.dispose(), 'context-connectors:run-resources');
}
