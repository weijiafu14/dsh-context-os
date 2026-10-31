/** Internal DSH ABI bridge. It does not add events or contribution operations. */
import type { ToolDefinition, ToolRunContext, ToolRegistrationOptions } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ScopeKey } from '@deepseek-ai/dsh-scope';
import type { ConnectorEvent, ContextConnector } from './composition.ts';

interface NativeBridgeState {
  definitions: WeakMap<ContextConnector, ReadonlyMap<string, ToolDefinition>>;
  invocations: Map<string, { execution: ToolRunContext; definition?: ToolDefinition }>;
  activations: WeakMap<ToolDefinition, ToolRegistrationOptions['when']>;
}
// Installed plugins and JoyGen's bundled host entry can contain separate copies.
// One process-local bridge keeps native ABI identities shared across those copies.
const bridgeKey = Symbol.for('dsh.context-composition.native.v1');
const globalBridge = globalThis as typeof globalThis & { [bridgeKey]?: NativeBridgeState };
const { definitions, invocations, activations } = globalBridge[bridgeKey] ??= {
  definitions: new WeakMap(), invocations: new Map(), activations: new WeakMap(),
};

/** Read the pinned native registration view so activation predicates are not lost.
 * This ABI is deliberately confined to the native adapter; it is not a connector API.
 */
export function captureNativeTools(ctx: Context, names: readonly string[], scope?: ScopeKey): ToolDefinition[] {
  const tools = ctx.tools as unknown as { view(scope?: ScopeKey): { registrations: Map<string, { definition: ToolDefinition; when?: ToolRegistrationOptions['when'] }> } };
  if (typeof tools.view !== 'function') throw new Error('Native tool registration ABI changed');
  const registrations = tools.view(scope).registrations;
  return names.map(name => {
    const registration = registrations.get(name);
    if (!registration) throw new Error(`Native capability unavailable: ${name}`);
    activations.set(registration.definition, registration.when);
    return registration.definition;
  });
}

export const nativeActivation = (definition?: ToolDefinition): ToolRegistrationOptions['when'] => definition ? activations.get(definition) : undefined;

export function bindNativeDefinitions(connector: ContextConnector, values: ReadonlyMap<string, ToolDefinition>): void {
  definitions.set(connector, values);
}
/** A compatibility proxy preserves the same service identity and native ABI. */
export function copyNativeBindings(source: ContextConnector, target: ContextConnector): void {
  const values = definitions.get(source);
  if (values) definitions.set(target, values);
}

export function nativeDefinition(connectors: readonly ContextConnector[], owner: string, key: string): ToolDefinition | undefined {
  const connector = connectors.find(item => item.id === owner);
  return connector ? definitions.get(connector)?.get(key) : undefined;
}

export async function withNativeInvocation<T>(id: string, execution: ToolRunContext, operation: () => Promise<T>, definition?: ToolDefinition): Promise<T> {
  invocations.set(id, { execution, definition });
  try { return await operation(); } finally { invocations.delete(id); }
}

export function executeNative(event: ConnectorEvent, definition: ToolDefinition): Promise<unknown> {
  const binding = event.request && invocations.get(event.request.id);
  const execution = binding?.execution;
  if (!execution || execution.callId !== event.request?.callId) throw new Error('Native invocation is unavailable outside its owning request');
  return (binding?.definition ?? definition).execute((event.data as { arguments: unknown }).arguments, execution);
}
