# Named profiles and session ownership

Use **Profiles** to create or edit Coding, Documents, Research, Databases or your own named toolbox. Each profile has a stable ID, enabled servers and capability types, delivery settings, process ownership and idle expiry. Saving a profile never changes the existing server startup checkboxes or the default gateway's delivery settings.

The default endpoint remains `/mcp` (or your configured MCP path). Named endpoints append `/profiles/<id>`. Every public endpoint uses the same gateway authentication policy. A profile is a configuration boundary, not a separate authorization grant: someone with the gateway key can connect to another published profile or the default endpoint. Both discovery and invocation enforce the selected profile's server subset.

## Connecting

Select a saved profile, inspect **Connect a client**, and choose Streamable HTTP or the stdio bridge. The preview contains a key placeholder. **Copy configuration** deliberately puts the actual gateway key in the clipboard when authentication is enabled. Paste it only into the intended client configuration. Exporting configuration does not configure the client application automatically.

**Test connection** opens an actual MCP session using the saved gateway credentials, initializes it and lists enabled tools, resources, resource templates and prompts. It reports their counts and any partial catalog failures, then closes the test session. It invokes no application tool and does not read resource content or retrieve a prompt. Process isolation starts selected native children for this test; discovery modes may initialize their configured search service. A successful protocol test does not establish compatibility with a particular third-party client UI or model. Installed LM Studio 0.4.21+2 has separate [native tool-execution evidence](lmstudio-diagnostics.md#acceptance-status); that trial does not certify every profile, client version or model.

## What is isolated

- **Shared:** clients borrow the selected existing upstream connections and share their mutable state. Start/Stop and saved startup choices remain the server manager's responsibility. Expiring or disconnecting a profile session never stops those shared children.
- **Separate native process per client session:** Harbor copies the selected native stdio configurations and starts children owned by that session. Two public client sessions receive separate PIDs and process state. This supports native stdio servers only; remote and WSL selections are rejected rather than silently sharing.

Separate processes may still use the same configured directory, files, browser profile, database, credentials or remote service. Harbor shows this limitation for each server. No filesystem, account or remote-service isolation is claimed. Resource/prompt selections now control the gateway's negotiated capabilities and forwarding routes. The selected running upstream must support the requested operation. See the [MCP capability matrix](mcp-capabilities.md) for subscriptions, limits and unsupported features.

## Revisions and lifecycle

Every edit creates a monotonic revision. Existing connections keep their server selection, delivery settings and ownership policy from initialization. Reconnect to apply edits. The default endpoint retains its existing live-settings behavior. Deleting a profile disconnects its existing sessions. **Disconnect profile sessions** closes its public sessions and cleans up only its owned children/search workers. Gateway credential changes revoke public sessions and cancel profile startup. Maintenance stops owned profile children before performing component changes.

Public sessions expire after the configured idle interval (1–1440 minutes; default 15). Active and queued requests prevent idle expiry. Closing a client's transport does not always send MCP session termination; explicitly terminating it frees ownership promptly, otherwise expiry provides cleanup. Internal discovery sessions cannot extend an owner's lifetime.

Admission defaults: 128 public sessions, 32 active requests, 128 queued requests, at most 8 active requests per session, and 30 seconds in the queue. Internal search-to-catalog requests have a separate bounded pool to avoid reentry deadlocks. Rejected, expired or cancelled queued calls are never dispatched or retried. Cancellation after an upstream mutation starts can still leave its outcome unknown.

Provider keys remain local files. Replacing a profile key preserves the old file while a saved profile, default delivery setting, initializing session, connected session or retiring worker still references it. Once the last reference is released, Harbor removes the obsolete generated profile key. Startup also removes generated profile keys left unreferenced after an interrupted save or previous shutdown. Failed or stale saves preserve the committed credential.

Cleanup is limited to the generated UUID key filenames inside `profile-credentials/<profile-id>/auth/embeddings`. It skips symbolic links and junctions, does not recursively remove directories, and leaves user-selected external key files and the default delivery key directory alone. A cleanup failure leaves the file in place, logs a generic warning without its content, and is retried at a later cleanup. Request traces register saved profile credential values for redaction; arbitrary secret content still requires review before export.

## Evidence

Core tests use real SDK clients and child processes to check filtering, endpoint binding, shared ownership, separate PIDs, revision retention, deletion, bounded admission, expiry and cancelled startup. Credential tests cover two-client retention, cross-profile references, startup orphans, failed saves, in-flight file reservations and junction preservation. The runtime-enabled test covers simultaneous All-tools and Hybrid profiles with distinct server subsets and actual FastMCP search. The native Electron test exercises save, connection testing, clipboard export, revision changes, key replacement and cleanup, Hybrid validation, disconnect, restart persistence and deletion through visible controls. These checks do not replace clean-machine Portable or named third-party-client acceptance.
