# On-demand server activation

The server editor separates three choices:

- **Enabled for use** permits the server's tools to be exposed and invoked. A disabled server cannot start manually, automatically or on demand.
- **Start automatically when Harbor opens** keeps the existing startup workflow. A server started manually or at application startup is not stopped by the on-demand idle policy.
- **Eligible for on-demand start** lets an invocation activate a stopped server using its saved configuration. This is off for legacy and newly imported configurations until explicitly selected.

Start a server once to discover its tools. Harbor persists the last successfully observed catalog in `catalog-cache.json`, with a schema version, observation time, catalog hash and hash of the launch configuration. The cache contains tool contracts, not environment values or credential contents. Tool descriptions and schemas are upstream-provided content and may themselves contain sensitive information; the cache is local profile data, not a public release asset.

After restarting Harbor, eligible stopped servers can expose that catalog without starting processes. Ordinary discovery, including semantic/Hybrid search, reads these cached definitions. Search does not install or download servers. An actual invocation starts only the selected configured server and waits for live discovery. First-use startup can add latency or fail because the configured executable, service, credentials or dependencies are unavailable.

Concurrent calls share a startup attempt. Cancelling one waiting caller leaves another caller's attempt intact; cancelling the last waits for the owned startup to be cleaned up. A failed readiness attempt is reported to all current waiters and is not automatically retried. A later explicit call may make another attempt.

Cached contracts are advisory. If the live tool disappears or its definition changes, the call fails with a refresh-discovery instruction before dispatch. On-demand calls validate arguments against the live input schema. Unsupported schemas fail explicitly. Upstream errors and uncertain mutation outcomes are never replayed automatically.

Changing a launch command, arguments, environment, endpoint or managed-process specification invalidates its cache. Removing a server removes its entry. Entering maintenance invalidates catalogs before updates; servers must be started again to observe fresh contracts. Renaming a server or changing only activation settings retains its previously observed catalog. An out-of-band upstream update may remain visible as stale cached discovery until live startup detects the changed contract.

**Stop** suppresses on-demand activation in the current session. Explicit Start, a configuration save or restarting Harbor clears that temporary suppression; the saved eligibility choice remains visible. To disable use across restarts, clear on-demand/startup choices and then **Enabled for use**. The server card distinguishes cached tools, temporary suppression and a process owned by on-demand activation. Disabled servers have unavailable Start/Restart controls with an explanation.

Idle shutdown is 1–1440 minutes, default 5, checked every 10 seconds. It applies only to a process/connection created on demand, after active calls finish and no named shared profile session retains that server. A named shared profile keeps its selected servers available for its connected session's lifetime. Existing per-session process-isolation profiles keep their eager startup/session ownership behavior. Externally managed HTTP/SSE servers lose only Harbor's connection; Harbor does not stop an external application's process.

A timeout, cancellation after dispatch or lost response may leave the upstream operation running. Harbor marks the outcome unknown and suspends automatic idle shutdown for that process. Inspect the operation's effects before choosing Stop, Restart or a configuration change to reset ownership. A later successful call does not prove that the earlier operation ended and does not silently clear this condition.

The cache is bounded to 8 MiB on disk and validates its version, hashed identities, namespaces and tool contracts on load. Invalid files are discarded with an Activity warning; start the server to refresh. It is not a trusted upstream release manifest. Final packaged acceptance, broader installed-component performance measurements and ongoing regression evidence remain separately tracked in Phase 2.
