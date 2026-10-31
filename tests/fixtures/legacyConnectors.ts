/** Earlier fixtures retained only to regression-test the low-level native ABI bridge. */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { bindNativeDefinitions, executeNative } from '../../src/nativeBindings.ts';
import type { ContextConnector, Contribution } from '../../src/composition.ts';

const initialize = 'run/initialize';
const prepare = 'agent/prepare-step';
const execute = 'tools/execute';
const settled = 'run/settled';

/** The source owns its event name and message conversion, including images/attachments. */
export function messageConnector(id: string, eventName = 'chat/submit', convert: (input: unknown) => readonly UserMessage[] = input => [
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: String(input) }] }),
]): ContextConnector {
  return { id, events: [eventName, prepare], async handle(event) {
    const messages = event.type === prepare ? (event.data as { messages: readonly UserMessage[] }).messages : convert(event.data);
    return messages.length ? [{ op: 'append', key: event.id, value: { messages } }] : [];
  } };
}

export function instructionConnector(id: string, role: 'system' | 'developer' | 'user', load: (signal: AbortSignal) => Promise<string>): ContextConnector {
  return { id, events: [initialize, prepare], async handle(event) {
    return [{ op: 'put', key: 'instructions', value: { kind: 'instruction', role, text: await load(event.signal) } }];
  } };
}

export interface HistorySource {
  load?(signal: AbortSignal): Promise<readonly SessionEvent[]>;
  record?(runId: string, record: SessionEvent): Promise<void>;
  save?(runId: string, events: readonly SessionEvent[], outcome: unknown): Promise<void>;
}

export function historyConnector(id: string, source: HistorySource): ContextConnector {
  return { id, events: [initialize, 'session/event', settled], async handle(event) {
    if (event.type === initialize && source.load && !(event.data as { restoring?: boolean }).restoring) return [{ op: 'append', key: 'history', value: { records: await source.load(event.signal) } }];
    if (event.type === 'session/event') await source.record?.(event.runId, (event.data as { record: SessionEvent }).record);
    if (event.type === settled) {
      const data = event.data as { events: SessionEvent[]; outcome: unknown };
      await source.save?.(event.runId, data.events, data.outcome);
    }
  } };
}

/** Shared adapter for native files/shell, MCP, subagents, questions, todo and jobs. */
export function nativeToolsConnector(id: string, load: (signal: AbortSignal) => Promise<readonly ToolDefinition[]>): ContextConnector {
  let tools = new Map<string, ToolDefinition>();
  const connector: ContextConnector = { id, events: [initialize, prepare, execute], async handle(event) {
    if (event.type === execute) {
      const tool = tools.get(event.request!.key);
      if (!tool) throw new Error('Selected capability is no longer available');
      return [{ op: 'answer', requestId: event.request!.id, value: await executeNative(event, tool) as JsonValue }];
    }
    const next = new Map((await load(event.signal)).map(tool => [tool.name, tool]));
    const changes: Contribution[] = [...tools.keys()].filter(key => !next.has(key)).map(key => ({ op: 'remove', key }));
    for (const tool of next.values()) changes.push({ op: 'put', key: tool.name, value: {
      kind: 'capability', name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema,
    } });
    tools = next; bindNativeDefinitions(connector, tools);
    return changes;
  } };
  return connector;
}

export interface SkillSource {
  list(signal: AbortSignal): Promise<readonly { name: string; description: string }[]>;
  read(name: string, signal: AbortSignal): Promise<string>;
}

/** Index and lazy body share the same contribution protocol; no filesystem dependency. */
export function skillConnector(id: string, source: SkillSource): ContextConnector {
  let available = new Set<string>();
  return { id, events: [initialize, prepare, execute], async handle(event) {
    if (event.type === execute) {
      const name = (event.data.arguments as { name: string }).name;
      if (!available.has(name)) throw new Error('Skill was not selected');
      const text = await source.read(name, event.signal);
      return [{ op: 'answer', requestId: event.request!.id, value: { text }, content: [{ type: 'text', text }] }];
    }
    const list = await source.list(event.signal); available = new Set(list.map(item => item.name));
    return [
      { op: 'put', key: 'index', value: { kind: 'instruction', role: 'user', text: 'Selected skills (call skill to read their instructions):\n' + list.map(item => `${item.name}: ${item.description}`).join('\n') } },
      { op: 'put', key: 'load', value: { kind: 'capability', name: 'skill', description: 'Read instructions for a selected skill.',
        parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
        output: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      } },
    ];
  } };
}

export function projectionConnector(id: string, service: string): ContextConnector {
  return { id, events: [initialize], async handle() { return [{ op: 'put', key: 'projection', value: { kind: 'projection', service } }]; } };
}
