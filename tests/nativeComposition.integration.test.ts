import test from 'node:test';
import assert from 'node:assert/strict';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { nativeHarness, user } from './fixtures/nativeHarness.ts';
import { candidateLoop } from './fixtures/developerLoop.mjs';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import Sandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { Scoped } from '@deepseek-ai/dsh-scope';

// The installed types remain unchanged; declare the proposed native hook only in the probe.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/prepare-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: readonly UserMessage[]; turn: number; step: number; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }): void | Promise<void>;
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'connector-native-probe': { kind: 'connector-native-probe' }; }
}
const developer = (text: string) => createDeveloperMessage({ content: [{ type: 'text', text }], source: { kind: 'connector-native-probe' } });
const content = (value: unknown) => JSON.stringify(value);

test('native preparation order: pre-step is too late to change the current step capability snapshot', async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, [{ text: 'first' }, { text: 'second' }]);
  try {
    const agent = await ctx.agentLoop.create(SessionId('admission-order'), { provider: 'fixture', model: 'fixture' });
    let installed = false;
    await agent.ctx.inject(['tools'], scope => {
      scope.on('agent/pre-step', async (_event, next) => {
        if (!installed) {
          installed = true;
          scope.tools.register(defineTool({ name: 'late_capability', description: 'Late', parameters: {},
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute() { return 'value'; },
          }));
        }
        return next();
      });
    });
    agent.followup(user('first')); await agent.whenIdle();
    agent.followup(user('second')); await agent.whenIdle();
    assert.equal(model.requests.length, 2);
    assert.ok(!model.requests[0].tools?.some(tool => tool.name === 'late_capability'));
    assert.ok(model.requests[1].tools?.some(tool => tool.name === 'late_capability'));
  } finally { await ctx.fiber.dispose(); }
});

test('one proposed preparation boundary assembles instructions and capabilities before the same model request', async () => {
  const candidate = await candidateLoop();
  const { ctx, model } = await nativeHarness(candidate.loop, [{ text: 'assembled' }], candidate.llm);
  try {
    const agent = await ctx.agentLoop.create(SessionId('prepare-together'), { provider: 'fixture', model: 'fixture' });
    await agent.ctx.inject(['tools', 'systemPrompt'], scope => {
      scope.on('agent/prepare-step', async event => {
        assert.ok(Object.isFrozen(event.messages));
        await Promise.resolve();
        event.signal.throwIfAborted();
        scope.systemPrompt.section({ name: 'prepared/rules', order: 20, text: 'PREPARED_SYSTEM', interpolate: false });
        scope.tools.register(defineTool({ name: 'prepared_capability', description: 'Prepared', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { return 'prepared'; },
        }));
      });
    });
    agent.ctx.on('agent/pre-step', async (_event, next) => {
      const decision = await next();
      return decision.kind === 'reject' ? decision : { ...decision, developerMessages: [developer('PREPARED_DEVELOPER')] };
    });
    agent.followup(user('go')); await agent.whenIdle();
    assert.equal(model.requests.length, 1);
    assert.ok(model.requests[0].tools?.some(tool => tool.name === 'prepared_capability'));
    assert.match(content(model.requests[0].messages.filter(message => message.role === 'system')), /PREPARED_SYSTEM/);
    assert.match(content(model.requests[0].messages.filter(message => message.role === 'developer')), /PREPARED_DEVELOPER/);
  } finally { await ctx.fiber.dispose(); await candidate.dispose(); }
});

test('native system sections compose into one prompt and an owned update preserves other sections', async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, [{ text: 'first answer' }, { text: 'second answer' }]);
  try {
    const agent = await ctx.agentLoop.create(SessionId('instructions'), { provider: 'fixture', model: 'fixture' });
    let a = 'RULE_A_V1';
    await agent.ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt.section({ name: 'connector-a/rules', order: 20, text: () => a, interpolate: false });
      scope.systemPrompt.section({ name: 'connector-b/rules', order: 30, text: 'RULE_B', interpolate: false });
    });
    agent.followup(user('first')); await agent.whenIdle();
    a = 'RULE_A_V2';
    agent.followup(user('second')); await agent.whenIdle();
    assert.equal(model.requests.length, 2);
    for (const request of model.requests) assert.equal(request.messages.filter(message => message.role === 'system').length, 1);
    const first = content(model.requests[0].messages.filter(message => message.role === 'system'));
    const second = content(model.requests[1].messages.filter(message => message.role === 'system'));
    assert.ok(first.indexOf('RULE_A_V1') < first.indexOf('RULE_B'));
    assert.match(second, /RULE_A_V2/); assert.match(second, /RULE_B/); assert.doesNotMatch(second, /RULE_A_V1/);
    assert.match(content(model.requests[1].messages), /first answer/);
  } finally { await ctx.fiber.dispose(); }
});

