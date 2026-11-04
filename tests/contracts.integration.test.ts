import test from 'node:test';
import assert from 'node:assert/strict';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';
import { nativeHarness, user } from './fixtures/nativeHarness.ts';
import { createComposedRun, capabilityName } from '../src/composedRun.ts';
import type { ContextConnector } from '../src/composition.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

const active = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')]);
const input: ContextConnector<{ 'task': string }> = { id: 'input', events: ['task'], async handle(event) {
  if (event.type === 'task') return [{ op: 'append', key: event.id, value: { messages: [user(event.data)] } }];
} };
const ask = async (run: Awaited<ReturnType<typeof createComposedRun>>, text: string) => (await run.send('task', text, 'input')).completed;

test('record observers receive native seed-boundary records across repeated cold assembly', { skip: !active }, async () => {
  const { ctx } = await nativeHarness(NativeLoop, () => ({ text: 'saved' }));
  const saved: SessionEvent[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      const history: ContextConnector = { id: 'history', events: ['run/initialize', 'session/event'], async handle(event) {
        if (event.type === 'run/initialize') return saved.length ? [{ op: 'append', key: 'seed', value: { records: [...saved] } }] : [];
        if (event.type === 'session/event') {
          assert.equal(event.data.record.seq, saved.length, 'every newly created native record must be observed');
          saved.push(event.data.record);
        }
      } };
      const run = await createComposedRun(ctx, { connectors: [history, input], model: { provider: 'fixture', model: 'fixture' } });
      try { await ask(run, `iteration ${index}`); }
      finally { await run.dispose(); }
    }
    assert.equal(saved.filter(event => event.type === 'session/end-seed').length, 2);
  } finally { await ctx.fiber.dispose(); }
});

test('failed record observation prevents a capability from acting on unpersisted input', { skip: !active }, async () => {
  const { ctx } = await nativeHarness(NativeLoop, [{ name: 'write', callId: 'write', args: {} }, { text: 'Could not write' }]);
  let writes = 0;
  const service: ContextConnector = { id: 'service', events: ['run/initialize', 'tools/execute', 'session/event'], async handle(event) {
    if (event.type === 'run/initialize') return [{ op: 'put', key: 'write', value: { kind: 'capability', name: 'write', description: 'Write', parameters: { type: 'object', properties: {} }, output: { type: 'string' } } }];
    if (event.type === 'session/event' && event.data.record.type === 'user/message') throw new Error('Storage unavailable');
    if (event.type === 'tools/execute') { writes++; return [{ op: 'answer', requestId: event.request.id, value: 'written' }]; }
  } };
  const run = await createComposedRun(ctx, { connectors: [input, service], model: { provider: 'fixture', model: 'fixture' } });
  try { await assert.rejects(ask(run, 'write'), /persistence failed/); assert.equal(writes, 0); }
  finally { await run.dispose(); await ctx.fiber.dispose(); }
});

for (const route of ['normal', 'in-history'] as const) for (const role of ['system', 'developer', 'user'] as const) test(`current ${role} instructions replace/remove and cold replay stays removed (${route})`, { skip: !active, timeout: 5000 }, async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, () => ({ text: 'done' }));
  if (route === 'in-history') model.resolveModel = async (provider, model) => ({ provider, id: model, name: model, systemPromptUpdate: 'in-history' as const });
  const service: ContextConnector<{ 'policy': string | null }> = { id: 'policy', events: ['policy'], async handle(event) {
    if (event.type !== 'policy') return;
    return event.data === null ? [{ op: 'remove', key: 'policy' }]
      : [{ op: 'put', key: 'policy', value: { kind: 'instruction', role, text: event.data } }];
  } };
  const run = await createComposedRun(ctx, { connectors: [service, input], model: { provider: 'fixture', model: 'fixture' } });
  let records: readonly SessionEvent[];
  try {
    await run.send('policy', 'OLD_POLICY', 'policy'); await ask(run, 'one');
    await run.send('policy', 'NEW_POLICY', 'policy'); await ask(run, 'two');
    assert.doesNotMatch(JSON.stringify(model.requests[1].messages), /OLD_POLICY/);
    assert.match(JSON.stringify(model.requests[1].messages), /NEW_POLICY/);
    await run.send('policy', null, 'policy'); await ask(run, 'three');
    assert.doesNotMatch(JSON.stringify(model.requests[2].messages), /OLD_POLICY|NEW_POLICY/);
    records = run.agent.session.snapshotEvents();
    if (route === 'in-history') assert.ok(records.some(record => record.type === 'request/context' && record.data.systemPromptUpdate === 'in-history'));
    assert.match(JSON.stringify(records), /OLD_POLICY/);
    assert.match(JSON.stringify(records), /NEW_POLICY/);
  } finally { await run.dispose(); }
  const history: ContextConnector = { id: 'history', events: ['run/initialize'], async handle() {
    return [{ op: 'append', key: 'history', value: { records } }];
  } };
  const fork = await createComposedRun(ctx, { connectors: [history, input], model: { provider: 'fixture', model: 'fixture' } });
  try {
    await ask(fork, 'continue');
    assert.doesNotMatch(JSON.stringify(model.requests.at(-1)?.messages), /OLD_POLICY|NEW_POLICY/);
  } finally { await fork.dispose(); await ctx.fiber.dispose(); }
});

