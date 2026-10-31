/** Compile-only contract: known events narrow without assertions, custom sources retain their payloads. */
import type { ContextConnector, ConnectorEvent } from '../src/composition.ts';
import type { SendReceipt } from '../src/composedRun.ts';
import { ConnectorRegistry } from '../src/registry.ts';

const service: ContextConnector<{ 'documents/changed': { version: number } }> = {
  id: 'documents', events: ['run/initialize', 'tools/execute', 'session/event', 'documents/changed'],
  async handle(event) {
    if (event.type === 'tools/execute') {
      const key: string = event.request.key;
      // @ts-expect-error tool execution is not a session record
      event.data.record;
      return [{ op: 'answer', requestId: event.request.id, value: key }];
    }
    if (event.type === 'session/event') {
      const type: string = event.data.record.type;
      // @ts-expect-error records have no owned pending request
      event.request.id;
      return [{ op: 'put', key: 'last-record', value: { kind: 'instruction', role: 'user', text: type } }];
    }
    if (event.type === 'documents/changed') {
      const version: number = event.data.version;
      // @ts-expect-error custom payload is number, not string
      const text: string = event.data.version;
      void text; void version;
    }
    if (event.type === 'run/initialize') {
      const restored: boolean = event.data.restoring;
      void restored;
    }
  },
};
const selected: ContextConnector[] = [service];
const registry = new ConnectorRegistry();
registry.registerProvider({ id: 'docs', async list() { return []; }, async connect() { return service; } });
function runtime(event: ConnectorEvent, receipt: SendReceipt) {
  if (event.type === 'agent/prepare-step') {
    const step: number = event.data.step;
    void step;
  }
  // @ts-expect-error completion is a promise; admission is not a finished outcome
  receipt.completed.kind;
}
void selected; void runtime;
