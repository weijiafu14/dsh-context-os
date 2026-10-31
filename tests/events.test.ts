import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { assembleContext, connectContext } from '../src/compat/events.ts';
import type { AssemblyWindow } from '../src/compat/events.ts';

const window: AssemblyWindow<{ revision: number }, string> = {
  name: 'fixture/native-boundary',
  input: input => Object.freeze({ ...input }),
  accept(value) { if (typeof value !== 'string') throw new Error('string required'); return value; },
};

test('one generic event boundary preserves scope, source and registration order without resource categories', async () => {
  const ctx = new Context(); const a = {}; const b = {};
  const first = createScope(ctx, a); const other = createScope(ctx, b);
  try {
    connectContext(first.ctx, window, { id: 'slow', async handle(event) {
      assert.ok(Object.isFrozen(event.input));
      await new Promise(resolve => setTimeout(resolve, 10));
      return [{ key: 'one', value: 'first' }];
    } });
    const remove = connectContext(first.ctx, window, { id: 'fast', async handle() { return [{ key: 'one', value: 'second' }]; } });
    connectContext(other.ctx, window, { id: 'private', async handle() { return [{ key: 'one', value: 'never-visible-to-a' }]; } });
    const output = await assembleContext(ctx, a, window, { revision: 1 }, new AbortController().signal);
    assert.deepEqual(output.contributions.map(item => [item.owner, item.value]), [['slow', 'first'], ['fast', 'second']]);
    remove();
    assert.equal((await assembleContext(ctx, a, window, { revision: 2 }, new AbortController().signal)).contributions.length, 1);
    await first.dispose();
    assert.deepEqual((await assembleContext(ctx, a, window, { revision: 3 }, new AbortController().signal)).contributions, []);
  } finally { await ctx.fiber.dispose(); }
});

test('invalid contributions and duplicate source keys reject the whole candidate', async () => {
  const ctx = new Context(); const key = {}; const scope = createScope(ctx, key);
  try {
    connectContext(scope.ctx, window, { id: 'ok', async handle() { return [{ key: 'x', value: 'ok' }]; } });
    const invalid = connectContext(scope.ctx, window, { id: 'broken', async handle() { return [{ key: 'x', value: 42 as never }]; } });
    await assert.rejects(assembleContext(ctx, key, window, { revision: 1 }, new AbortController().signal), /Invalid contribution broken/);
    invalid();
    connectContext(scope.ctx, window, { id: 'ok', async handle() { return [{ key: 'x', value: 'overwrite' }]; } });
    await assert.rejects(assembleContext(ctx, key, window, { revision: 2 }, new AbortController().signal), /Duplicate contribution/);
  } finally { await ctx.fiber.dispose(); }
});

test('cancelled asynchronous feedback never returns a committable candidate', async () => {
  const ctx = new Context(); const key = {}; const scope = createScope(ctx, key);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  try {
    connectContext(scope.ctx, window, { id: 'pending', async handle() {
      entered.resolve(); await release.promise; return [{ key: 'x', value: 'late' }];
    } });
    const candidate = assembleContext(ctx, key, window, { revision: 1 }, controller.signal);
    await entered.promise;
    controller.abort(new Error('cancelled')); release.resolve();
    await assert.rejects(candidate, /cancelled/);
  } finally { release.resolve(); await ctx.fiber.dispose(); }
});
