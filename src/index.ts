import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { SessionId, SessionLogOffset, pluginRecordOf, appendPluginRecord } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-workspace';
import { ConnectorRegistry } from './registry.ts';
import type { ConnectorProvider } from './registry.ts';
import { adaptLegacyProvider, materializeLegacy } from './compat/adapter.ts';
import { nativeConnectorProvider, inlineConnectorProvider } from './compat/defaultConnectors.ts';
import { installComposition } from './compat/assembly.ts';
import type { RunSelection } from './core.ts';
import { parseSelection } from './core.ts';
import type { SkillRegistration } from '@deepseek-ai/dsh-skill';
import { createComposedRun, isComposedAgent } from './composedRun.ts';
import { standardSelection } from './compat/standardSelection.ts';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';

export { ConnectorRegistry };
export type * from './registry.ts';
export type * from './core.ts';
export { createComposedRun, capabilityName } from './composedRun.ts';
export type { ComposedRunOptions, SendReceipt } from './composedRun.ts';
export type { ContextConnector, ConnectorEvent, Contribution, CurrentContribution, RuntimeEventData, ConnectorRequest } from './composition.ts';
export const name = 'context-connectors';
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'skills'];
export interface Config { cwd?: string; selection?: RunSelection; sessionId?: string; virtualSkills?: SkillRegistration[]; historyContext?: string; }
export const Config = Schema.object({ cwd: Schema.string().default(''), selection: Schema.any(), sessionId: Schema.string(), virtualSkills: Schema.array(Schema.any()).default([]), historyContext: Schema.string() });

declare module '@deepseek-ai/cordis' {
  interface Context { contextConnectors: ConnectorRegistry; }
}
export function registerConnector(ctx: Context, provider: ConnectorProvider): void {
  ctx.effect(() => ctx.contextConnectors.registerProvider(provider), `context-connector:${provider.id}`);
}

