import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection, validateSelection, moveBinding } from '../src/core.ts';
import { ConnectorRegistry } from '../src/compat/registry.ts';

test('untrusted selections cannot duplicate identities, pass executable config or overrun the contract', () => {
  assert.throws(() => parseSelection({ version: 1, bindings: [{ id: 'a' }, { id: 'a' }] }));
  assert.throws(() => parseSelection({ version: 1, bindings: [{ id: 'a', config: { code: () => 1 } }] }));
  assert.throws(() => parseSelection({ version: 2, bindings: [] }));
  assert.throws(() => parseSelection(JSON.parse('{"version":1,"bindings":[{"id":"a","config":{"__proto__":"bad"}}]}')));
});

test('selection validates metadata without assigning behavior to service categories', () => {
  const cards = [{ id: 'a', kind: 'instructions' as const, label: 'A', description: '', fields: [{ key: 'text', label: 'Text', required: true }] }];
  assert.throws(() => validateSelection(parseSelection({ version: 1, bindings: [{ id: 'a' }] }), cards), /Required/);
  assert.throws(() => validateSelection(parseSelection({ version: 1, bindings: [{ id: 'missing' }] }), cards), /available/);
  validateSelection(parseSelection({ version: 1, bindings: [{ id: 'a', config: { text: 'hello' } }] }), cards);
  validateSelection({ version: 1, bindings: [{ id: 's1' }, { id: 's2' }] }, ['s1', 's2'].map(id => ({ id, kind: 'session', label: id, description: '' })));
});

test('reordering a draft never mutates an in-flight selection', () => {
  const selection = parseSelection({ version: 1, bindings: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(moveBinding(selection, 'b', -1).bindings.map(item => item.id), ['b', 'a']);
  assert.deepEqual(selection.bindings.map(item => item.id), ['a', 'b']);
});

test('provider conversion stays outside the registry and prepared resources release on failure', async () => {
  const registry = new ConnectorRegistry(); const disposed: string[] = [];
  registry.registerProvider({ id: 'example', list: async () => ['a', 'b'].map(id => ({ id, kind: 'custom', label: id, description: '' })), prepare: async binding => {
    if (binding.id === 'b') throw new Error('source offline');
    return { instructions: 'converted by provider', dispose: () => { disposed.push(binding.id); } };
  } });
  await assert.rejects(registry.prepare({ version: 1, bindings: [{ id: 'a' }, { id: 'b' }] }, { cwd: '/tmp' }), /offline/);
  assert.deepEqual(disposed, ['a']);
  const prepared = await registry.prepare({ version: 1, bindings: [{ id: 'a' }] }, { cwd: '/tmp' });
  assert.equal(prepared.contributions[0]?.instructions, 'converted by provider');
  await prepared.dispose(); await prepared.dispose();
  assert.deepEqual(disposed, ['a', 'a']);
});

test('provider unload invalidates discovery without exposing private implementation fields', async () => {
  const registry = new ConnectorRegistry();
  const remove = registry.registerProvider({ id: 'p', list: async () => [{ id: 'a', kind: 'custom', label: 'A', description: '', secret: 'never public' }], prepare: async () => ({}) });
  assert.equal(JSON.stringify(await registry.catalog({ cwd: '/tmp' })).includes('secret'), false);
  remove();
  await assert.rejects(registry.prepare({ version: 1, bindings: [{ id: 'a' }] }, { cwd: '/tmp' }), /available/);
});
