import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { nativeHarness } from './fixtures/nativeHarness.ts';
import { createComposedRun } from '../src/composedRun.ts';
import { ConnectorRegistry } from '../src/compat/registry.ts';
import { standardSelection } from '../src/compat/standardSelection.ts';
import { Composition } from '../src/composition.ts';
import { nativeConnectorProvider } from '../src/compat/defaultConnectors.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContextConnector, Contribution } from '../src/composition.ts';

const active = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')]);
const options = { skip: !active, timeout: 45000 };

interface WorkspaceService {
  description: string;
  read(): Promise<string>;
  write(value: string): Promise<void>;
  settle(): Promise<void>;
  close(): Promise<void>;
}
// Provider implementation, with the same public protocol as every other connector.
function workspace(service: WorkspaceService): ContextConnector {
  return { id: 'workspace', events: ['run/initialize', 'agent/prepare-step', 'tools/execute', 'run/settled'], async handle(event) {
    if (event.type === 'run/settled') {
      if ((event.data as { closing?: boolean }).closing) await service.close(); else await service.settle();
      return;
    }
    if (event.type === 'tools/execute') {
      if (event.request!.key === 'write') await service.write((event.data.arguments as { value: string }).value);
      return [{ op: 'answer', requestId: event.request!.id, value: await service.read() }];
    }
    return [
      { op: 'put', key: 'environment', value: { kind: 'instruction', role: 'system', text: service.description } },
      { op: 'put', key: 'read', value: { kind: 'capability', name: 'workspace_read', description: 'Read from this workspace',
        parameters: { type: 'object', additionalProperties: false, properties: {} }, output: { type: 'string' } } },
      { op: 'put', key: 'write', value: { kind: 'capability', name: 'workspace_write', description: 'Write to this workspace',
        parameters: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] }, output: { type: 'string' } } },
    ];
  } };
}

