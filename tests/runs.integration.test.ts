import test from 'node:test';
import assert from 'node:assert/strict';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';
import { nativeHarness, user } from './fixtures/nativeHarness.ts';
import { ConnectorRegistry } from '../src/registry.ts';
import { RunManager } from '../src/runs.ts';
import type { RunAuthority, RunControl } from '../src/runs.ts';
import type { ContextConnector } from '../src/composition.ts';

const active = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')]);
const selection = (id: string) => ({ version: 1 as const, bindings: [{ id }] });
const request = (id: string, key = 'one') => ({ key, selection: selection(id), entry: { type: 'task/submit', data: 'work', connector: id } });
const authority = (id: string): RunAuthority => ({ id, subject: id, cwd: '/tmp', model: { provider: 'fixture', model: 'fixture' },
  canUse: binding => binding.id !== 'hidden', canStart: () => true });

function input(id: string, closed: string[]): ContextConnector<{ 'task/submit': string }> {
  return { id, events: ['task/submit', 'run/settled'], async handle(event) {
    if (event.type === 'task/submit') return [{ op: 'append', key: event.id, value: { messages: [user(event.data)] } }];
    if (event.type === 'run/settled' && event.data.closing) closed.push(id);
  } };
}

test('scoped start deduplicates admission and enforces resource and management ownership', { skip: !active }, async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, () => ({ text: 'done' }));
  const registry = new ConnectorRegistry(); const closed: string[] = []; let connections = 0;
  registry.registerProvider({ id: 'services', async list() { return ['input', 'hidden'].map(id => ({ id, kind: 'service', label: id, description: '' })); },
    async connect(binding) { connections++; return input(binding.id, closed); } });
  const manager = new RunManager(ctx, registry); const os = manager.scope(authority('alice')); const other = manager.scope(authority('bob'));
  try {
    assert.deepEqual((await os.catalog()).map(card => card.id), ['input']);
    await assert.rejects(os.start(request('hidden')), /not authorized/);
    const [one, retry] = await Promise.all([os.start(request('input')), os.start(request('input'))]);
    assert.deepEqual(one, retry); await os.wait(one.id);
    assert.equal(connections, 1); assert.equal(model.requests.length, 1);
    await assert.rejects(os.start({ ...request('input'), entry: { type: 'task/submit', data: 'different' } }), /different composition/);
    await assert.rejects(other.send(one.id, { type: 'task/submit', data: 'outside' }), /outside/);
    await assert.rejects(os.send(one.id, { type: 'run/initialize', data: {} }), /source-owned/);
    const receipt = await os.send(one.id, { type: 'task/submit', data: 'next', connector: 'input' });
    await receipt.completed; assert.equal(model.requests.length, 2);
    await os.stop(one.id); await os.stop(one.id); assert.deepEqual(closed, ['input']);
  } finally { await manager.dispose(); await ctx.fiber.dispose(); }
});

test('a connector starts another composition through its injected control and receives its completion', { skip: !active }, async () => {
  const counts = new Map<string, number>();
  const { ctx, model } = await nativeHarness(NativeLoop, request => {
    const step = counts.get(request.sessionId!) ?? 0; counts.set(request.sessionId!, step + 1);
    if (step === 0 && request.tools?.some(tool => tool.name === 'delegate')) return { name: 'delegate', callId: 'delegate-1', args: {} };
    return { text: 'done' };
  });
  const registry = new ConnectorRegistry(); const closed: string[] = []; let childControl: RunControl | undefined;
  registry.registerProvider({ id: 'services', async list() { return ['parent', 'child'].map(id => ({ id, kind: 'service', label: id, description: '' })); },
    async connect(binding, context) {
      if (binding.id === 'child') return input('child', closed);
      childControl = context.os;
      const base = input('parent', closed);
      return { id: 'parent', events: ['run/initialize', 'task/submit', 'tools/execute', 'run/settled'], async handle(event) {
        if (event.type === 'run/initialize') return [{ op: 'put', key: 'delegate', value: { kind: 'capability', name: 'delegate', description: 'Delegate work',
          parameters: { type: 'object', properties: {} }, output: { type: 'string' } } }];
        if (event.type === 'tools/execute') {
          const child = await context.os!.start(request('child', event.request.callId));
          await context.os!.wait(child.id);
          return [{ op: 'answer', requestId: event.request.id, value: 'child completed' }];
        }
        return base.handle(event);
      } };
    } });
  const manager = new RunManager(ctx, registry); const os = manager.scope(authority('alice'));
  try {
    const parent = await os.start(request('parent')); await os.wait(parent.id);
    assert.equal(model.requests.length, 3);
    assert.match(JSON.stringify(model.requests.at(-1)), /child completed/);
    await os.stop(parent.id);
    assert.deepEqual([...closed].sort(), ['child', 'parent']);
    await assert.rejects(childControl!.start(request('child', 'late')), /Calling run is stopped/);
  } finally { await manager.dispose(); await ctx.fiber.dispose(); }
});

