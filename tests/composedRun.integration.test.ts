import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposedRun, capabilityName } from '../src/composedRun.ts';
import type { ContextConnector, Contribution } from '../src/composition.ts';
import { candidateLoop } from './fixtures/developerLoop.mjs';
import { nativeHarness, user } from './fixtures/nativeHarness.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import Sandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';
import { defineTool } from '@deepseek-ai/dsh-tools';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';

const input: ContextConnector<{ 'chat/submit': string }> = { id: 'input', async handle(event) {
  if (event.type === 'chat/submit') return [{ op: 'append', key: event.id, value: { messages: [user(String(event.data))] } }];
} };
const instruction = (key: string, role: 'system' | 'developer', text: string): Contribution => ({ op: 'put', key, value: { kind: 'instruction', role, text } });

test('one compositor drives preparation, owned requests, context updates and persistence across turns', { timeout: 30000 }, async () => {
  const candidate = await candidateLoop();
  const { ctx, model } = await nativeHarness(candidate.loop, [
    { callId: 'lookup-1', name: capabilityName('documents', 'read'), args: {} },
    { text: 'first answer' }, { text: 'second answer' }, { text: 'replayed answer' },
  ], candidate.llm);
  let version = 1; let persisted: readonly SessionEvent[] = []; const trace: string[] = [];
  const rules: ContextConnector = { id: 'rules', async handle(event) {
    if (event.type === 'agent/prepare-step') return [instruction('company', 'system', `COMPANY_V${version}`), instruction('format', 'developer', `FORMAT_V${version}`)];
  } };
  const docs: ContextConnector = { id: 'documents', async handle(event) {
    if (event.type === 'run/initialize') return [instruction('use', 'system', 'DOCUMENT_RULE'), { op: 'put', key: 'read', value: {
      kind: 'capability', description: 'Read policy', parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { type: 'object', additionalProperties: false, properties: { body: { type: 'string' } }, required: ['body'] },
    } }];
    if (event.type === 'tools/execute') {
      trace.push(`request:${event.request?.key}`);
      return [{ op: 'answer', requestId: event.request!.id, value: { body: 'POLICY_VALUE' }, content: [{ type: 'text', text: 'POLICY_RENDERED' }] }];
    }
  } };
  const storage: ContextConnector = { id: 'storage', async handle(event) {
    if (event.type === 'session/event') trace.push(`record:${(event.data as { record: SessionEvent }).record.type}`);
    if (event.type === 'run/settled') {
      await new Promise(resolve => setTimeout(resolve, 5));
      persisted = (event.data as { events: readonly SessionEvent[] }).events;
      trace.push('saved');
    }
  } };
  let run: Awaited<ReturnType<typeof createComposedRun>> | undefined;
  try {
    ctx.tools.register(defineTool({ name: 'unselected', description: 'Must not leak', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute() { return 'hidden'; } }));
    run = await createComposedRun(ctx, { connectors: [rules, docs, input, storage], model: { provider: 'fixture', model: 'fixture' } });
    await assert.rejects(run.send('session/event', {}, 'storage').then(receipt => receipt.completed), /impersonate/);
    await run.send('chat/submit', 'FIRST_TASK', 'input').then(receipt => receipt.completed);
    assert.equal(model.requests.length, 2);
    const first = model.requests[0];
    assert.deepEqual(first.tools?.map(tool => tool.name), [capabilityName('documents', 'read')]);
    assert.equal(first.messages.filter(message => message.role === 'system').length, 1);
    assert.match(JSON.stringify(first.messages), /COMPANY_V1/); assert.match(JSON.stringify(first.messages), /DOCUMENT_RULE/);
    assert.match(JSON.stringify(first.messages.filter(message => message.role === 'developer')), /FORMAT_V1/);
    assert.match(JSON.stringify(model.requests[1].messages.filter(message => message.role === 'tool')), /POLICY_RENDERED/);
    assert.equal(trace.filter(item => item === 'request:read').length, 1);
    assert.equal(trace.at(-1), 'saved');
    version = 2;
    await run.send('chat/submit', 'SECOND_TASK', 'input').then(receipt => receipt.completed);
    assert.equal(model.requests.length, 3);
    const second = model.requests[2];
    const system = JSON.stringify(second.messages.filter(message => message.role === 'system'));
    assert.match(system, /COMPANY_V2/); assert.match(system, /DOCUMENT_RULE/); assert.doesNotMatch(system, /COMPANY_V1/);
    assert.match(JSON.stringify(second.messages.filter(message => message.role === 'developer').at(-1)), /FORMAT_V2/);
    assert.equal(JSON.stringify(second.messages).split('FIRST_TASK').length - 1, 1);
    assert.ok(persisted.some(record => record.type === 'tool/result'));
    const source = JSON.stringify(persisted);
    const history: ContextConnector = { id: 'history', async handle(event) {
      if (event.type === 'run/initialize') return [{ op: 'append', key: 'selected-records', value: { records: persisted } }];
    } };
    const fork = await createComposedRun(ctx, { connectors: [history, input], model: { provider: 'fixture', model: 'fixture' } });
    try {
      await fork.send('chat/submit', 'CONTINUE', 'input').then(receipt => receipt.completed);
      assert.equal(model.requests.length, 4);
      assert.match(JSON.stringify(model.requests[3].messages), /POLICY_RENDERED/);
      assert.match(JSON.stringify(model.requests[3].messages), /opaqueFixture/);
      assert.equal(JSON.stringify(persisted), source);
    } finally { await fork.dispose(); }
  } finally { await run?.dispose(); await ctx.fiber.dispose(); await candidate.dispose(); }
});

