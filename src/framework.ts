/** Public framework entry: no compatibility catalogs or resource-specific adapters. */
export { Composition } from './composition.ts';
export type { ContextConnector, ConnectorEvent, Contribution, CurrentContribution, OwnedCurrent, Answer, RuntimeEventData, ConnectorRequest } from './composition.ts';
export { ConnectorRegistry } from './registry.ts';
export type { ConnectorProvider, DiscoveryContext, PreparedComposition } from './registry.ts';
export { createComposedRun, capabilityName } from './composedRun.ts';
export type { ComposedRunOptions, SendReceipt } from './composedRun.ts';
export { parseSelection, validateSelection, moveBinding } from './core.ts';
export type * from './core.ts';