/** Host plugin: portable composition service, plus optional authenticated Web transport. */
export function apply(ctx: Context, config: Config = {}): void {
  const registry = new ConnectorRegistry();
  ctx.provide('contextConnectors', registry);
  registerConnector(ctx, adaptLegacyProvider(ctx, nativeConnectorProvider(ctx)));
  registerConnector(ctx, adaptLegacyProvider(ctx, inlineConnectorProvider));
  for (const skill of config.virtualSkills ?? []) ctx.skills.register(skill);
  const handles = new Map<string, AgentHandle>();
  const eventRuns = new Map<string, Awaited<ReturnType<typeof createComposedRun>>>();
  const eventMode = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')]);
  ctx.inject(['tools', 'systemPrompt', 'ptcRuntime'], scope => { scope.provide('contextPtcExecutor', new PtcExecutor(scope)); });
  registerConnector(ctx, {
    id: 'interaction',
    async list() { return [{ id: 'interaction:ptc', kind: 'custom', label: '程序化调用（PTC）', description: '用程序组合本轮已选能力',
      ...(!eventMode || !ctx.get('contextPtcExecutor') ? { disabledReason: '需要事件运行模式和原生 PTC runtime' } : {}) }]; },
    async connect(binding) { return { id: binding.id, events: ['run/initialize'], async handle() {
      return [{ op: 'put' as const, key: 'execution', value: { kind: 'projection' as const, service: 'contextPtcExecutor' } }];
    } }; },
  });
  const preparedAgents = new WeakSet<Agent>();
  const claims = new Map<string, { fingerprint: string; result: Promise<{ sessionId: string }> }>();
  const location = (workspaceId?: unknown) => {
    if (workspaceId !== undefined && typeof workspaceId !== 'string') throw new Error('Invalid workspace identity');
    const workspaces = ctx.get('workspaceRegistry')?.list() ?? [];
    const options = workspaces.map(workspace => ({ id: String(workspace.id), label: workspace.title }));
    if (config.cwd || !workspaces.length) options.unshift({ id: '__default__', label: config.cwd ? '配置的运行目录' : '当前启动目录' });
    const id = workspaceId || (config.cwd || !workspaces.length ? '__default__' : String(workspaces[0]!.id));
    if (id === '__default__') {
      if (!options.some(item => item.id === id)) throw new Error('Default working directory is unavailable');
      return { id, cwd: path.resolve(config.cwd || process.cwd()), options };
    }
    const selected = workspaces.find(workspace => workspace.id === id);
    if (!selected) throw new Error('Workspace is no longer available');
    return { id, cwd: selected.path, options };
  };

  // JoyGen supplies a selection to its existing one-process-per-turn bridge. Native Web
  // continuations restore the last persisted selection before the first request.
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (preparedAgents.has(agent) || isComposedAgent(agent) || agent.session.header.origin === 'subagent') return;
    const query = ctx.get('sessionQuery');
    const history = query ? (await query.readSession(agent.id)).events : [];
    const saved = history.reverse().map(pluginRecordOf).find(record => record?.type === 'plugin:context-connectors/selection');
    if (saved && (saved.data as { protocol?: string }).protocol === 'events' && !eventMode) throw new Error('This composition requires the context runtime bootstrap');
    const selection = config.selection && (!config.sessionId || config.sessionId === agent.id) ? config.selection
      : saved ? parseSelection((saved.data as { selection?: unknown }).selection) : undefined;
    if (!selection) return;
    const prepared = await registry.prepare(selection, { cwd: agent.session.header.cwd || location().cwd, signal });
    if (eventMode) {
      const sources = await standardSelection(ctx, prepared, agent.session.header.cwd || location().cwd, true, config.historyContext);
      try {
        await sources.installNativeCompatibility(agent.ctx, agent);
        const run = await createComposedRun(ctx, { agent, connectors: sources.connectors, model: agent.options, signal });
        eventRuns.set(String(agent.id), run);
        appendPluginRecord(agent.session, 'plugin:context-connectors/selection', { selection, labels: prepared.cards.map(card => card.label), protocol: 'events' });
        agent.ctx.effect(() => () => sources.dispose());
        preparedAgents.add(agent);
        return;
      } catch (error) { await sources.dispose(); throw error; }
    }
    const legacy = await materializeLegacy(prepared);
    try { await installComposition(agent.ctx, agent, legacy); preparedAgents.add(agent); }
    catch (error) { await legacy.dispose(); throw error; }
  });

  const start = async (payload: Record<string, unknown>, signal: AbortSignal) => {
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 131072) throw new Error('Enter a prompt for this run');
    const working = location(payload.workspaceId);
    const prepared = await registry.prepare(payload.selection, { cwd: working.cwd, signal });
    if (eventMode) {
      const sources = await standardSelection(ctx, prepared, working.cwd, false, config.historyContext);
      try {
        const presets = ctx.get('agentPresets');
        const preset = presets ? await presets.resolve() : undefined;
        if (preset?.broken) throw new Error(preset.broken);
        const run = await createComposedRun(ctx, { connectors: sources.connectors, cwd: working.cwd,
          model: ctx.get('agentDefaultModel')?.currentSelection() ?? {}, signal,
          setup: async (scope, agent) => {
            if (presets) await presets.mount(scope, preset!.id);
            await sources.installNativeCompatibility(scope, agent);
            scope.effect(() => () => sources.dispose());
          },
        });
        eventRuns.set(String(run.agent.id), run);
        appendPluginRecord(run.agent.session, 'plugin:context-connectors/selection', { selection: prepared.selection, labels: prepared.cards.map(card => card.label), protocol: 'events' });
        await ctx.sessions.flush(run.agent.session);
        void run.send('chat/submit', payload.prompt, 'prompt').then(receipt => receipt.completed).catch(() => { /* native failure events and persisted terminal carry the outcome */ });
        return { sessionId: String(run.agent.id) };
      } catch (error) { await sources.dispose(); throw error; }
    }
    const legacy = await materializeLegacy(prepared);
    const history = legacy.contributions.find(item => item.seed !== undefined);
    let handle: AgentHandle | undefined;
    try {
      const id = SessionId(randomUUID());
      const presets = ctx.get('agentPresets');
      const preset = presets ? await presets.resolve() : undefined;
      if (preset?.broken) throw new Error(preset.broken);
      handle = await ctx.agents.create({ sessionId: id, signal,
        meta: { cwd: working.cwd, ...(preset ? { agentPreset: preset.id } : {}), ...(history ? { isSeeded: true, parentSession: SessionId(history.parentSessionId!) } : {}) },
        ...(history ? { seed: history.seed, inheritedEventCount: SessionLogOffset(history.seed!.length) } : {}),
        agentOptions: ctx.get('agentDefaultModel')?.currentSelection(),
        setup: async (scope, agent) => {
          if (presets) await presets.mount(scope, preset!.id);
          await installComposition(scope, agent, legacy);
          preparedAgents.add(agent);
        },
      });
      handles.set(id, handle);
      await ctx.sessions.flush(handle.agent.session);
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: payload.prompt }], source: { kind: 'user' } }));
      return { sessionId: String(id) };
    } catch (error) {
      await handle?.dispose();
      await legacy.dispose();
      throw error;
    }
  };
  ctx.effect(() => async () => {
    await Promise.allSettled([...claims.values()].map(claim => claim.result));
    await Promise.allSettled([...handles.values()].map(handle => handle.dispose()));
    await Promise.allSettled([...eventRuns.values()].map(run => run.dispose()));
    eventRuns.clear();
    handles.clear();
  });
  // Exact Fetch routes use DSH Connection's existing owner authentication and work
  // through the Web and desktop /api carriers. No unprotected Express side server.
  ctx.inject(['connection'], connectionCtx => {
    connectionCtx.connection.fetch.register({ path: '/api/context-connectors', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let rpcId: unknown;
        try {
          const message = await request.json() as Record<string, unknown>;
          rpcId = message.rpcId;
          if (typeof rpcId !== 'string' || message.type !== 'client-request' || message.method !== 'context-connectors') throw new Error('Invalid request identity');
          const payload = message.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object') throw new Error('Invalid connector request');
          let value: unknown;
          if (payload.action === 'catalog') {
            const working = location(payload.workspaceId);
            value = { cards: await registry.catalog({ cwd: working.cwd, signal: request.signal }), description: working.cwd, workspaces: working.options, workspaceId: working.id, protocol: eventMode ? 'events' : 'legacy' };
          }
          else if (payload.action === 'start') {
            if (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(payload.requestId)) throw new Error('Invalid run request identity');
            const fingerprint = JSON.stringify({ prompt: payload.prompt, selection: parseSelection(payload.selection), workspaceId: location(payload.workspaceId).id });
            let claim = claims.get(payload.requestId);
            if (claim && claim.fingerprint !== fingerprint) throw new Error('Run request identity was reused with different inputs');
            if (!claim) { claim = { fingerprint, result: start(payload, request.signal) }; claims.set(payload.requestId, claim); }
            value = await claim.result;
          } else throw new Error('Unknown connector action');
          return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
        } catch (error) {
          return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'context-connectors/invalid', message: error instanceof Error ? error.message : 'Connector operation failed', details: {} } } });
        }
      },
    });
  });
}