test('replace a complete filesystem service with HTTP service while framework, prompt and session connectors stay identical', options, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resource-replacement-'));
  const file = path.join(root, 'value.txt'); await writeFile(file, 'LOCAL_BEFORE');
  let remoteValue = 'REMOTE_BEFORE'; const httpMethods: string[] = [];
  const server = createServer(async (req, res) => {
    httpMethods.push(req.method!);
    if (req.method === 'PUT') { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); remoteValue = Buffer.concat(chunks).toString(); }
    res.end(remoteValue);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  const url = `http://127.0.0.1:${address.port}`;
  const settled: string[] = []; const closed: string[] = [];
  const local: WorkspaceService = { description: 'WORKSPACE_LOCAL', read: () => readFile(file, 'utf8'), write: value => writeFile(file, value),
    async settle() { settled.push('local'); }, async close() { closed.push('local'); } };
  const remote: WorkspaceService = { description: 'WORKSPACE_REMOTE', async read() { return (await fetch(url)).text(); },
    async write(value) { const response = await fetch(url, { method: 'PUT', body: value }); assert.equal(response.status, 200); },
    async settle() { settled.push('remote'); }, async close() { closed.push('remote'); } };
  const perSession = new Map<string, number>();
  const { ctx, model } = await nativeHarness(NativeLoop, request => {
    const step = perSession.get(request.sessionId!) ?? 0; perSession.set(request.sessionId!, step + 1);
    if (step === 0) return { callId: 'write', name: 'workspace_write', args: { value: 'UPDATED' } };
    if (step === 1) return { callId: 'read', name: 'workspace_read', args: {} };
    return { text: 'DONE' };
  });
  // Ambient native resource text must not leak when the source is replaced.
  ctx.systemPrompt.section({ name: 'tool:bash', order: 100, text: 'UNSELECTED_NATIVE_WORKSPACE' });
  const saved: string[] = [];
  const session: ContextConnector = { id: 'session:custom', events: ['run/initialize', 'session/event', 'run/settled'], async handle(event) {
    if (event.type === 'run/initialize') return [{ op: 'put', key: 'policy', value: { kind: 'instruction', role: 'developer', text: 'SESSION_POLICY' } }];
    if (event.type === 'run/settled' && !(event.data as { closing?: boolean }).closing) saved.push(event.runId);
  } };
  const reference: ContextConnector = { id: 'reference', events: ['run/initialize'], async handle() {
    return [{ op: 'append', key: 'facts', value: { messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'REFERENCE_UNCHANGED' }] })] } }];
  } };
  let selected = local;
  const registry = new ConnectorRegistry();
  registry.registerProvider({ id: 'workspace-provider', async list() { return [{ id: 'workspace', kind: 'execution', label: 'Workspace', description: 'Selected workspace service' }]; },
    async connect() { return workspace(selected); } });
  registry.registerProvider({ id: 'unchanged-services', async list() { return [
    { id: session.id, kind: 'session', label: 'Session', description: 'Same session service' },
    { id: reference.id, kind: 'custom', label: 'Reference', description: 'Same reference service' },
  ]; }, async connect(binding) { return binding.id === session.id ? session : reference; } });
  const selection = { version: 1, bindings: [{ id: 'workspace' }, { id: session.id }, { id: reference.id }] };
  try {
    // Same registry, selection, preparation, engine and other connector objects.
    for (const implementation of [local, remote]) {
      selected = implementation;
      const prepared = await registry.prepare(selection, { cwd: root });
      assert.strictEqual(prepared.connectors[1], session); assert.strictEqual(prepared.connectors[2], reference);
      const sources = await standardSelection(ctx, prepared, root);
      assert.deepEqual(sources.connectors.map(source => source.id), ['agent:runtime', 'workspace', session.id, reference.id, 'prompt']);
      const run = await createComposedRun(ctx, { cwd: root, connectors: sources.connectors, model: { provider: 'fixture', model: 'fixture' }, setup: sources.installNativeCompatibility });
      const start = model.requests.length;
      try {
        await run.send('chat/submit', 'Update and read the selected workspace', 'prompt').then(receipt => receipt.completed);
        const requests = model.requests.slice(start);
        assert.equal(requests.length, 3);
        assert.match(JSON.stringify(requests[0].messages.filter(message => message.role === 'system')), new RegExp(implementation.description));
        assert.doesNotMatch(JSON.stringify(requests[0].messages.filter(message => message.role === 'system')), /UNSELECTED_NATIVE_WORKSPACE/);
        assert.doesNotMatch(JSON.stringify(requests[0].messages.filter(message => message.role === 'system')), new RegExp(implementation === local ? remote.description : local.description));
        assert.match(JSON.stringify(requests.at(-1)), /UPDATED/);
        assert.match(JSON.stringify(requests[0]), /SESSION_POLICY/);
        assert.match(JSON.stringify(requests[0]), /REFERENCE_UNCHANGED/);
      } finally { await run.dispose(); await sources.dispose(); }
    }
    assert.equal(await readFile(file, 'utf8'), 'UPDATED'); assert.equal(remoteValue, 'UPDATED');
    assert.deepEqual(httpMethods, ['PUT', 'GET', 'GET']);
    assert.deepEqual(settled, ['local', 'remote']); assert.deepEqual(closed, ['local', 'remote']);
    assert.equal(saved.length, 2);
  } finally { await ctx.fiber.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('a legacy resource with description, native calls, skill content and cleanup remains one owner', options, async () => {
  const { ctx } = await nativeHarness(NativeLoop, []);
  const registry = new ConnectorRegistry(); let released = 0;
  registry.registerProvider({ id: 'complete-provider', async list() { return [{ id: 'service', kind: 'custom', label: 'Service', description: 'Full resource' }]; }, async prepare() {
    return { instructions: 'SERVICE_DESCRIPTION', skills: [{ name: 'guide', description: 'SERVICE_GUIDE', content: 'SERVICE_BODY', source: 'runtime' }],
      tools: [{ name: 'service_read', description: 'Read service', parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'string' }, render: () => [] }, async execute() { return 'value'; } }],
      dispose: async () => { released++; } };
  } });
  const prepared = await registry.prepare({ version: 1, bindings: [{ id: 'service' }] }, { cwd: '/tmp' });
  const sources = await standardSelection(ctx, prepared, '/tmp');
  const resource = sources.connectors.find(source => source.id === 'service')!;
  const composition = new Composition([resource]); const signal = new AbortController().signal;
  try {
    await composition.initialize(signal);
    assert.deepEqual([...new Set(composition.snapshot.map(value => value.owner))], ['service']);
    assert.equal(composition.snapshot.filter(value => value.value.kind === 'capability').length, 2);
    assert.equal(composition.snapshot.filter(value => value.value.kind === 'instruction').length, 2);
    const result = await composition.dispatch('tools/execute', { arguments: { name: 'guide' } }, signal, 'service', { id: 'req', key: 'skill-body', callId: 'call' });
    assert.match(JSON.stringify(result), /SERVICE_BODY/);
    await composition.dispatch('run/settled', { closing: true }, signal);
    assert.equal(released, 1);
  } finally { await composition.close(); await sources.dispose(); await ctx.fiber.dispose(); }
  assert.equal(released, 1);
});

