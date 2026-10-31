# Connector protocol and integration

[English overview](../README.md) · [中文介绍](../README.zh-CN.md)

## Providers

The framework entry is `dsh-context-os/core`. It exports `ConnectorRegistry`,
`Composition`, and `createComposedRun(ctx, { connectors, model })` without importing
compatibility catalogs or resource adapters. The root package is the DSH application
plugin; `dsh-context-os/compat` contains explicitly selected legacy adapters.
The build checks this dependency boundary.

A provider constructs a complete connector through `connect()`. Acquiring resources
belongs in its `run/initialize` handler. Catalog `kind` is a display label only;
there are no framework categories for MCP, skills, workspaces or session services.
A connector is `{ id, events, handle(event) }`; its handler returns contributions:

- `put/remove`: maintain its current instruction fragments, callable descriptions or execution projection.
- `append`: add native input messages, or native replay records during initialization.
- `answer`: return the canonical value and optional rendered content for its own correlated request.

The runtime forwards `run/initialize`, `agent/prepare-step`, `tools/execute`,
`session/event`, and `run/settled`. External sources choose their own event names;
`run.send(type, data, owner)` always returns an admission receipt, whether idle or busy. Await its `completed` promise for execution, child work and persistence to finish. Receipts admitted during the same active execution share that completion; execution or persistence failures reject it for every caller. An idle context-only update completes immediately without starting a model turn. Feedback becomes part of the next prepared model request. The event set is not expanded
for each resource type. Preparation happens before native tool and prompt snapshots.
System fragments are combined; developer and user context retain their roles. Updating/removing a current instruction replaces its model-visible snapshot using durable DSH surface replacements; the original audit log and call/result relationships remain intact. Unchanged snapshots are reused. Replacing earlier content can invalidate the corresponding cache prefix; `append` is the explicit history-growing operation. `run/settled` carries `closing: true` when the run scope is disposed; a provider can flush per turn and release its own resources on final closure. An unpatched direct runtime is rejected before the model call.

```typescript
const receipt = await run.send(
  'documents/changed', { policy: 'Use the updated review policy.' }, 'documents',
);
await receipt.completed;
```

Record and settlement handlers may return ordinary contributions. Record feedback affects the
next prepared request; settlement feedback waits for the next explicitly started turn and never
starts a recursive model call. Final `closing` feedback has no subsequent request to affect.
All record/settlement subscribers are attempted even when one fails.

Handlers can overlap with owned capability execution. Current-state updates are ordered by
delivery start: if a newer delivery has written any key in an older reply's `put/remove` batch,
the older current-state batch is discarded. Its valid `answer` and appended facts remain valid;
external I/O is never automatically retried. Removal retains a revision tombstone. This is a
context-state guarantee, not a transaction or concurrency lock for the provider's external resources.

Known events have discriminated payload/request types. Declare custom source payloads using
`ContextConnector<{ 'documents/changed': { version: number } }>`; event-name checks then narrow
`event.data` directly. Tool arguments remain JSON values validated against the contributed schema.

The composer UI and integrating hosts use this entry when started through
the native bridge. **One selected resource service is one connector**, owning its
instructions, capabilities, request handling and settlement. The runtime does not
split those into instruction, tool, history-input and output connectors.

Native workspace and MCP adapters retain their own system/context descriptions.
Each selected skill service owns its index and lazy reader; readers have stable,
resource-specific names so multiple providers do not share a global dispatcher.
A selected native session service owns replay and final flush. PTC owns its native
execution projection. Prompt and agent coordination are host default services.
The earlier instruction/tool-only helper factories are no longer public exports.

An installed, trusted DSH plugin can register an event-based provider:

```typescript
import { registerConnector } from 'dsh-context-os';

// Supply loadTeamGuidelines from the service implementation.
export const inject = ['contextConnectors'];
export function apply(ctx) {
  registerConnector(ctx, {
    id: 'team-knowledge',
    async list() {
      return [{ id: 'team:guidelines', kind: 'custom', label: 'Team guidelines', description: 'Current team guidance' }];
    },
    async connect(binding) {
      return {
        id: binding.id,
        events: ['run/initialize', 'agent/prepare-step'],
        async handle(event) {
          const text = await loadTeamGuidelines({ signal: event.signal });
          return [{ op: 'put', key: 'guidelines',
            value: { kind: 'instruction', role: 'user', text } }];
        },
      };
    },
  });
}
```

The provider owns authentication, conversion and service behavior. Choose instruction
authority according to the host's policy; external text is not automatically system guidance.
Dependencies and scope cleanup use Cordis. The native adapter preserves the original
execution context, activation predicates, permissions, output rendering and cancellation.
It contains version-pinned internal DSH ABI access; that ABI is not part of the public protocol.

Earlier `prepare()` providers must explicitly use `adaptLegacyProvider(ctx, provider)`
from `dsh-context-os/compat`. Their old fields never enter the core registry;
the adapter constructs one complete handler and defers acquisition to initialization. New providers use
`connect()`; no new resource-specific fields or windows are required. The earlier
`stepInputWindow/connectContext` experiment is no longer exported from the package entry.

Selected composition metadata uses DSH's experimental plugin-record facility so a fresh process can restore the selection. Compatibility is pinned to the tested Session format; migration across future DSH formats requires revalidation. Start-request deduplication currently lasts for the Host process lifetime.

Only public descriptors and user-entered selection fields cross the browser boundary. Do not put credentials in descriptors or binding configuration. Connector IDs must be unique; the server validates each selection against a freshly discovered catalog.

## Host integration

`ConnectorComposer` is exported from `dsh-context-os/ui`; it depends only on React and the public selection types. Hosts provide `loadCatalog` and either `onRun` or `onApply`. Dragging and the keyboard-accessible add buttons use the same selection model. A custom host retains responsibility for identity, authorization, session persistence and execution environment provisioning.

The core registry accepts connector instances constructed by providers. Selection validation checks
identity and configuration, not display categories. Runtime conflict checks operate
on actual contributions: callable names, execution projections and native replay
ownership. Invalid contribution batches do not partially change the current context.
The DSH bridge commits an explicit admission snapshot. Ambient native prompts, required
contexts, complete-prompt overrides, extra tool declarations and late pre-step messages
cannot overwrite that snapshot. Legacy middleware can still mutate its own draft. Source-specific conversion lives in compatibility
adapters or service implementations.

[`examples/documentService.ts`](../examples/documentService.ts) demonstrates a complete service: description, application
policy, lazy usage guide, reads, writes, external updates, recording, saving and cleanup
all use one connector. It imports the core protocol without MCP or skill adapters.

## Validation

Run `npm run verify` from this package directory with `DSH_SOURCE_ROOT` pointing to the prebuilt revision. This checks the package, native runtime workflows, and consumer type contracts. `npm run export:source` creates an independent source archive containing the framework, adapters, UI, examples, scripts, tests and source proposal; build output, local sessions and host application code are excluded. Unit tests alone are not evidence that the DSH Web install path or a remote execution provider has been exercised.
