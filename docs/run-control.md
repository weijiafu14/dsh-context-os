# Scoped run control

`RunManager` manages compositions. It does not define application roles or resource-specific processes.

The host creates a manager with its connector registry, then grants an authority:

```ts
const manager = new RunManager(ctx, registry);
const os = manager.scope({
  id: 'persistent-application-identity',
  subject: 'authenticated-user',
  cwd: stateDirectory,
  model,
  canUse: (binding, caller) => authorizeResource(binding, caller),
  canStart: (request, caller) => authorizeComposition(request, caller),
});
```

Providers receive `subject`, `runId`, `signal`, and `os` in their discovery context. The host assigns the connector and parent identity; the provider cannot supply them in a run request.

| Method | Contract |
|---|---|
| `catalog()` | Discover cards filtered by the authority's resource policy. Full binding authorization still runs at start. |
| `start({key, selection, entry, model?})` | Check resource/model grants, create the composition, admit its initial source event, then return its run ID. |
| `send(id, event)` | Admit a source event to a child owned by this connector, or to this connector's own binding in its current run. Reserved runtime events cannot be forged. Returns a receipt with `completed`. |
| `wait(id)` | Await currently admitted inference and persistence. An idle run remains available for later events. This is not a process-exit wait. |
| `stop(id)` | Cancel the run and attached descendants; await cleanup. |

The stable `key` is namespaced by authority, subject, parent run and connector. Concurrent retries share admission. A different composition cannot reuse the same key. A stopped or failed run is not silently recreated under that key; a new application attempt uses a new key.

Run ownership is in-memory. Applications own durable work identity, scheduling and restart policy through their services. They must hold their own persistent instance lock when multiple hosts could operate on the same application state. `dsh-cos-super-agent` exercises this with an upstream SQLite task/effect store and a history connector.

During initialization, return initial context contributions directly. Self-delivery through `send` becomes available after creation; attempting to await it inside initialization fails explicitly rather than deadlocking the run.

The assembly interface remains unchanged: five runtime events and four contribution operations. A connector's source event can append messages or update current instructions; it need not start a model request when it contributes no message.

## Regressions found by the Super-agent integration

- Multi-message source feedback is queued as a complete ordered batch before waking an idle loop.
- Newly created native records, including `session/end-seed` emitted before listener installation, reach record observers. Repeated cold assembly no longer leaves sequence gaps.
- Callable capabilities wait for preceding record observers. An observation/persistence failure prevents further capability execution on that unpersisted input.
- A connector can publish asynchronous source feedback into its own binding, without acquiring another connector's event identity.

These contracts are exercised by `tests/runs.integration.test.ts` and `tests/contracts.integration.test.ts`. The host SDK and providers still run in the same JavaScript process; capability scoping is an API boundary, not isolation from malicious provider code.
