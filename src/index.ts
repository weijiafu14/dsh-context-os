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
import {
  nativeConnectorProvider,
  inlineConnectorProvider,
  runtimeClockConnectorProvider,
} from './compat/defaultConnectors.ts';
import { installComposition } from './compat/assembly.ts';
import type {
  ActiveComposedSessionInfo,
  CacheRefreshRecord,
  RunSelection,
} from './core.ts';
import { parseSelection } from './core.ts';
import type { SkillRegistration } from '@deepseek-ai/dsh-skill';
import { cacheRefreshesOf, createComposedRun, isComposedAgent } from './composedRun.ts';
import { standardSelection } from './compat/standardSelection.ts';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';
import { RunManager } from './runs.ts';

export { ConnectorRegistry };
export type * from './registry.ts';
export type * from './core.ts';
export { createComposedRun, capabilityName, cacheRefreshesOf } from './composedRun.ts';
export type { ComposedRunOptions, SendReceipt } from './composedRun.ts';
export { RunManager } from './runs.ts';
export type { RunControl, RunRequest, RunAuthority } from './runs.ts';
export type { ContextConnector, ConnectorEvent, Contribution, CurrentContribution, RuntimeEventData, ConnectorRequest } from './composition.ts';
export const name = 'context-connectors';
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'skills'];
export interface Config {
  cwd?: string;
  selection?: RunSelection;
  sessionId?: string;
  virtualSkills?: SkillRegistration[];
  historyContext?: string;
  defaultCompose?: boolean;
}
export const Config = Schema.object({
  cwd: Schema.string().default(''),
  selection: Schema.any(),
  sessionId: Schema.string(),
  virtualSkills: Schema.array(Schema.any()).default([]),
  historyContext: Schema.string(),
  defaultCompose: Schema.boolean().default(true),
});

declare module '@deepseek-ai/cordis' {
  interface Context { contextConnectors: ConnectorRegistry; contextOS: RunManager; }
}
export function registerConnector(ctx: Context, provider: ConnectorProvider): void {
  ctx.effect(() => ctx.contextConnectors.registerProvider(provider), `context-connector:${provider.id}`);
}

