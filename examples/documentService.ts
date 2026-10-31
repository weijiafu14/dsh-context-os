/** A complete document service. No MCP/skill adapter or native tool registry is used. */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContextConnector, Contribution } from 'dsh-context-os/core';

export interface DocumentBackend {
  open(signal: AbortSignal): Promise<void>;
  guide(signal: AbortSignal): Promise<string>;
  read(signal: AbortSignal): Promise<string>;
  write(text: string, signal: AbortSignal): Promise<void>;
  save(records: readonly unknown[]): Promise<void>;
  close(): Promise<void>;
}
export function documentService(id: string, backend: DocumentBackend, description: string): ContextConnector<{ 'documents/changed': { policy: string } }> {
  let policy = 'Initial document policy';
  const records: unknown[] = [];
  let closed = false;
  const current = (): Contribution[] => [
    { op: 'put', key: 'description', value: { kind: 'instruction', role: 'system', text: description } },
    { op: 'put', key: 'policy', value: { kind: 'instruction', role: 'developer', text: policy } },
    ...['guide', 'read', 'write'].map((key): Contribution => ({ op: 'put', key, value: {
      kind: 'capability', description: `${key} for ${id}`,
      parameters: key === 'write'
        ? { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
        : { type: 'object', additionalProperties: false, properties: {} },
      output: { type: 'string' },
    } })),
  ];
  return { id, events: ['run/initialize', 'agent/prepare-step', 'tools/execute', 'session/event', 'run/settled', 'documents/changed'],
    async handle(event) {
      if (event.type === 'run/initialize') { await backend.open(event.signal); return current(); }
      if (event.type === 'agent/prepare-step') return current();
      if (event.type === 'documents/changed') {
        policy = event.data.policy;
        return [...current(), { op: 'append', key: event.id, value: { messages: [createUserMessage({ source: { kind: 'user' },
          content: [{ type: 'text', text: 'The document service has updated its policy.' }] })] } }];
      }
      if (event.type === 'tools/execute') {
        const key = event.request.key;
        let value: string;
        if (key === 'guide') value = await backend.guide(event.signal);
        else if (key === 'read') value = await backend.read(event.signal);
        else if (key === 'write') {
          await backend.write((event.data.arguments as { text: string }).text, event.signal);
          value = 'Document updated';
        } else throw new Error('Unknown document operation');
        return [{ op: 'answer', requestId: event.request.id, value }];
      }
      if (event.type === 'session/event') { records.push(event.data.record); return; }
      if (event.type === 'run/settled') {
        if (event.data.closing) {
          if (!closed) { closed = true; await backend.close(); }
        } else { await backend.save(records); records.length = 0; }
      }
    },
  };
}