test('the same connector request/answer contract works through an injected native PTC projection', { timeout: 30000 }, async () => {
  const candidate = await candidateLoop();
  const name = capabilityName('numbers', 'read');
  const { ctx, model } = await nativeHarness(candidate.loop, [
    { callId: 'program', name: 'run_code', args: { code: `const x = await tools.${name}({}); return x.amount + 1;`, description: 'Read and calculate' } },
    { text: 'done' },
  ], candidate.llm);
  const calls: string[] = [];
  let run: Awaited<ReturnType<typeof createComposedRun>> | undefined;
  try {
    await ctx.plugin(FileSystem); await ctx.plugin(Subprocess); await ctx.plugin(Sandbox);
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' }); await ctx.plugin(WorkingDirectory);
    await ctx.plugin(NodePtcRuntime, { timeoutMs: 10000 });
    await ctx.inject(['tools', 'systemPrompt', 'ptcRuntime'], scope => {
      scope.provide('fixture.executor', new PtcExecutor(scope));
    });
    const numbers: ContextConnector = { id: 'numbers', async handle(event) {
      if (event.type === 'run/initialize') return [{ op: 'put', key: 'read', value: { kind: 'capability', description: 'Read number',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: { type: 'object', additionalProperties: false, properties: { amount: { type: 'number' } }, required: ['amount'] },
      } }];
      if (event.type === 'tools/execute') {
        assert.equal((event.data as { nested: boolean }).nested, true);
        calls.push(event.request!.key);
        return [{ op: 'answer', requestId: event.request!.id, value: { amount: 41 }, content: [{ type: 'text', text: 'DISPLAY_ONLY' }] }];
      }
    } };
    const projection: ContextConnector = { id: 'programming', async handle(event) {
      if (event.type === 'run/initialize') return [{ op: 'put', key: 'interaction', value: { kind: 'projection', service: 'fixture.executor' } }];
    } };
    run = await createComposedRun(ctx, { connectors: [numbers, projection, input], model: { provider: 'fixture', model: 'fixture' } });
    await run.send('chat/submit', 'CALCULATE', 'input').then(receipt => receipt.completed);
    assert.deepEqual(calls, ['read']);
    assert.deepEqual(model.requests[0].tools?.map(tool => tool.name), ['run_code']);
    assert.match(JSON.stringify(model.requests[1].messages.filter(message => message.role === 'tool')), /42/);
  } finally { await run?.dispose(); await ctx.fiber.dispose(); await candidate.dispose(); }
});

test('unpatched runtime is rejected before model execution and persistence receives the failure', async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, [{ text: 'must not run' }]);
  const outcomes: unknown[] = [];
  const storage: ContextConnector = { id: 'storage', async handle(event) {
    if (event.type === 'run/settled') outcomes.push(event.data);
  } };
  const run = await createComposedRun(ctx, { connectors: [input, storage], model: { provider: 'fixture', model: 'fixture' } });
  try {
    await assert.rejects(run.send('chat/submit', 'task', 'input').then(receipt => receipt.completed), /preparation hook/);
    assert.equal(model.requests.length, 0);
    assert.equal(outcomes.length, 1);
  } finally { await run.dispose(); await ctx.fiber.dispose(); }
});

test('cancellation reaches a pending connector request and still finalizes storage', { timeout: 30000 }, async () => {
  const candidate = await candidateLoop();
  const { ctx, model } = await nativeHarness(candidate.loop, [{ callId: 'pending', name: capabilityName('slow', 'read'), args: {} }], candidate.llm);
  const entered = Promise.withResolvers<void>(); let saved = false;
  const slow: ContextConnector = { id: 'slow', async handle(event) {
    if (event.type === 'run/initialize') return [{ op: 'put', key: 'read', value: { kind: 'capability', description: 'Wait',
      parameters: { type: 'object', additionalProperties: false, properties: {} }, output: { type: 'string' },
    } }];
    if (event.type === 'tools/execute') {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        if (event.signal.aborted) reject(new Error('cancelled'));
        else event.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    }
    if (event.type === 'run/settled') saved = true;
  } };
  const run = await createComposedRun(ctx, { connectors: [slow, input], model: { provider: 'fixture', model: 'fixture' } });
  try {
    const sending = run.send('chat/submit', 'wait', 'input').then(receipt => receipt.completed);
    await entered.promise; run.cancel();
    const outcome = await sending;
    assert.equal(outcome?.kind, 'aborted');
    assert.equal(model.requests.length, 1);
    assert.equal(saved, true);
  } finally { await run.dispose(); await ctx.fiber.dispose(); await candidate.dispose(); }
});

test('failed connector initialization delivers cleanup without starting an Agent', async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, []);
  let released = false;
  const resource: ContextConnector = { id: 'resource', async handle(event) {
    if (event.type === 'run/initialize') throw new Error('resource unavailable');
    if (event.type === 'run/settled') released = true;
  } };
  try {
    await assert.rejects(createComposedRun(ctx, { connectors: [resource], model: { provider: 'fixture', model: 'fixture' } }), /resource unavailable/);
    assert.equal(released, true); assert.equal(model.requests.length, 0); assert.equal(ctx.agents.list().length, 0);
  } finally { await ctx.fiber.dispose(); }
});
