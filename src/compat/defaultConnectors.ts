import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import type { ScopeKey } from '@deepseek-ai/dsh-scope';
import type { ConnectorCard } from '../core.ts';
import type { ConnectorContribution, ConnectorProvider } from './registry.ts';
import { ownNativeResource } from './nativeResource.ts';
import path from 'node:path';
import type {} from '@deepseek-ai/dsh-fs';

const baseTools = new Set(['ask_user_question', 'todo_write', 'exit_plan_mode']);
const subagentSupport = new Set(['send_message', 'list_subagent_models']);
export { baseTools, subagentSupport };

/** Native resources remain owned by DSH. Only identifiers/descriptions are advertised. */
export function nativeConnectorProvider(ctx: Context): ConnectorProvider {
  const withScope = async <T>(read: (scope?: ScopeKey) => Promise<T>): Promise<T> => {
    const preset = ctx.get('agentPresets');
    if (!preset) return read();
    const lease = await preset.acquireScope();
    try { return await read(lease.key); } finally { await lease[Symbol.asyncDispose](); }
  };
  const toolCards = (scope?: ScopeKey): Map<string, { card: ConnectorCard; names: string[] }> => {
    const groups = new Map<string, { card: ConnectorCard; names: string[] }>();
    for (const tool of ctx.tools.definitions(scope)) {
      if (tool.name === 'skill' || baseTools.has(tool.name) || subagentSupport.has(tool.name)) continue;
      const mcp = /^mcp__(.*?)__/.exec(tool.name);
      const isSubagent = /^(subagent(?:_|$)|delegate)/.test(tool.name);
      const id = mcp ? `mcp:${mcp[1]}` : isSubagent ? `subagent:${tool.name}` : 'execution:default';
      const kind = mcp ? 'mcp' : isSubagent ? 'subagent' : 'execution';
      let group = groups.get(id);
      if (!group) {
        group = { names: [], card: { id, kind, label: mcp ? mcp[1]! : isSubagent ? tool.name : '执行环境与基础工具',
          description: mcp ? '使用已配置 MCP 服务的工具' : isSubagent ? tool.description : '沿用宿主已配置的文件、命令和其他原生工具' } };
        groups.set(id, group);
      }
      group.names.push(tool.name);
    }
    return groups;
  };
  return {
    id: 'dsh-native',
    async list(context) {
      return withScope(async scope => {
      const cards = [...toolCards(scope).values()].map(group => group.card);
      cards.push({ id: 'project:context', kind: 'custom', label: '项目规范与规则', description: '项目说明、规则及其执行反馈' });
      const skills = ctx.get('skills');
      if (skills) for (const skill of await skills.list({ cwd: context.cwd, signal: context.signal, scope })) {
        cards.push({ id: `skill:${skill.name}`, kind: 'skill', label: skill.name, description: skill.description });
      }
      const query = ctx.get('sessionQuery');
      if (query) {
      const sessions = (await query.listSessions(context.signal)).filter(item => item.header.origin !== 'subagent').slice(0, 200);
      const titles = await query.readTitleSnapshots(sessions.map(item => item.header.id), context.signal);
      for (const [index, { header }] of sessions.entries()) {
        const agent = ctx.agents.get(header.id);
        const title = titles[index];
        cards.push({ id: `session:${header.id}`, kind: 'session', label: title?.status === 'fulfilled' && title.value.title ? title.value.title.title : `会话 ${String(header.id).slice(-8)}`,
          description: `读取历史，在新的运行中使用 · ${new Date(header.createdAt).toLocaleString()}`,
          ...(agent && agent.status !== 'idle' ? { disabledReason: '会话正在运行，请结束后再装配历史' } : {}) });
      }
      }
      return cards;
      });
    },
    async prepare(binding, context): Promise<ConnectorContribution> {
      return withScope(async scope => {
      if (binding.id === 'project:context') return ownNativeResource({}, { ownsPrompt: name => name.startsWith('joygen:') || name.startsWith('agent-instructions') });
      if (binding.id.startsWith('skill:')) {
        const name = binding.id.slice(6);
        const skill = (await ctx.skills.list({ cwd: context.cwd, signal: context.signal, scope })).find(item => item.name === name);
        if (!skill) throw new Error(`Skill unavailable: ${name}`);
        if (!skill.invocation.modelInvocable) {
          if (!skill.invocation.userInvocable) throw new Error('This skill cannot be invoked');
          const definition = await ctx.skills.get(name, { cwd: context.cwd, signal: context.signal, scope });
          if (!definition) throw new Error('Selected skill is no longer available');
          return { instructions: renderSkillContent(definition) };
        }
        return { skillNames: [name] };
      }
      if (binding.id.startsWith('session:')) {
        const id = SessionId(binding.id.slice(8));
        const agent = ctx.agents.get(id);
        if (agent && agent.status !== 'idle') throw new Error('Cannot assemble an active session');
        const query = ctx.get('sessionQuery');
        if (!query) throw new Error('Session history service is unavailable');
        const snapshot = await query.readSession(id);
        // Native events, including message/tool relationships, are preserved. Never join arbitrary logs.
        const events = structuredClone(snapshot.events) as SessionEvent[];
        const last = events.at(-1);
        if (last && events.some(event => event.type === 'turn/start') && [...events].reverse().find(event => event.type === 'turn/start' || event.type === 'turn/end')?.type === 'turn/start') throw new Error('Session has an unfinished turn; finish or recover it before composing');
        return ownNativeResource({ seed: events, parentSessionId: String(id) }, { session: true });
      }
      const group = toolCards(scope).get(binding.id);
      if (!group) throw new Error(`Resource unavailable: ${binding.id}`);
      const visited = new Set([context.cwd]);
      return ownNativeResource({ toolNames: group.names }, { ownsPrompt: name =>
        group.names.some(tool => name === `tool:${tool}`)
        || (group.card.kind === 'mcp' && name === binding.id)
        || (group.card.kind === 'execution' && (name.startsWith('working-directory:') || name === 'sandbox:policy')),
        async handle(event) {
          if (group.card.kind !== 'execution') return;
          if (event.type === 'tools/execute') {
            const file = (event.data as { arguments?: { file_path?: unknown } }).arguments?.file_path;
            if (typeof file === 'string') {
              const directory = path.dirname(path.resolve(context.cwd, file));
              const relative = path.relative(context.cwd, directory);
              if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) visited.add(directory);
            }
          }
          const fileSystem = ctx.get('fs');
          if (event.type !== 'agent/prepare-step' || !fileSystem) return;
          const { loadBaselineInstructions } = await import('@deepseek-ai/dsh-agent-instructions');
          const sections = await Promise.all([...visited].map(cwd => loadBaselineInstructions({ cwd, projectRoot: context.cwd,
            maxBytes: 65536, instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md', 'JOYGEN.md'], signal: event.signal }, fileSystem)));
          return [{ op: 'put', key: 'workspace-instructions', value: { kind: 'instruction', role: 'user', text: [...new Set(sections.flatMap(section => section ? [section.text] : []))].join('\n\n') } }];
        },
      });
      });
    },
  };
}

/** Built-in examples of user-authored context: no executable text, no workspace files. */
export const inlineConnectorProvider: ConnectorProvider = {
  id: 'inline',
  async list() {
    return [
      { id: 'inline:instructions', kind: 'instructions', label: '自定义上下文', description: '为本轮添加背景、要求或参考资料', fields: [{ key: 'text', label: '上下文内容', multiline: true, required: true }] },
      { id: 'inline:skill', kind: 'skill', label: '虚拟技能', description: '先展示描述，需要时加载正文，无需技能文件', fields: [
        { key: 'name', label: '技能标识（小写字母与短横线）', required: true }, { key: 'description', label: '适用描述', required: true }, { key: 'content', label: '技能正文', multiline: true, required: true },
      ] },
    ];
  },
  async prepare(binding) {
    if (binding.id === 'inline:instructions') return { instructions: binding.config!.text! };
    if (binding.id === 'inline:skill') {
      const { name, description, content } = binding.config!;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name!)) throw new Error('Invalid skill name');
      return { skills: [{ name: name!, description: description!, content: content!, source: 'runtime' }] };
    }
    throw new Error('Unknown inline connector');
  },
};
