import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import NativeLoop from '@deepseek-ai/dsh-agent-loop';
import { nativeHarness, user } from './fixtures/nativeHarness.ts';
import { ConnectorRegistry, createComposedRun, capabilityName } from '../src/framework.ts';
import type { ContextConnector } from '../src/framework.ts';
import { documentService } from '../examples/documentService.ts';
import type { DocumentBackend } from '../examples/documentService.ts';

const active = Boolean((globalThis as Record<symbol, unknown>)[Symbol.for('dsh.context-composition.runtime')]);

test('framework runs one complete service without compatibility adapters; live feedback and provider replacement preserve other services', { skip: !active, timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'complete-document-service-'));
  const file = path.join(root, 'document.txt'); await writeFile(file, 'LOCAL_DOCUMENT');
  let remoteDocument = 'REMOTE_DOCUMENT'; const calls: string[] = []; const lifecycle: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer private-document-credential') { res.writeHead(403).end(); return; }
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/guide') { res.end('REMOTE_GUIDE'); return; }
    if (req.method === 'PUT') { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); remoteDocument = Buffer.concat(chunks).toString(); }
    res.end(remoteDocument);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const entered = Promise.withResolvers<void>(); const continueRead = Promise.withResolvers<void>();
  const saved = new Map<string, readonly unknown[]>();
  const local: DocumentBackend = {
    async open() { lifecycle.push('local/open'); }, async guide() { return 'LOCAL_GUIDE'; },
    async read(signal) { entered.resolve(); await continueRead.promise; signal.throwIfAborted(); return readFile(file, 'utf8'); },
    async write(text) { await writeFile(file, text); }, async save(records) { saved.set('local', [...records]); lifecycle.push('local/save'); },
    async close() { lifecycle.push('local/close'); },
  };
  const request = async (route: string, signal: AbortSignal, text?: string) => {
    const result = await fetch(endpoint + route, { method: text === undefined ? 'GET' : 'PUT',
      headers: { Authorization: 'Bearer private-document-credential' }, body: text, signal });
    if (!result.ok) throw new Error(`Document service rejected request: ${result.status}`);
    return result.text();
  };
  const remote: DocumentBackend = {
    async open() { lifecycle.push('remote/open'); }, guide: signal => request('/guide', signal), read: signal => request('/document', signal),
    async write(text, signal) { await request('/document', signal, text); },
    async save(records) { saved.set('remote', [...records]); lifecycle.push('remote/save'); }, async close() { lifecycle.push('remote/close'); },
  };
  const counts = new Map<string, number>();
  const { ctx, model } = await nativeHarness(NativeLoop, request => {
    const step = counts.get(request.sessionId!) ?? 0; counts.set(request.sessionId!, step + 1);
    if (step < 3) return { callId: `call-${step}`, name: capabilityName('documents', ['guide', 'read', 'write'][step]), args: step === 2 ? { text: 'UPDATED_DOCUMENT' } : {} };
    return { text: 'COMPLETE' };
  });
  ctx.systemPrompt.section({ name: 'ambient', order: 1, text: 'UNSELECTED_AMBIENT_CONTEXT' });
  ctx.systemPrompt.section({ name: 'ambient-complete', order: 2, complete: true, text: 'UNSELECTED_COMPLETE_OVERRIDE' });
  ctx.systemPrompt.context({ name: 'ambient-required', order: 1, required: true, text: 'UNSELECTED_REQUIRED_CONTEXT' });
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'UNSELECTED_TOOL_SCHEMA', description: 'Ambient tool declaration', parameters: { type: 'object', properties: {} } }] }));
  ctx.on('agent/pre-step', async (_event, next) => {
    const decision = await next();
    if (decision.kind !== 'reject') decision.messages.push(user('UNSELECTED_LATE_INJECTION'));
    return decision;
  });
  const input: ContextConnector<{ 'test/ask': string }> = { id: 'input', events: ['test/ask', 'agent/prepare-step'], async handle(event) {
    const messages = event.type === 'test/ask' ? [user(String(event.data))] : event.type === 'agent/prepare-step' ? event.data.messages : [];
    return messages.length ? [{ op: 'append', key: event.id, value: { messages } }] : [];
  } };
  const notes: ContextConnector = { id: 'notes', events: ['run/initialize'], async handle() {
    return [{ op: 'put', key: 'notes', value: { kind: 'instruction', role: 'system', text: 'UNCHANGED_NOTES' } }];
  } };
  let backend = local; let label = 'LOCAL_SERVICE';
  const registry = new ConnectorRegistry();
  registry.registerProvider({ id: 'services', async list() { return ['documents', 'input', 'notes'].map(id => ({ id, kind: 'enterprise-service', label: id, description: '' })); },
    async connect(binding) { return binding.id === 'documents' ? documentService(binding.id, backend, label) : binding.id === 'input' ? input : notes; } });
  const selection = { version: 1, bindings: ['documents', 'input', 'notes'].map(id => ({ id })) };
  try {
    for (const mode of ['local', 'remote']) {
      backend = mode === 'local' ? local : remote; label = mode === 'local' ? 'LOCAL_SERVICE' : 'REMOTE_SERVICE';
      const prepared = await registry.prepare(selection, { cwd: root });
      assert.strictEqual(prepared.connectors[1], input); assert.strictEqual(prepared.connectors[2], notes);
      const start = model.requests.length;
      const run = await createComposedRun(ctx, { connectors: prepared.connectors, model: { provider: 'fixture', model: 'fixture' }, cwd: root });
      try {
        const completion = run.send('test/ask', 'Read the guide, read the document and update it', 'input').then(receipt => receipt.completed);
        if (mode === 'local') {
          await entered.promise;
          // Must acknowledge while the model's resource request is still pending.
          await run.send('documents/changed', { policy: 'POLICY_CHANGED_DURING_EXECUTION' }, 'documents');
          continueRead.resolve();
        }
        await completion;
        const requests = model.requests.slice(start);
        assert.equal(requests.length, 4);
        assert.match(JSON.stringify(requests[0]), new RegExp(label));
        assert.match(JSON.stringify(requests[0]), /UNCHANGED_NOTES/);
        assert.doesNotMatch(JSON.stringify(requests), /UNSELECTED_AMBIENT_CONTEXT|UNSELECTED_COMPLETE_OVERRIDE|UNSELECTED_REQUIRED_CONTEXT|UNSELECTED_LATE_INJECTION|UNSELECTED_TOOL_SCHEMA|private-document-credential/);
        assert.doesNotMatch(JSON.stringify(requests[0]), /LOCAL_GUIDE|REMOTE_GUIDE/);
        assert.match(JSON.stringify(requests[1]), new RegExp(mode === 'local' ? 'LOCAL_GUIDE' : 'REMOTE_GUIDE'));
        if (mode === 'local') assert.match(JSON.stringify(requests[2]), /POLICY_CHANGED_DURING_EXECUTION/);
        else assert.doesNotMatch(JSON.stringify(requests), /LOCAL_SERVICE|LOCAL_GUIDE|POLICY_CHANGED_DURING_EXECUTION/);
        assert.ok(saved.get(mode)?.length);
      } finally { await run.dispose(); }
    }
    assert.equal(await readFile(file, 'utf8'), 'UPDATED_DOCUMENT'); assert.equal(remoteDocument, 'UPDATED_DOCUMENT');
    assert.deepEqual(calls, ['GET /guide', 'GET /document', 'PUT /document']);
    assert.deepEqual(lifecycle, ['local/open', 'local/save', 'local/close', 'remote/open', 'remote/save', 'remote/close']);
  } finally { continueRead.resolve(); await ctx.fiber.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
