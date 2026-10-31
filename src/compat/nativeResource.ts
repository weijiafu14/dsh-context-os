/** Native service adapter. A selected service keeps one identity for its entire lifecycle. */
import { createHash } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import type { SkillRegistration, SkillSummary } from '@deepseek-ai/dsh-skill';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ScopeKey } from '@deepseek-ai/dsh-scope';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { ConnectorEvent, ContextConnector, Contribution } from '../composition.ts';
import type { ConnectorContribution } from './registry.ts';
import { releaseContribution } from './registry.ts';
import { bindNativeDefinitions, captureNativeTools, executeNative } from '../nativeBindings.ts';

/** Internal native ABI access. This is not a new connector or assembly API. */
export interface NativeResourceHost {
  ctx: Context;
  cwd: string;
  restoring: boolean;
  agent(): Agent | undefined;
  describe(event: ConnectorEvent, owns: (name: string) => boolean): Promise<Contribution[]>;
}
export interface NativeResourceOptions {
  id: string;
  contribution: ConnectorContribution;
  ownsPrompt?: (name: string) => boolean;
  session?: boolean;
  handle?: ContextConnector['handle'];
}
const ownership = new WeakMap<ConnectorContribution, Pick<NativeResourceOptions, 'ownsPrompt' | 'session' | 'handle'>>();
export function ownNativeResource(source: ConnectorContribution, policy: Pick<NativeResourceOptions, 'ownsPrompt' | 'session' | 'handle'>): ConnectorContribution {
  ownership.set(source, policy); return source;
}
export const resourceOwnership = (source: ConnectorContribution) => ownership.get(source) ?? {};

export function nativeResource(host: NativeResourceHost, options: NativeResourceOptions): ContextConnector {
  const { ctx } = host; const source = options.contribution;
  let lease: { key: ScopeKey } & AsyncDisposable | undefined;
  let sourceScope: ScopeKey | undefined;
  let disposed = false;
  let prepared = false;
  let current = new Set<string>();
  let tools = new Map<string, ToolDefinition>();
  let skills = new Map<string, SkillSummary | SkillRegistration>();
  const calls = new Set<string>();
  // The native service, including history and writeback, owns this state.
  const records = new Map<number, unknown>();
  const loadName = `read_skill_${createHash('sha256').update(options.id).digest('hex').slice(0, 16)}`;
  const connector: ContextConnector = { id: options.id,
    events: ['run/initialize', 'agent/prepare-step', 'tools/execute', 'session/event', 'run/settled'],
    async handle(event) {
      if (event.type === 'run/settled') {
        try {
          const feedback = await options.handle?.(event) ?? [];
          if (options.session) {
            const agent = ctx.agents.get(SessionId(event.runId));
            if (agent) await ctx.sessions.flush(agent.session);
          }
          records.clear(); calls.clear();
          return feedback;
        } finally {
          if ((event.data as { closing?: boolean }).closing && !disposed) {
            disposed = true;
            try { await releaseContribution(source); } finally { await lease?.[Symbol.asyncDispose](); }
          }
        }
      }
      const feedback = await options.handle?.(event) ?? [];
      if (event.type === 'session/event') {
        const record = (event.data as { record: { seq: number; data?: { callId?: string } } }).record;
        if (options.session || (record.data?.callId && calls.has(record.data.callId))) records.set(record.seq, record);
        return feedback;
      }
      if (event.type === 'tools/execute') {
        calls.add(event.request!.callId);
        if (event.request!.key === 'skill-body') {
          const name = (event.data.arguments as { name: string }).name;
          const chosen = skills.get(name);
          if (!chosen) throw new Error('Skill does not belong to this resource');
          const skill = source.skills?.find(item => item.name === name)
            ?? await ctx.skills.get(name, { cwd: host.cwd, scope: sourceScope, signal: event.signal });
          if (!skill) throw new Error('Selected skill is unavailable');
          const text = renderSkillContent({ ...skill, provider: skill.provider ?? options.id });
          return [...feedback, { op: 'answer', requestId: event.request!.id, value: { text }, content: [{ type: 'text', text }] }];
        }
        const tool = tools.get(event.request!.key);
        if (!tool) throw new Error('Capability does not belong to this resource');
        return [...feedback, { op: 'answer', requestId: event.request!.id, value: await executeNative(event, tool) as JsonValue }];
      }
      if (!prepared) {
        lease = await ctx.get('agentPresets')?.acquireScope(); sourceScope = lease?.key; prepared = true;
      }
      const changes: Contribution[] = [...feedback];
      if (event.type === 'run/initialize' && !host.restoring && !(event.data as { restoring?: boolean }).restoring) {
        if (source.seed) changes.push({ op: 'append', key: 'history', value: { records: source.seed } });
        if (source.messages?.length) changes.push({ op: 'append', key: 'input', value: { messages: source.messages } });
      }
      if (source.instructions) changes.push({ op: 'put', key: 'description', value: { kind: 'instruction', role: 'user', text: source.instructions } });
      if (host.agent() && options.ownsPrompt) changes.push(...await host.describe(event, options.ownsPrompt));
      const definitions = [...(source.tools ?? []), ...captureNativeTools(ctx, source.toolNames ?? [], sourceScope)];
      tools = new Map(definitions.map(tool => [tool.name, tool])); bindNativeDefinitions(connector, tools);
      for (const tool of definitions) changes.push({ op: 'put', key: tool.name, value: { kind: 'capability', name: tool.name,
        description: tool.description, parameters: tool.parameters, output: tool.output.schema } });
      const requested = new Set(source.skillNames ?? []);
      const native = requested.size ? await ctx.skills.list({ cwd: host.cwd, scope: sourceScope, signal: event.signal }) : [];
      skills = new Map([...native.filter(skill => requested.has(skill.name)), ...(source.skills ?? [])].map(skill => [skill.name, skill]));
      if (skills.size) {
        changes.push({ op: 'put', key: 'skill-index', value: { kind: 'instruction', role: 'user',
          text: `Use ${loadName} to read this service's instructions:\n` + [...skills.values()].map(skill => `${skill.name}: ${skill.description}`).join('\n') } });
        changes.push({ op: 'put', key: 'skill-body', value: { kind: 'capability', name: loadName,
          description: `Read instructions owned by ${options.id}.`, parameters: { type: 'object', additionalProperties: false,
            properties: { name: { type: 'string', enum: [...skills.keys()] } }, required: ['name'] },
          output: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] } } });
      }
      const next = new Set(changes.flatMap(item => item.op === 'put' ? [item.key] : []));
      for (const key of current) if (!next.has(key)) changes.push({ op: 'remove', key });
      current = next;
      return changes;
    },
  };
  return connector;
}