test('initialization failure releases compositions created before its failure', { skip: !active }, async () => {
  const { ctx } = await nativeHarness(NativeLoop, () => ({ text: 'done' }));
  const registry = new ConnectorRegistry(); const closed: string[] = [];
  registry.registerProvider({ id: 'services', async list() { return ['parent', 'child'].map(id => ({ id, kind: 'service', label: id, description: '' })); },
    async connect(binding, context) {
      if (binding.id === 'child') return input('child', closed);
      return { id: 'parent', events: ['run/initialize'], async handle() {
        await context.os!.start(request('child'));
        throw new Error('parent unavailable');
      } };
    } });
  const manager = new RunManager(ctx, registry);
  try {
    await assert.rejects(manager.scope(authority('alice')).start(request('parent')), /parent unavailable/);
    assert.deepEqual(closed, ['child']);
  } finally { await manager.dispose(); await ctx.fiber.dispose(); }
});

test('a resource can publish observations into its own run without impersonating another connector', { skip: !active }, async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, () => ({ text: 'observed' }));
  const registry = new ConnectorRegistry(); let control: RunControl | undefined; let runId = '';
  registry.registerProvider({ id: 'logs', async list() { return [{ id: 'logs', kind: 'service', label: 'Logs', description: '' }]; },
    async connect(binding, context) { control = context.os; runId = context.runId!; return input(binding.id, []); } });
  const manager = new RunManager(ctx, registry);
  try {
    const host = manager.scope(authority('alice')); const run = await host.start(request('logs')); await host.wait(run.id);
    const receipt = await control!.send(runId, { type: 'task/submit', data: 'new remote log line' }); await receipt.completed;
    assert.match(JSON.stringify(model.requests.at(-1)), /new remote log line/);
    await assert.rejects(control!.send(runId, { type: 'task/submit', data: 'forged', connector: 'history' }), /own binding/);
    await assert.rejects(control!.send(runId, { type: 'session/event', data: {} }), /source-owned/);
    await host.stop(run.id);
    await assert.rejects(control!.send(runId, { type: 'task/submit', data: 'too late' }), /stopped/);
  } finally { await manager.dispose(); await ctx.fiber.dispose(); }
});

test('self-delivery during initialization fails clearly instead of deadlocking creation', { skip: !active, timeout: 2000 }, async () => {
  const { ctx } = await nativeHarness(NativeLoop, () => ({ text: 'done' }));
  const registry = new ConnectorRegistry();
  registry.registerProvider({ id: 'input', async list() { return [{ id: 'input', kind: 'service', label: 'Input', description: '' }]; },
    async connect(binding, context) { return { id: binding.id, events: ['run/initialize'], async handle() {
      await context.os!.send(context.runId!, { type: 'task/submit', data: 'premature' });
    } }; } });
  const manager = new RunManager(ctx, registry);
  try { await assert.rejects(manager.scope(authority('alice')).start(request('input')), /initialization contributions/); }
  finally { await manager.dispose(); await ctx.fiber.dispose(); }
});
