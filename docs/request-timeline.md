# Request timeline (Phase 2 development)

The source application now includes **Request timeline** in the sidebar. It observes Harbor's request handling, discovery and upstream calls. The installed Portable release is updated only after the complete Phase 2 release acceptance.

## Normal use

1. Open Request timeline and connect a client. Metadata capture is enabled by default.
2. Make a real request. Expand an event to inspect its request/session identifiers, client, profile revision, delivery configuration, tool/server, outcome and elapsed time.
3. Use the text filter to find a session, tool, server or outcome.
4. Expand **Capture and retention settings** to change capture mode, memory/event limits or retention. Apply the settings explicitly.
5. To capture arguments and results, select **Metadata and payloads** and acknowledge the displayed content warning. An active banner indicates payload capture. Every application launch returns a previously enabled payload mode to metadata.
6. Select **Preview export** to freeze a local JSON diagnostic bundle. Page through the preview, then **Save previewed export** to choose its destination. The saved bytes match that preview even if new calls arrive.
7. **Clear traces** immediately removes retained events and invalidates outstanding previews. Calls already running cannot repopulate their old completion records after the clear.

There is no replay control. Harbor does not repeat a timed-out or cancelled mutation.

## What the events mean

A start and a completion are separate chronological events with one span ID. Nested execution has a parent span ID and shares a request ID. The default route records profile `default`; named routes record their profile identity and the revision retained by that client session.

Concurrent client sessions keep separate identifiers. Independent discovery and invocation requests have `association: unknown`. Harbor cannot see private model reasoning or infer that a preceding search caused a later invocation. FastMCP's private catalog connections are identified as internal and keep their own observed requests; no model-to-worker causal link is invented.

Hybrid metadata records the participating methods, failed methods, returned candidate names, their per-method ranks, reciprocal-rank scores and final ordering. Metadata does not retain the search query, tool arguments, tool results or arbitrary error messages. Large candidate sets and payloads are bounded and may be truncated. Inspect counts and truncation indicators.

Outcomes distinguish success, invalid arguments when established by the protocol, search failure, upstream failure, timeout and cancellation. A timeout/cancellation records an unknown mutation outcome. A tool returning an error is not an independently verified task failure; task completion remains the Diagnostics verifier's job.

## Bounds and privacy

Defaults are 1,000 retained events, 4 MiB of serialized events, 60 minutes of retention, 8 KiB per captured input/result, and a 200-event live view. Settings permit at most 10,000 events, 32 MiB, 24 hours and 64 KiB per input/result. Expanded live details are limited to 16 KiB; the complete retained event is available in the paginated export preview.

Events live only in memory. Capture/retention preferences are stored in `trace-settings.json` beside the server configuration. Restart clears events. Export occurs only through the explicit preview/save workflow. The preview expires after five minutes or a settings change/clear; it is not uploaded.

Known gateway keys, configured secret environment values and prepared delivery-provider keys are redacted. Conventional credential field names, Bearer tokens and embedded URL passwords are also redacted; binary payload fields are omitted. Ordinary log messages use the same known-value redaction. Arbitrary free text may still contain other private content. Payload capture is therefore opt-in and exports must be inspected before sharing.

The trace store and UI are bounded. Gateway admission also uses bounded active and queued requests, per-session limits, expiry and cancellation. Cancelled or expired queued work does not dispatch. Profile contexts track shared and isolated ownership; request cancellation links are removed when an operation settles, so completed work does not retain a closed client session.

## Verification and measurements

Source tests use real MCP SDK HTTP/stdio clients and a disposable child process, not simulated dispatch counts. They exercise concurrent routing, actual failures, timeout/cancellation without retry, private-value omission, payload redaction and frozen export semantics. A separate native Electron test operates the actual controls through IPC, verifies the saved export bytes and checks retention persistence plus payload reset after relaunch. Its file-dialog selection is directed to a disposable test destination.

The native screenshot was visually reviewed. Actual installed FastMCP BM25/Regex Hybrid discovery was exercised from a disposable runtime profile; per-method ranks and fusion were checked.

Reproduce the focused checks from the source checkout:

```powershell
node --test tests/request-traces.test.mjs tests/gateway-traces.test.mjs
$env:HARBOR_TEST_TIMELINE='1'
node --test tests/timeline-desktop.test.mjs
node scripts/benchmark-traces.mjs trace-overhead.json
```

Set `HARBOR_TOOL_RUNTIME_ROOT` to a prepared Portable runtime to enable the real Hybrid test. It stages a separate profile and does not use the live server configuration.

The overhead helper makes 1,350 sequential loopback MCP echo calls plus 30 warmups in three balanced-order rounds across off, metadata and payload capture. It records CPU, gateway-process RSS, retained bytes, median and p95 latency with hardware/runtime identity. It contains no model inference or external-service traffic. Small negative timing differences are noise, not evidence that tracing accelerates tool calls. Full concurrent throughput, process-tree memory and soak acceptance remain later Phase 2 requirements.
