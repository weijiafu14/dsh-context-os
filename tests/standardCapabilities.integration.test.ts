import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { nativeHarness, user, type Response } from './fixtures/nativeHarness.ts';
import * as ContextOsPlugin from '../src/index.ts';
import { createComposedRun, isComposedAgent } from '../src/composedRun.ts';
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

test('default session composition auto-composes standard sessions, appends subdirectory AGENTS.md, cwd updates, and clock readings without prefix replacement', options, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cache-affine-context-'));
  await writeFile(path.join(root, 'AGENTS.md'), 'ROOT_RULE_BASELINE');
  await mkdir(path.join(root, 'subpkg'), { recursive: true });
  await writeFile(path.join(root, 'subpkg', 'AGENTS.md'), 'SUBPKG_RULE_APPENDED');
  await writeFile(path.join(root, 'subpkg', 'index.ts'), 'export const v = 1;');

  const steps: Response[] = [
    { callId: 'read-sub', name: 'read', args: { file_path: 'subpkg/index.ts' } },
    { callId: 'cd-sub', name: 'working_directory', args: { cd: 'subpkg' } },
    { text: 'TURN_1_OK' },
    { text: 'TURN_2_OK' },
  ];
  const { ctx, model } = await nativeHarness(NativeLoop, () => steps.shift() ?? { text: 'DONE' });
  const mount = async (name: string, config: object = {}) => {
    const mod = await import(`@deepseek-ai/dsh-${name}`);
    const fiber = await ctx.plugin(mod.default ?? mod, config);
    await fiber.await();
  };

  try {
    for (const name of ['fs-local', 'subprocess-local', 'sandbox-local', 'shell-env', 'working-directory', 'tool-working-directory']) {
      await mount(name);
    }
    await mount('sandbox-policy', { mode: 'danger-full-access', workspaceRoot: root });
    for (const name of ['fs-observation-policy', 'tool-fs', 'skill', 'time-context']) await mount(name);

    const pluginFiber = await ctx.plugin(ContextOsPlugin, { cwd: root, defaultCompose: true });
    await pluginFiber.await();

    // Standard `ctx.agents.create` (like clicking "New Chat" in Web UI) automatically enters Context OS!
    const handle = await ctx.agents.create({
      sessionId: SessionId('standard-new-chat'),
      meta: { cwd: root },
      agentOptions: { provider: 'fixture', model: 'fixture' },
    });
    assert.equal(isComposedAgent(handle.agent), true, 'Standard new chat must automatically run on Context OS');

    handle.agent.followup(user('Inspect subpkg'));
    await handle.agent.whenIdle();
    handle.agent.followup(user('Second turn check'));
    await handle.agent.whenIdle();

    // Verify ROOT_RULE_BASELINE + SUBPKG_RULE_APPENDED + clock reading all reached the model
    const lastMessagesJson = JSON.stringify(model.requests.at(-1)!.messages);
    assert.match(lastMessagesJson, /ROOT_RULE_BASELINE/);
    assert.match(lastMessagesJson, /SUBPKG_RULE_APPENDED/);
    assert.match(lastMessagesJson, /Time sampled while preparing turn 1/);
    // Raw bypassed `source.kind === 'time-context'` must have been suppressed so there are no duplicate clocks
    assert.equal(
      model.requests.at(-1)!.messages.filter(m => m.role === 'user' && (m.source as { kind: string }).kind === 'time-context').length,
      0,
    );

    // Zero surface replacements occurred during subdirectory discovery and working-directory change!
    const nonAppends = handle.agent.session.snapshotEvents().filter(e => 'surfaceOp' in e && e.surfaceOp !== undefined && e.surfaceOp !== 'append');
    assert.deepEqual(nonAppends, [], 'Dynamic subdirectory rules and cwd changes must be 100% append-only (cache-affine)');
    assert.deepEqual(ContextOsPlugin.cacheRefreshesOf(handle.agent), []);

    await handle.dispose();
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('in-place reconfigure updates active composition and records exact connector owner attribution in cacheRefreshes', options, async () => {
  const { ctx, model } = await nativeHarness(NativeLoop, [{ text: 'first' }, { text: 'second' }]);
  const guideV1 = {
    id: 'team:guide',
    events: ['run/initialize'],
    async handle() {
      return [{ op: 'put' as const, key: 'rule', value: { kind: 'instruction' as const, role: 'system' as const, text: 'GUIDE_V1' } }];
    },
  };
  const guideV2 = {
    id: 'team:guide',
    events: ['run/initialize'],
    async handle() {
      return [{ op: 'put' as const, key: 'rule', value: { kind: 'instruction' as const, role: 'system' as const, text: 'GUIDE_V2' } }];
    },
  };
  const promptConn = messageConnector('prompt');
  const run = await createComposedRun(ctx, {
    model: { provider: 'fixture', model: 'fixture' },
    connectors: [guideV1, promptConn],
  });
  try {
    await run.send('chat/submit', 'turn 1', 'prompt').then(r => r.completed);
    assert.equal(run.cacheRefreshes.length, 0);
    assert.match(JSON.stringify(model.requests[0].messages), /GUIDE_V1/);

    const { changedOwners } = await run.reconfigure([guideV2, promptConn]);
    assert.deepEqual(changedOwners, ['team:guide']);

    await run.send('chat/submit', 'turn 2', 'prompt').then(r => r.completed);
    assert.match(JSON.stringify(model.requests[1].messages), /GUIDE_V2/);
    assert.doesNotMatch(JSON.stringify(model.requests[1].messages), /GUIDE_V1/);
    assert.equal(run.cacheRefreshes.length, 1);
    assert.deepEqual(run.cacheRefreshes[0]!.owners, ['team:guide']);
    assert.ok(run.cacheRefreshes[0]!.reasons.includes('system-instruction'));
  } finally {
    await run.dispose();
    await ctx.fiber.dispose();
  }
});
