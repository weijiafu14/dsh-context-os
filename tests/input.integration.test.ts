import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SessionStore, { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { connectContext } from '../src/compat/events.ts';
import { stepInputWindow, installInputAssembly } from '../src/compat/dshInput.ts';
import { inputConnector } from '../src/compat/input.ts';

class RecordingModel extends LlmAdapter {
  requests: GenerateOptions[] = [];
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(input: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(input);
    const text = `answer-${this.requests.length}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const textOf = (model: RecordingModel, index: number) => JSON.stringify(model.requests[index]?.messages);

async function harness() {
  const ctx = new Context(); const model = new RecordingModel();
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, NativeExecutor, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(['fixture'], model);
  const agent = await ctx.agentLoop.create(SessionId('composed-input'), { provider: 'fixture', model: 'fixture' });
  connectContext(agent.ctx, stepInputWindow, inputConnector);
  installInputAssembly(agent.ctx, agent);
  return { ctx, model, agent };
}

test('real DSH loop: initial input, follow-up and external injection use one event/contribution path', { timeout: 15000 }, async () => {
  const { ctx, model, agent } = await harness();
  try {
    const observations: number[] = [];
    connectContext(agent.ctx, stepInputWindow, { id: 'source-observer', async handle(event) {
      observations.push(event.input.turn);
      return [{ key: `notice-${event.id}`, value: message(`context-for-turn-${event.input.turn}`) }];
    } });
    agent.followup(message('first-question'));
    await agent.whenIdle();
    assert.equal(model.requests.length, 1);
    assert.match(textOf(model, 0), /first-question/);
    assert.match(textOf(model, 0), /context-for-turn-1/);

    agent.inject(message('external-update'));
    await agent.whenIdle();
    assert.equal(model.requests.length, 1, 'inject must not wake the loop');
    agent.followup(message('second-question'));
    await agent.whenIdle();
    assert.equal(model.requests.length, 2);
    const second = textOf(model, 1);
    for (const text of ['first-question', 'answer-1', 'second-question', 'external-update', 'context-for-turn-2']) assert.match(second, new RegExp(text));
    assert.equal(second.split('first-question').length - 1, 1, 'history is retained by DSH, not replayed by the connector');
    assert.deepEqual(observations, [1, 2]);
    const receipts = agent.session.snapshotEvents().map(pluginRecordOf).filter(record => record?.type === 'plugin:context-connectors/assembly');
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts.map(record => (record!.data as { turn: number }).turn), [1, 2]);
    assert.match(JSON.stringify(receipts), /native-input/);
    assert.match(JSON.stringify(receipts), /source-observer/);
    assert.doesNotMatch(JSON.stringify(receipts), /first-question|external-update/, 'audit stores references, not content copies');

    const other = await ctx.agentLoop.create(SessionId('uncomposed'), { provider: 'fixture', model: 'fixture' });
    other.followup(message('old-path'));
    await other.whenIdle();
    assert.equal(model.requests.length, 3);
    assert.doesNotMatch(textOf(model, 2), /context-for-turn|external-update/);
    assert.equal(other.session.snapshotEvents().map(pluginRecordOf).filter(Boolean).length, 0);

    // Cordis scopes inherit downward; an ancestor's bridge must not process a child's input.
    const child = await agent.ctx.agents.create({ sessionId: SessionId('native-child'), parentAgent: agent,
      agentOptions: { provider: 'fixture', model: 'fixture' } });
    child.agent.followup(message('child-only'));
    await child.agent.whenIdle();
    assert.equal(model.requests.length, 4);
    assert.doesNotMatch(textOf(model, 3), /context-for-turn|external-update/);
    assert.deepEqual(observations, [1, 2]);
    await child.dispose();
  } finally { await ctx.fiber.dispose(); }
});

test('conflicting contributions stop before a model call and do not break the next turn', { timeout: 15000 }, async () => {
  const { ctx, model, agent } = await harness();
  try {
    const remove = connectContext(agent.ctx, stepInputWindow, { id: 'duplicate', async handle(event) {
      return event.input.messages.map(value => ({ key: value.id, value }));
    } });
    agent.followup(message('conflicted-input'));
    await agent.whenIdle();
    assert.equal(model.requests.length, 0);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
    remove();
    agent.followup(message('recovered-input'));
    await agent.whenIdle();
    assert.equal(model.requests.length, 1);
    assert.match(textOf(model, 0), /recovered-input/);
    assert.doesNotMatch(textOf(model, 0), /conflicted-input/);
  } finally { await ctx.fiber.dispose(); }
});

test('native cancellation during feedback does not commit a late contribution', { timeout: 15000 }, async () => {
  const { ctx, model, agent } = await harness();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  try {
    connectContext(agent.ctx, stepInputWindow, { id: 'delayed', async handle() {
      entered.resolve(); await release.promise; return [{ key: 'late', value: message('late-context') }];
    } });
    agent.followup(message('cancel-this'));
    await entered.promise;
    agent.cancel({ kind: 'user' }); release.resolve();
    await agent.whenIdle();
    assert.equal(model.requests.length, 0);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0);
  } finally { release.resolve(); await ctx.fiber.dispose(); }
});