test('native workspace, MCP and two skill services each retain their own descriptions, calls and settlement', options, async () => {
  let step = 0;
  const { ctx, model } = await nativeHarness(NativeLoop, request => {
    if (step++ === 0) return { callId: 'docs', name: 'mcp__docs__read', args: {} };
    if (step <= 3) {
      const name = step === 2 ? 'alpha' : 'beta';
      const tool = request.tools!.find(tool => (tool.parameters as { properties?: { name?: { enum?: string[] } } }).properties?.name?.enum?.includes(name));
      assert.ok(tool, `Missing resource-owned ${name} loader`);
      return { callId: name, name: tool.name, args: { name } };
    }
    return { text: 'DONE' };
  });
  const skillModule = await import('@deepseek-ai/dsh-skill');
  const fiber = await ctx.plugin(skillModule.default ?? skillModule); await fiber.await();
  for (const name of ['alpha', 'beta']) ctx.skills.register({ name, description: `${name}_DESCRIPTION`, content: `${name}_BODY`, source: 'runtime' });
  ctx.tools.register(defineTool({ name: 'read', description: 'Workspace read', parameters: {}, output: { schema: { type: 'string' }, render: (_, result) => [{ type: 'text', text: result }] }, async execute() { return 'file'; } }));
  ctx.tools.register(defineTool({ name: 'mcp__docs__read', description: 'Read documents', parameters: {}, output: { schema: { type: 'string' }, render: (_, result) => [{ type: 'text', text: result }] }, async execute() { return 'DOCUMENT_RESULT'; } }));
  ctx.systemPrompt.section({ name: 'tool:read', order: 100, text: 'WORKSPACE_SYSTEM_DESCRIPTION' });
  ctx.systemPrompt.section({ name: 'mcp:docs', order: 110, text: 'MCP_SYSTEM_DESCRIPTION' });
  const registry = new ConnectorRegistry(); registry.registerProvider(nativeConnectorProvider(ctx));
  const ids = ['execution:default', 'mcp:docs', 'skill:alpha', 'skill:beta'];
  const prepared = await registry.prepare({ version: 1, bindings: ids.map(id => ({ id })) }, { cwd: '/tmp' });
  const sources = await standardSelection(ctx, prepared, '/tmp');
  const observed = new Map<string, Contribution[]>(); const invocations: string[] = []; const closed: string[] = [];
  for (const connector of sources.connectors) {
    const original = connector.handle.bind(connector);
    connector.handle = async event => {
      const values = await original(event);
      if (event.type === 'agent/prepare-step') observed.set(connector.id, [...values ?? []]);
      if (event.type === 'tools/execute') invocations.push(connector.id);
      if (event.type === 'run/settled' && (event.data as { closing?: boolean }).closing) closed.push(connector.id);
      return values;
    };
  }
  const run = await createComposedRun(ctx, { connectors: sources.connectors, model: { provider: 'fixture', model: 'fixture' }, setup: sources.installNativeCompatibility });
  try {
    await run.send('chat/submit', 'Use each service', 'prompt').then(receipt => receipt.completed);
    assert.deepEqual(sources.connectors.map(connector => connector.id), ['agent:runtime', ...ids, 'session:current', 'prompt']);
    assert.match(JSON.stringify(observed.get('execution:default')), /WORKSPACE_SYSTEM_DESCRIPTION/);
    assert.doesNotMatch(JSON.stringify(observed.get('execution:default')), /MCP_SYSTEM_DESCRIPTION|alpha_DESCRIPTION/);
    assert.match(JSON.stringify(observed.get('mcp:docs')), /MCP_SYSTEM_DESCRIPTION/);
    assert.doesNotMatch(JSON.stringify(observed.get('mcp:docs')), /WORKSPACE_SYSTEM_DESCRIPTION/);
    for (const name of ['alpha', 'beta']) {
      assert.match(JSON.stringify(observed.get(`skill:${name}`)), new RegExp(`${name}_DESCRIPTION`));
      assert.equal(observed.get(`skill:${name}`)!.filter(item => item.op === 'put' && item.value.kind === 'capability').length, 1);
    }
    assert.deepEqual(invocations, ['mcp:docs', 'skill:alpha', 'skill:beta']);
    assert.match(JSON.stringify(model.requests.at(-1)), /DOCUMENT_RESULT/);
    assert.match(JSON.stringify(model.requests.at(-1)), /alpha_BODY/);
    assert.match(JSON.stringify(model.requests.at(-1)), /beta_BODY/);
  } finally { await run.dispose(); await sources.dispose(); await ctx.fiber.dispose(); }
  for (const id of ids) assert.ok(closed.includes(id), `Missing settlement for ${id}`);
});