test('record feedback reaches the next step; settlement feedback waits for the next requested turn', { skip: !active, timeout: 5000 }, async () => {
  let calls = 0;
  const { ctx, model } = await nativeHarness(NativeLoop, () => calls++ === 0
    ? { callId: 'read', name: capabilityName('docs', 'read'), args: {} } : { text: 'done' });
  const docs: ContextConnector = { id: 'docs', events: ['run/initialize', 'tools/execute', 'session/event', 'run/settled'], async handle(event) {
    if (event.type === 'run/initialize') return [{ op: 'put', key: 'read', value: { kind: 'capability', description: 'Read', parameters: { type: 'object', properties: {} }, output: { type: 'string' } } }];
    if (event.type === 'tools/execute') return [{ op: 'answer', requestId: event.request.id, value: 'read result' }];
    if (event.type === 'session/event' && event.data.record.type === 'tool/result') return [
      { op: 'put', key: 'record-context', value: { kind: 'instruction', role: 'system', text: 'FEEDBACK_FROM_RECORD' } },
      { op: 'append', key: event.id, value: { messages: [user('RECORD_FOLLOWUP')] } },
    ];
    if (event.type === 'run/settled' && !event.data.closing) return [
      { op: 'put', key: 'saved', value: { kind: 'instruction', role: 'system', text: 'FEEDBACK_FROM_SETTLEMENT' } },
      { op: 'append', key: event.id, value: { messages: [user('SETTLEMENT_NOTE')] } },
    ];
  } };
  const run = await createComposedRun(ctx, { connectors: [docs, input], model: { provider: 'fixture', model: 'fixture' } });
  try {
    await ask(run, 'read');
    assert.equal(model.requests.length, 2);
    assert.match(JSON.stringify(model.requests[1].messages), /FEEDBACK_FROM_RECORD/);
    assert.match(JSON.stringify(model.requests[1].messages), /RECORD_FOLLOWUP/);
    assert.doesNotMatch(JSON.stringify(model.requests[1].messages), /FEEDBACK_FROM_SETTLEMENT|SETTLEMENT_NOTE/);
    await ask(run, 'another turn');
    assert.match(JSON.stringify(model.requests.at(-1)?.messages), /FEEDBACK_FROM_SETTLEMENT/);
    assert.match(JSON.stringify(model.requests.at(-1)?.messages), /SETTLEMENT_NOTE/);
  } finally { await run.dispose(); await ctx.fiber.dispose(); }
});

for (const fail of [false, true]) test(`send always acknowledges admission and both receipts await settlement (save failure=${fail})`, { skip: !active, timeout: 5000 }, async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const saving = Promise.withResolvers<void>(); const save = Promise.withResolvers<void>();
  let calls = 0;
  const { ctx } = await nativeHarness(NativeLoop, () => calls++ === 0
    ? { callId: 'read', name: capabilityName('docs', 'read'), args: {} } : { text: 'done' });
  const docs: ContextConnector = { id: 'docs', events: ['run/initialize', 'tools/execute', 'run/settled'], async handle(event) {
    if (event.type === 'run/initialize') return [{ op: 'put', key: 'read', value: { kind: 'capability', description: 'Read', parameters: { type: 'object', properties: {} }, output: { type: 'string' } } }];
    if (event.type === 'tools/execute') { entered.resolve(); await release.promise; return [{ op: 'answer', requestId: event.request.id, value: 'ok' }]; }
    if (event.type === 'run/settled' && !event.data.closing) { saving.resolve(); await save.promise; if (fail) throw new Error('save rejected'); }
  } };
  const run = await createComposedRun(ctx, { connectors: [docs, input], model: { provider: 'fixture', model: 'fixture' } });
  try {
    const first = await run.send('task', 'first', 'input');
    await entered.promise;
    const second = await run.send('task', 'second', 'input');
    assert.strictEqual(first.completed, second.completed);
    let done = false;
    void first.completed.then(() => { done = true; }, () => { done = true; });
    release.resolve(); await saving.promise;
    assert.equal(done, false);
    save.resolve();
    if (fail) await Promise.all([assert.rejects(first.completed, /persistence failed/), assert.rejects(second.completed, /persistence failed/)]);
    else assert.equal((await first.completed)?.kind, 'completed');
  } finally { release.resolve(); save.resolve(); await run.dispose(); await ctx.fiber.dispose(); }
});

test('one source event admits its entire ordered message batch before the first model call', { skip: !active }, async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, [{ text: 'done' }]);
  const connector: ContextConnector<{ 'batch': null }> = { id: 'batch', events: ['batch'], async handle(event) {
    if (event.type === 'batch') return [{ op: 'append', key: event.id, value: { messages: [user('FIRST_INPUT'), user('SECOND_INPUT'), user('THIRD_INPUT')] } }];
  } };
  const run = await createComposedRun(ctx, { connectors: [connector], model: { provider: 'fixture', model: 'fixture' } });
  try {
    await (await run.send('batch', null, 'batch')).completed;
    assert.equal(model.requests.length, 1);
    const inputs = model.requests[0].messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content));
    assert.deepEqual(inputs.map(text => /FIRST_INPUT|SECOND_INPUT|THIRD_INPUT/.exec(text)?.[0]), ['FIRST_INPUT', 'SECOND_INPUT', 'THIRD_INPUT']);
  } finally { await run.dispose(); await ctx.fiber.dispose(); }
});