/** Host plugin: portable composition service, plus optional authenticated Web transport. */
export function apply(ctx: Context, config: Config = {}): void {
  const registry = new ConnectorRegistry();
  ctx.provide('contextConnectors', registry);
  const runs = new RunManager(ctx, registry);
  ctx.provide('contextOS', runs);
  ctx.effect(() => () => runs.dispose());
  registerConnector(ctx, adaptLegacyProvider(ctx, nativeConnectorProvider(ctx)));
  registerConnector(ctx, runtimeClockConnectorProvider);
  registerConnector(ctx, adaptLegacyProvider(ctx, inlineConnectorProvider));
  for (const skill of config.virtualSkills ?? []) ctx.skills.register(skill);
  const handles = new Map<string, AgentHandle>();
  const eventRuns = new Map<string, Awaited<ReturnType<typeof createComposedRun>>>();
  const eventMode = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')]);
  ctx.inject(['tools', 'systemPrompt', 'ptcRuntime'], scope => { scope.provide('contextPtcExecutor', new PtcExecutor(scope)); });
  registerConnector(ctx, {
    id: 'interaction',
    async list() {
      return [{
        id: 'interaction:ptc',
        kind: 'custom',
        cacheAffinity: 'static',
        label: '程序化调用（PTC）',
        description: '用程序组合本轮已选能力',
        ...(!eventMode || !ctx.get('contextPtcExecutor') ? { disabledReason: '需要事件运行模式和原生 PTC runtime' } : {}),
      }];
    },
    async connect(binding) {
      return {
        id: binding.id,
        events: ['run/initialize'],
        async handle() {
          return [{ op: 'put' as const, key: 'execution', value: { kind: 'projection' as const, service: 'contextPtcExecutor' } }];
        },
      };
    },
  });
  const preparedAgents = new WeakSet<Agent>();
  const claims = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
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

  const buildDefaultSelection = async (cwd: string, signal?: AbortSignal, agentPreset?: string): Promise<RunSelection> => {
    const cards = await registry.catalog({ cwd, signal });
    const bindings = cards
      .filter(card => {
        if (card.disabledReason) return false;
        if (card.fields?.some(f => f.required)) return false;
        if (card.kind === 'session' || card.id.startsWith('inline:')) return false;
        if (card.id === 'interaction:ptc') return agentPreset === 'ptc';
        return (
          card.id === 'execution:default' ||
          card.id === 'project:context' ||
          card.id === 'runtime:clock' ||
          card.kind === 'mcp' ||
          card.kind === 'subagent' ||
          card.kind === 'skill'
        );
      })
      .map(card => ({ id: card.id }));
    return { version: 1, bindings };
  };

  // HostApp supplies a selection to its existing bridge. Native Web continuations restore
  // persisted selections, and standard new sessions default to the unified Context OS selection.
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (preparedAgents.has(agent) || isComposedAgent(agent) || agent.session.header.origin === 'subagent') return;
    const query = ctx.get('sessionQuery');
    const history = query ? [...(await query.readSession(agent.id)).events] : [];
    const saved = [...history].reverse().map(pluginRecordOf).find(record => record?.type === 'plugin:context-connectors/selection');
    if (saved && (saved.data as { protocol?: string }).protocol === 'events' && !eventMode) {
      throw new Error('This composition requires the context runtime bootstrap');
    }
    const agentCwd = agent.session.header.cwd || location().cwd;
    const presetId = (agent.session.header as { agentPreset?: string }).agentPreset;
    let selection =
      config.selection && (!config.sessionId || config.sessionId === agent.id)
        ? config.selection
        : saved
          ? parseSelection((saved.data as { selection?: unknown }).selection)
          : undefined;
    if (!selection && eventMode && config.defaultCompose !== false && !history.some(e => e.type === 'turn/start')) {
      selection = await buildDefaultSelection(agentCwd, signal, presetId);
    }
    if (!selection) return;
    const prepared = await registry.prepare(selection, { cwd: agentCwd, signal });
    if (eventMode) {
      const sources = await standardSelection(ctx, prepared, agentCwd, true, config.historyContext);
      try {
        await sources.installNativeCompatibility(agent.ctx, agent);
        const run = await createComposedRun(ctx, { agent, connectors: sources.connectors, model: agent.options, signal });
        eventRuns.set(String(agent.id), run);
        appendPluginRecord(agent.session, 'plugin:context-connectors/selection', {
          selection,
          labels: prepared.cards.map(card => card.label),
          protocol: 'events',
        });
        agent.ctx.effect(() => () => {
          eventRuns.delete(String(agent.id));
          void sources.dispose();
        });
        preparedAgents.add(agent);
        return;
      } catch (error) { await sources.dispose(); throw error; }
    }
    const legacy = await materializeLegacy(prepared);
    try { await installComposition(agent.ctx, agent, legacy); preparedAgents.add(agent); }
    catch (error) { await legacy.dispose(); throw error; }
  });

  const start = async (payload: Record<string, unknown>, signal: AbortSignal) => {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    const allowIdleSeed = payload.allowEmptyPrompt === true;
    if ((!prompt && !allowIdleSeed) || prompt.length > 131072) throw new Error('Enter a prompt for this run');
    const working = location(payload.workspaceId);
    const prepared = await registry.prepare(payload.selection, { cwd: working.cwd, signal });
    if (eventMode) {
      const sources = await standardSelection(ctx, prepared, working.cwd, false, config.historyContext);
      try {
        const presets = ctx.get('agentPresets');
        const preset = presets ? await presets.resolve() : undefined;
        if (preset?.broken) throw new Error(preset.broken);
        const run = await createComposedRun(ctx, {
          connectors: sources.connectors,
          cwd: working.cwd,
          model: ctx.get('agentDefaultModel')?.currentSelection() ?? {},
          signal,
          setup: async (scope, agent) => {
            if (presets) await presets.mount(scope, preset!.id);
            await sources.installNativeCompatibility(scope, agent);
            scope.effect(() => () => {
              eventRuns.delete(String(agent.id));
              void sources.dispose();
            });
          },
        });
        eventRuns.set(String(run.agent.id), run);
        preparedAgents.add(run.agent);
        appendPluginRecord(run.agent.session, 'plugin:context-connectors/selection', {
          selection: prepared.selection,
          labels: prepared.cards.map(card => card.label),
          protocol: 'events',
        });
        await ctx.sessions.flush(run.agent.session);
        if (prompt) {
          void run.send('chat/submit', prompt, 'prompt').then(receipt => receipt.completed).catch(() => {});
        }
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
      handle = await ctx.agents.create({
        sessionId: id,
        signal,
        meta: {
          cwd: working.cwd,
          ...(preset ? { agentPreset: preset.id } : {}),
          ...(history ? { isSeeded: true, parentSession: SessionId(history.parentSessionId!) } : {}),
        },
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
      if (prompt) {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      }
      return { sessionId: String(id) };
    } catch (error) {
      await handle?.dispose();
      await legacy.dispose();
      throw error;
    }
  };

  const reconfigure = async (payload: Record<string, unknown>, signal: AbortSignal) => {
    const targetSessionId = typeof payload.targetSessionId === 'string' ? payload.targetSessionId.trim() : '';
    if (!targetSessionId) throw new Error('Target session identity is required');
    const mode = payload.mode === 'in-place' ? 'in-place' : 'fork';
    const rawSelection = parseSelection(payload.selection);
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';

    if (mode === 'fork') {
      const bindingsWithoutSession = rawSelection.bindings.filter(b => !b.id.startsWith('session:'));
      const forkSelection: RunSelection = {
        version: 1,
        bindings: [{ id: `session:${targetSessionId}` }, ...bindingsWithoutSession],
      };
      const started = await start(
        {
          selection: forkSelection,
          prompt,
          allowEmptyPrompt: true,
          workspaceId: payload.workspaceId,
        },
        signal,
      );
      return { sessionId: started.sessionId, mode: 'fork' as const };
    }

    if (!eventMode) throw new Error('In-place reconfiguration requires the event runtime bootstrap');
    const run = eventRuns.get(targetSessionId);
    if (!run) throw new Error('会话尚未激活或正在离线状态，建议选择「从此处分叉新会话生效」');
    if (run.agent.status !== 'idle') throw new Error('当前会话正在执行中，请等待本轮结束后再原地刷新');

    const cleanSelection: RunSelection = {
      version: 1,
      bindings: rawSelection.bindings.filter(b => !b.id.startsWith('session:')),
    };
    const agentCwd = run.agent.session.header.cwd || location(payload.workspaceId).cwd;
    const prepared = await registry.prepare(cleanSelection, { cwd: agentCwd, signal });
    const sources = await standardSelection(ctx, prepared, agentCwd, true, config.historyContext);
    try {
      const { changedOwners } = await run.reconfigure(sources.connectors, signal);
      const turnCount = run.agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length;
      appendPluginRecord(run.agent.session, 'plugin:context-connectors/selection', {
        selection: cleanSelection,
        labels: prepared.cards.map(c => c.label),
        protocol: 'events',
      });
      if (turnCount > 0 && changedOwners.length > 0) {
        const refresh: CacheRefreshRecord = {
          turn: turnCount + 1,
          step: 1,
          owners: changedOwners,
          reasons: ['context-replacement'],
        };
        appendPluginRecord(run.agent.session, 'plugin:context-connectors/cache-refresh', refresh);
      }
      await ctx.sessions.flush(run.agent.session);
      if (prompt) {
        void run.send('chat/submit', prompt, 'prompt').then(r => r.completed).catch(() => {});
      }
      return { sessionId: targetSessionId, mode: 'in-place' as const, refreshedOwners: changedOwners };
    } catch (error) {
      await sources.dispose();
      throw error;
    }
  };

  const listSessionSummaries = async (signal: AbortSignal): Promise<ActiveComposedSessionInfo[]> => {
    const query = ctx.get('sessionQuery');
    if (!query) return [];
    const listed = (await query.listSessions(signal)).filter(item => item.header.origin !== 'subagent').slice(0, 25);
    const titles = await query.readTitleSnapshots(listed.map(item => item.header.id), signal);
    const summaries: ActiveComposedSessionInfo[] = [];
    for (const [idx, { header }] of listed.entries()) {
      const sid = String(header.id);
      const titleEntry = titles[idx];
      const title =
        titleEntry?.status === 'fulfilled' && titleEntry.value.title?.title
          ? titleEntry.value.title.title
          : `会话 ${sid.slice(-8)}`;
      const liveAgent = ctx.agents.get(header.id);
      let turnCount = 0;
      let savedSelection: RunSelection | undefined;
      let lastRefresh: CacheRefreshRecord | undefined;
      try {
        const snap = await query.readSession(header.id);
        turnCount = snap.events.filter(e => e.type === 'turn/start').length;
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const rec = pluginRecordOf(snap.events[i]!);
          if (!rec) continue;
          if (!savedSelection && rec.type === 'plugin:context-connectors/selection') {
            try { savedSelection = parseSelection((rec.data as { selection?: unknown }).selection); } catch {}
          }
          if (!lastRefresh && rec.type === 'plugin:context-connectors/cache-refresh') {
            lastRefresh = rec.data as CacheRefreshRecord;
          }
          if (savedSelection && lastRefresh) break;
        }
      } catch {
        /* Skip unreadable session logs */
      }
      if (liveAgent) {
        const memRefreshes = cacheRefreshesOf(liveAgent);
        if (memRefreshes.length > 0) lastRefresh = memRefreshes.at(-1);
      }
      summaries.push({
        sessionId: sid,
        title,
        turnCount,
        ...(liveAgent && liveAgent.status !== 'idle' ? { busy: true } : {}),
        ...(savedSelection ? { selection: savedSelection } : {}),
        ...(lastRefresh ? { lastCacheRefresh: lastRefresh } : {}),
      });
    }
    return summaries;
  };

  ctx.effect(() => async () => {
    await Promise.allSettled([...claims.values()].map(claim => claim.result));
    await Promise.allSettled([...handles.values()].map(handle => handle.dispose()));
    await Promise.allSettled([...eventRuns.values()].map(run => run.dispose()));
    eventRuns.clear();
    handles.clear();
  });

  ctx.inject(['connection'], connectionCtx => {
    connectionCtx.connection.fetch.register({
      path: '/api/context-connectors',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let rpcId: unknown;
        try {
          const message = (await request.json()) as Record<string, unknown>;
          rpcId = message.rpcId;
          if (typeof rpcId !== 'string' || message.type !== 'client-request' || message.method !== 'context-connectors') {
            throw new Error('Invalid request identity');
          }
          const payload = message.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object') throw new Error('Invalid connector request');
          let value: unknown;
          if (payload.action === 'catalog') {
            const working = location(payload.workspaceId);
            const [cards, sessions] = await Promise.all([
              registry.catalog({ cwd: working.cwd, signal: request.signal }),
              listSessionSummaries(request.signal),
            ]);
            value = {
              cards,
              description: working.cwd,
              workspaces: working.options,
              workspaceId: working.id,
              protocol: eventMode ? 'events' : 'legacy',
              sessions,
            };
          } else if (payload.action === 'start') {
            if (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(payload.requestId)) {
              throw new Error('Invalid run request identity');
            }
            const fingerprint = JSON.stringify({
              action: 'start',
              prompt: payload.prompt,
              selection: parseSelection(payload.selection),
              workspaceId: location(payload.workspaceId).id,
            });
            let claim = claims.get(payload.requestId);
            if (claim && claim.fingerprint !== fingerprint) throw new Error('Run request identity was reused with different inputs');
            if (!claim) { claim = { fingerprint, result: start(payload, request.signal) }; claims.set(payload.requestId, claim); }
            value = await claim.result;
          } else if (payload.action === 'reconfigure') {
            if (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(payload.requestId)) {
              throw new Error('Invalid run request identity');
            }
            const fingerprint = JSON.stringify({
              action: 'reconfigure',
              targetSessionId: payload.targetSessionId,
              mode: payload.mode,
              prompt: payload.prompt ?? '',
              selection: parseSelection(payload.selection),
              workspaceId: location(payload.workspaceId).id,
            });
            let claim = claims.get(payload.requestId);
            if (claim && claim.fingerprint !== fingerprint) throw new Error('Run request identity was reused with different inputs');
            if (!claim) { claim = { fingerprint, result: reconfigure(payload, request.signal) }; claims.set(payload.requestId, claim); }
            value = await claim.result;
          } else {
            throw new Error('Unknown connector action');
          }
          return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
        } catch (error) {
          return Response.json({
            type: 'server-response',
            rpcId,
            result: {
              ok: false,
              error: {
                code: 'context-connectors/invalid',
                message: error instanceof Error ? error.message : 'Connector operation failed',
                details: {},
              },
            },
          });
        }
      },
    });
  });
}
