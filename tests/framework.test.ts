import test from 'node:test';
import assert from 'node:assert/strict';
import { Composition, ConnectorRegistry, capabilityName } from '../src/framework.ts';
import type { Contribution, ContextConnector } from '../src/framework.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

const signal = () => new AbortController().signal;
const instruction = (text: string): Contribution => ({ op: 'put', key: 'description', value: { kind: 'instruction', role: 'system', text } });
const capability = (name?: string): Contribution => ({ op: 'put', key: 'read', value: { kind: 'capability', ...(name ? { name } : {}), description: 'Read',
  parameters: { type: 'object', additionalProperties: false, properties: {} }, output: { type: 'string' } } });

test('core registration accepts complete services and assigns no runtime meaning to catalog categories', async () => {
  const registry = new ConnectorRegistry(); const entered: string[] = [];
  assert.throws(() => registry.registerProvider({ id: 'old', async list() { return []; }, async prepare() { return {}; } } as never), /complete connectors/);
  registry.registerProvider({ id: 'services', async list() { return ['one', 'two'].map(id => ({ id, kind: 'session', label: id, description: '' })); },
    async connect(binding) { return { id: binding.id, events: ['run/initialize'], async handle() { entered.push(binding.id); return [instruction(binding.id)]; } }; } });
  const prepared = await registry.prepare({ version: 1, bindings: [{ id: 'one' }, { id: 'two' }] }, { cwd: '/tmp' });
  assert.deepEqual(entered, [], 'Discovery constructs handlers; initialization belongs to the run');
  assert.deepEqual(Object.keys(prepared).sort(), ['cards', 'connectors', 'selection']);
  const composition = new Composition(prepared.connectors);
  await composition.initialize(signal());
  assert.deepEqual(entered, ['one', 'two']);
  assert.deepEqual(composition.snapshot.map(item => item.owner), ['one', 'two']);
  await composition.close();
});

test('capability collisions reject the complete contribution batch, including generated-name collisions', async () => {
  for (const explicit of [true, false]) {
    const name = explicit ? 'same' : capabilityName('one', 'read');
    const composition = new Composition([
      { id: 'one', async handle() { return [instruction('must not commit'), capability(explicit ? name : undefined)]; } },
      { id: 'two', async handle() { return [capability(name)]; } },
    ]);
    await assert.rejects(composition.initialize(signal()), /Conflicting capability/);
    assert.deepEqual(composition.snapshot, []);
    await composition.close();
  }
});

test('history exclusivity is enforced on actual replay contributions, regardless of service label', async () => {
  const record = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent;
  const sources: ContextConnector[] = ['one', 'two'].map(id => ({ id, async handle() {
    return [{ op: 'append', key: 'history', value: { records: [record] } }];
  } }));
  const composition = new Composition(sources);
  await assert.rejects(composition.initialize(signal()), /multiple owners/);
  assert.deepEqual(composition.snapshot, []);
  await composition.close();
});

test('two execution projections conflict atomically', async () => {
  const composition = new Composition(['one', 'two'].map(id => ({ id, async handle() {
    return [instruction(id), { op: 'put' as const, key: 'execution', value: { kind: 'projection' as const, service: id } }];
  } })));
  await assert.rejects(composition.initialize(signal()), /Multiple execution projections/);
  assert.deepEqual(composition.snapshot, []);
  await composition.close();
});

test('non-serializable service feedback is rejected before any context is committed', async () => {
  const composition = new Composition([{ id: 'service', async handle() {
    return [instruction('must not commit'), { op: 'put', key: 'invalid', value: { kind: 'instruction', role: 'user', text: () => 'hidden executable' } } as never];
  } }]);
  await assert.rejects(composition.initialize(signal()), /JSON-compatible/);
  assert.deepEqual(composition.snapshot, []);
  await composition.close();
});
