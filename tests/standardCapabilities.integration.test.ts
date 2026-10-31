import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { nativeHarness, user, type Response } from './fixtures/nativeHarness.ts';
import { createComposedRun } from '../src/composedRun.ts';
import { captureNativeTools } from '../src/nativeBindings.ts';
import { messageConnector, historyConnector, nativeToolsConnector, skillConnector } from './fixtures/legacyConnectors.ts';

const active = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')]);
const options = { skip: !active, timeout: 45000 };

test('standard connectors retain real file/shell/MCP/skill/subagent behavior and native follow-ups', options, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'standard-context-'));
  await writeFile(path.join(root, 'input.txt'), 'INPUT_CONTENT');
  let parentId = ''; let childRead = false;
  const parentSteps: Response[] = [
    { callId: 'skill-1', name: 'skill', args: { name: 'review' } },
    { callId: 'mcp-1', name: 'mcp__fixture__echo', args: { text: 'standard' } },
    { callId: 'read-1', name: 'read', args: { file_path: 'input.txt' } },
    { callId: 'shell-1', name: 'bash', args: { command: 'printf WRITTEN_CONTENT > output.txt', description: 'Write fixture' } },
    { callId: 'delegate-1', name: 'subagent', args: { description: 'Review file', prompt: 'Read output.txt and report' } },
  ];
  const { ctx, model } = await nativeHarness(NativeLoop, request => {
    if (request.sessionId !== parentId) {
      if (!childRead) { childRead = true; return { callId: 'child-read', name: 'read', args: { file_path: 'output.txt' } }; }
      return { text: 'CHILD_COMPLETE' };
    }
    if (parentSteps.length) return parentSteps.shift()!;
    return { text: JSON.stringify(request.messages).includes('CHILD_COMPLETE') ? 'PARENT_COMPLETE' : 'PARENT_WAIT' };
  });
  const mount = async (name: string, config: object = {}) => {
    const module = await import(`@deepseek-ai/dsh-${name}`);
    const fiber = await ctx.plugin(module.default ?? module, config); await fiber.await();
    assert.equal(fiber.state, 2, `${name} must be active`);
  };
  let run: Awaited<ReturnType<typeof createComposedRun>> | undefined;
  let loads = 0; let saves = 0;
  try {
    for (const name of ['fs-local', 'subprocess-local', 'sandbox-local', 'shell-env', 'user-questions', 'user-approval', 'working-directory']) await mount(name);
    await mount('session-persistence-jsonl', { root: path.join(root, '.sessions'), compression: 'none', packChunks: false });
    await mount('sandbox-policy', { mode: 'danger-full-access', workspaceRoot: root });
    await mount('bash-sandbox', { cwd: root });
    for (const name of ['fs-observation-policy', 'tool-fs', 'tool-bash', 'subagent', 'subagent-spawn-in-process']) await mount(name);
    await mount('tool-subagent', { provider: 'spawn' });
    await mount('mcp-client', { serverName: 'fixture', transport: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcpServer.ts', import.meta.url))], failOnStartupError: true });
    run = await createComposedRun(ctx, { cwd: root, model: { provider: 'fixture', model: 'fixture' }, connectors: [
      messageConnector('prompt'),
      nativeToolsConnector('workspace', async () => captureNativeTools(ctx, ['read', 'write', 'edit', 'bash'])),
      nativeToolsConnector('mcp', async () => captureNativeTools(ctx, ['mcp__fixture__echo'])),
      nativeToolsConnector('delegate', async () => captureNativeTools(ctx, ['subagent'])),
      skillConnector('skills', { async list() { return [{ name: 'review', description: 'REVIEW_INDEX' }]; }, async read() { loads++; return 'LAZY_SKILL_BODY'; } }),
      historyConnector('storage', { async save() { await new Promise(resolve => setTimeout(resolve, 5)); saves++; } }),
    ] });
    parentId = run.agent.id;
    await run.send('chat/submit', 'Use the selected context', 'prompt').then(receipt => receipt.completed);
    assert.ok(model.requests.length >= 8);
    assert.equal(childRead, true);
    assert.equal(loads, 1); assert.equal(saves, 1);
    assert.doesNotMatch(JSON.stringify(model.requests[0]), /LAZY_SKILL_BODY/);
    assert.match(JSON.stringify(model.requests[1]), /LAZY_SKILL_BODY/);
    assert.match(JSON.stringify(model.requests[2]), /MCP:standard/);
    assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), 'WRITTEN_CONTENT');
    const childRequests = model.requests.filter(request => request.sessionId !== parentId);
    assert.match(JSON.stringify(childRequests.at(-1)), /WRITTEN_CONTENT/);
    assert.match(JSON.stringify(model.requests.at(-1)), /CHILD_COMPLETE/);
    const previousCalls = model.requests.length;
    // Exercise the native Web/SDK path instead of the coordinator's send helper.
    run.agent.followup(user('Native follow-up'));
    await run.agent.whenIdle();
    assert.equal(model.requests.length, previousCalls + 1);
    assert.equal(saves, 2, 'native wait must include final persistence');
    assert.equal(JSON.stringify(model.requests.at(-1)!.messages).split('Native follow-up').length - 1, 1);
  } finally { await run?.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('native activation and content projection survive the generic connector bridge', options, async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, [{ text: 'inactive' },
    { callId: 'native-1', name: 'conditional', args: {} }, { text: 'done' }]);
  let enabled = false; let calls = 0;
  const original = defineTool({ name: 'conditional', description: 'Conditional', parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'DEFAULT_RENDER' }] },
    projectContent: () => [{ type: 'text', text: 'NATIVE_PROJECTION' }],
    async execute(_args, execution) { assert.ok(execution.agent); calls++; return 'canonical'; },
  });
  ctx.tools.register(original, { when: () => enabled });
  const run = await createComposedRun(ctx, { model: { provider: 'fixture', model: 'fixture' }, connectors: [
    messageConnector('prompt'), nativeToolsConnector('native', async () => captureNativeTools(ctx, ['conditional'])),
  ] });
  try {
    await run.send('chat/submit', 'first', 'prompt').then(receipt => receipt.completed);
    assert.ok(!model.requests[0].tools?.some(tool => tool.name === 'conditional'));
    enabled = true;
    await run.send('chat/submit', 'second', 'prompt').then(receipt => receipt.completed);
    assert.equal(calls, 1);
    assert.match(JSON.stringify(model.requests[2].messages), /NATIVE_PROJECTION/);
  } finally { await run.dispose(); await ctx.fiber.dispose(); }
});