test('baseline reproducer: a developer message cannot enter through the current user-only pre-step contract', async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, [{ text: 'must not happen' }]);
  try {
    const agent = await ctx.agentLoop.create(SessionId('baseline-gap'), { provider: 'fixture', model: 'fixture' });
    agent.ctx.on('agent/pre-step', async (_event, next) => {
      const decision = await next();
      return decision.kind === 'reject' ? decision : { ...decision, messages: [developer('APPLICATION_RULE') as never, ...decision.messages] };
    });
    agent.followup(user('go')); await agent.whenIdle();
    assert.equal(model.requests.length, 0);
    const ending = agent.session.snapshotEvents().find(event => event.type === 'turn/end');
    assert.equal(ending?.data.reason.kind, 'error');
  } finally { await ctx.fiber.dispose(); }
});

test('isolated candidate: system + developer + user + tool result remain typed and replay in a new Agent', { timeout: 30000 }, async () => {
  const candidate = await candidateLoop();
  const { ctx, model } = await nativeHarness(candidate.loop, [
    { callId: 'read-1', name: 'read_policy', args: {} }, { text: 'read complete' },
    { text: 'second turn' }, { text: 'fork complete' },
  ], candidate.llm);
  try {
    const agent = await ctx.agentLoop.create(SessionId('all-roles'), { provider: 'fixture', model: 'fixture' });
    let rule = 'DEVELOPER_V1'; const calls: string[] = [];
    await agent.ctx.inject(['systemPrompt', 'tools'], scope => {
      scope.systemPrompt.section({ name: 'a/rules', order: 20, text: 'SYSTEM_A', interpolate: false });
      scope.systemPrompt.section({ name: 'b/rules', order: 30, text: 'SYSTEM_B', interpolate: false });
      scope.tools.register(defineTool({ name: 'read_policy', description: 'Read policy', parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: { policy: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.policy }] },
        async execute(_args, exec) { calls.push(String(exec.callId)); return { policy: 'POLICY_BODY' }; },
      }));
    });
    agent.ctx.on('agent/pre-step', async (event, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || !event.messages.length) return decision;
      return { ...decision, developerMessages: [developer(rule)] };
    });
    agent.followup(user('first request')); await agent.whenIdle();
    assert.equal(model.requests.length, 2);
    assert.deepEqual(calls, ['read-1']);
    assert.equal(model.requests[0].messages.filter(message => message.role === 'system').length, 1);
    assert.match(content(model.requests[0].messages.filter(message => message.role === 'developer')), /DEVELOPER_V1/,
      content({ messages: model.requests[0].messages, developer: agent.session.snapshotEvents().filter(event => event.type === 'developer/message') }));
    const results = model.requests[1].messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 1); assert.match(content(results), /read-1/); assert.match(content(results), /POLICY_BODY/);
    rule = 'DEVELOPER_V2';
    agent.followup(user('second request')); await agent.whenIdle();
    const updates = model.requests[2].messages.filter(message => message.role === 'developer');
    assert.match(content(updates.at(-1)), /DEVELOPER_V2/);
    assert.match(content(model.requests[2].messages), /read complete/);
    const seed = structuredClone(agent.session.snapshotEvents());
    const before = content(seed);
    const fork = await ctx.agents.create({ sessionId: SessionId('fork'), seed,
      meta: { isSeeded: true, parentSession: agent.id },
      inheritedEventCount: SessionLogOffset(seed.length), agentOptions: { provider: 'fixture', model: 'fixture' } });
    fork.agent.followup(user('continue')); await fork.agent.whenIdle();
    assert.equal(model.requests.length, 4);
    assert.match(content(model.requests[3].messages.filter(message => message.role === 'developer')), /DEVELOPER_V2/);
    assert.match(content(model.requests[3].messages), /POLICY_BODY/);
    assert.match(content(model.requests[3].messages), /opaqueFixture/, 'opaque provider replay state survives the history boundary');
    assert.equal(content(agent.session.snapshotEvents()), before);
    await fork.dispose();
  } finally { await ctx.fiber.dispose(); await candidate.dispose(); }
});

test('isolated candidate: rejected or cancelled admission does not leave developer instructions in history', { timeout: 30000 }, async () => {
  const candidate = await candidateLoop();
  const { ctx, model } = await nativeHarness(candidate.loop, [{ text: 'must not happen' }], candidate.llm);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  try {
    const agent = await ctx.agentLoop.create(SessionId('cancel-developer'), { provider: 'fixture', model: 'fixture' });
    agent.ctx.on('agent/pre-step', async (_event, next) => {
      const decision = await next(); entered.resolve(); await release.promise;
      return decision.kind === 'reject' ? decision : { ...decision, developerMessages: [developer('CANCELLED_RULE')] };
    });
    agent.followup(user('cancel')); await entered.promise;
    agent.cancel({ kind: 'user' }); release.resolve(); await agent.whenIdle();
    assert.equal(model.requests.length, 0);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'developer/message').length, 0);
  } finally { release.resolve(); await ctx.fiber.dispose(); await candidate.dispose(); }
});

