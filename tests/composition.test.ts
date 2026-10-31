import test from 'node:test';
import assert from 'node:assert/strict';
import { Composition } from '../src/composition.ts';
import type { Contribution } from '../src/composition.ts';

const signal = () => new AbortController().signal;
const put = (text: string): Contribution => ({ op: 'put', key: 'same-key', value: { kind: 'instruction', role: 'system', text } });

test('arbitrary source events share the protocol; identities and selected ordering survive updates', async () => {
  const composer = new Composition([
    { id: 'a', async handle(event) { return [put(String(event.data))]; } },
    { id: 'b', async handle() { return [put('B')]; } },
  ]);
  await composer.dispatch('source/changed', 'A1', signal());
  await composer.dispatch('source/changed', 'A2', signal(), 'a');
  assert.deepEqual(composer.snapshot.map(item => [item.owner, item.value]), [
    ['a', { kind: 'instruction', role: 'system', text: 'A2' }],
    ['b', { kind: 'instruction', role: 'system', text: 'B' }],
  ]);
  assert.ok(Object.isFrozen(composer.snapshot[0].value));
  await composer.close();
});

test('one invalid contribution rejects the whole event batch', async () => {
  const composer = new Composition([
    { id: 'a', async handle() { return [put('must-not-commit')]; } },
    { id: 'b', async handle() { return [{ op: 'put', key: 'broken', value: { kind: 'instruction', role: 'tool', text: 'bad' } } as never]; } },
  ]);
  await assert.rejects(composer.dispatch('prepare', {}, signal()), /Invalid instruction/);
  assert.deepEqual(composer.snapshot, []);
});

test('a wrong or malformed answer cannot commit accompanying changes', async () => {
  let wrongId = true;
  const composer = new Composition([{ id: 'a', async handle(event) { return [put('uncommitted'),
    { op: 'answer', requestId: wrongId ? 'wrong' : event.request!.id, value: 'bad-result' }];
  } }]);
  const request = { id: 'expected', key: 'action', callId: 'call-1' };
  await assert.rejects(composer.dispatch('tools/execute', {}, signal(), 'a', request), /does not match/);
  wrongId = false;
  await assert.rejects(composer.dispatch('tools/execute', {}, signal(), 'a', request, () => { throw new Error('output invalid'); }), /output invalid/);
  assert.deepEqual(composer.snapshot, []);
});

test('cancelled feedback is rejected; record feedback updates future context without mutating facts', async () => {
  const controller = new AbortController();
  const composer = new Composition([{ id: 'a', async handle() { controller.abort(new Error('cancel')); return [put('late')]; } }]);
  await assert.rejects(composer.dispatch('source', {}, controller.signal), /cancel/);
  assert.deepEqual(composer.snapshot, []);
  const record = { type: 'turn/start', data: { turn: 1 } };
  const observer = new Composition([{ id: 'b', async handle(event) {
    assert.ok(Object.isFrozen(event.data));
    return [put('next-step-context')];
  } }]);
  await observer.dispatch('session/event', { record }, signal());
  assert.equal(observer.snapshot[0].value.kind === 'instruction' && observer.snapshot[0].value.text, 'next-step-context');
  assert.deepEqual(record, { type: 'turn/start', data: { turn: 1 } });
});

test('late requests preserve newer fragments and tombstones while still answering once', async () => {
  for (const remove of [false, true]) {
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const composition = new Composition([{ id: 'docs', async handle(event) {
      if (event.type === 'tools/execute') {
        entered.resolve(); await resume.promise;
        return [put('stale'), { op: 'put', key: 'coupled', value: { kind: 'instruction', role: 'system', text: 'stale batch' } },
          { op: 'answer', requestId: event.request.id, value: 'actual result' }];
      }
      return remove ? [{ op: 'remove', key: 'same-key' }] : [put('new')];
    } }]);
    const pending = composition.dispatch('tools/execute', {}, signal(), 'docs', { id: 'r', key: 'read', callId: 'c' });
    await entered.promise;
    await composition.dispatch('documents/changed', {}, signal(), 'docs');
    resume.resolve();
    assert.deepEqual(await pending, { value: 'actual result' });
    assert.equal(composition.snapshot.length, remove ? 0 : 1);
    if (!remove) assert.equal(composition.snapshot[0].value.kind === 'instruction' && composition.snapshot[0].value.text, 'new');
    await composition.close();
  }
});

test('one resource settlement failure does not prevent other resources from closing', async () => {
  const settled: string[] = [];
  const composition = new Composition([
    { id: 'failed-service', events: ['run/settled'], async handle() { settled.push('failed'); throw new Error('save failed'); } },
    { id: 'other-service', events: ['run/settled'], async handle() { settled.push('other'); } },
  ]);
  await assert.rejects(composition.dispatch('run/settled', { closing: true }, signal()), /save failed/);
  assert.deepEqual(settled, ['failed', 'other']);
  await composition.close();
});