test('projection candidate preserves developer text while removing unsupported tool-change blocks', async () => {
  const candidate = await candidateLoop();
  try {
    const plain = developer('KEEP_INSTRUCTIONS');
    const unchanged = [user('plain')];
    assert.equal(candidate.projectToolUpdates(unchanged, undefined, undefined).messages, unchanged);
    const mixed = { ...plain, content: [...plain.content, { type: 'tool-addition' as const, toolName: 'gone' }] };
    for (const mode of [undefined, 'in-history', 'addition-only'] as const) {
      const result = candidate.projectToolUpdates([mixed], [], mode, { tools: [], updates: [] });
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].role, 'developer');
      assert.deepEqual(result.messages[0].content, plain.content);
    }
    assert.deepEqual(mixed.content.length, 2, 'projection must not mutate original history');
  } finally { await candidate.dispose(); }
});

test('developer admission is not repeated when a model request is retried', { timeout: 30000 }, async () => {
  const candidate = await candidateLoop();
  const { ctx, model } = await nativeHarness(candidate.loop, [{ fail: 'transient fixture failure' }, { text: 'recovered' }], candidate.llm);
  try {
    const agent = await ctx.agentLoop.create(SessionId('retry'), { provider: 'fixture', model: 'fixture' });
    agent.ctx.on('agent/pre-step', async (_event, next) => {
      const decision = await next();
      return decision.kind === 'reject' ? decision : { ...decision, developerMessages: [developer('ONCE_ONLY')] };
    });
    let retries = 0;
    agent.ctx.on('agent/request-error', async (_event, next) => retries++ === 0 ? { kind: 'retry' } : next());
    agent.followup(user('retry task')); await agent.whenIdle();
    assert.equal(model.requests.length, 2);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'developer/message').length, 1);
    assert.equal(content(model.requests[1].messages).split('ONCE_ONLY').length - 1, 1);
  } finally { await ctx.fiber.dispose(); await candidate.dispose(); }
});

test('real Node PTC keeps structured subcall values, parent linkage and developer context', { timeout: 30000 }, async () => {
  const candidate = await candidateLoop();
  const { ctx, model } = await nativeHarness(candidate.loop, [
    { callId: 'program-1', name: 'run_code', args: { code: 'const a = await tools.number_a({}); const b = await tools.number_b({}); return { total: a.amount + b.amount };', description: 'Combine structured results' } },
    { text: 'program complete' },
  ], candidate.llm);
  try {
    await ctx.plugin(FileSystem); await ctx.plugin(Subprocess); await ctx.plugin(Sandbox);
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' });
    await ctx.plugin(WorkingDirectory);
    await ctx.plugin(NodePtcRuntime, { timeoutMs: 10000 });
    const agent = await ctx.agentLoop.create(SessionId('program'), { provider: 'fixture', model: 'fixture' });
    const observed: Array<{ name: string; root: unknown; nested: boolean }> = [];
    await agent.ctx.plugin(PtcExecutor);
    await agent.ctx.inject(['tools'], scope => {
      for (const [name, amount] of [['number_a', 20], ['number_b', 22]] as const) {
        scope.tools.register(defineTool({ name, description: name, parameters: {},
          output: { schema: { type: 'object', additionalProperties: false, properties: { amount: { type: 'number', required: true } } }, render: () => [{ type: 'text', text: 'RENDERED_CONTENT_IS_NOT_THE_VALUE' }] },
          async execute(_args, exec) {
            observed.push({ name, root: exec.rootCallId, nested: exec.parent !== undefined });
            return { amount };
          },
        }));
      }
    });
    agent.ctx.on('agent/pre-step', async (event, next) => {
      const decision = await next();
      return decision.kind === 'reject' || !event.messages.length ? decision : { ...decision, developerMessages: [developer('PTC_DEVELOPER_RULE')] };
    });
    agent.followup(user('calculate')); await agent.whenIdle();
    assert.equal(model.requests.length, 2);
    assert.deepEqual(model.requests[0].tools?.map(tool => tool.name), ['run_code']);
    assert.match(content(model.requests[0].messages), /number_a/);
    assert.match(content(model.requests[0].messages.filter(message => message.role === 'developer')), /PTC_DEVELOPER_RULE/);
    assert.deepEqual(observed, [{ name: 'number_a', root: 'program-1', nested: true }, { name: 'number_b', root: 'program-1', nested: true }]);
    assert.match(content(model.requests[1].messages.filter(message => message.role === 'tool')), /42/);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch').length, 2);
  } finally { await ctx.fiber.dispose(); await candidate.dispose(); }
});
