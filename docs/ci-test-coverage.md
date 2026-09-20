# Final CI test coverage

Runtime source `f2c8c97`. [Successful Windows/Linux run](https://github.com/csorrells42/Harbor/actions/runs/35501681851).

Windows: 441 passed, 33 skipped, zero failures. Linux: 434 passed, 40 skipped, zero failures. Each platform also passed five UI checks and its distribution build. Skipped tests are not credited as passes.

The Linux skips are listed below exactly as named in the test output. Windows-only checks cannot establish Linux behavior. Installed-harness, native desktop and bundled-toolbox checks require their documented local environment or explicit opt-in and retain separate local evidence. The port-80 check explicitly reported that the port was unavailable.

## Windows-specific (6)

- Windows npm-style shim preserves literal metacharacter argv without injection
- Windows managed npm/npx .cmd shims launch under ownership
- Windows supervisor crash acknowledges an empty job before close resolves
- Windows ownership lease can close before launch readiness without starting a survivor
- Windows stop reaps the owned process tree, including children that ignore stdin
- Windows ownership lock recovers confirmed-dead owners and preserves live or unknown owners

## WSL-specific (2)

- WSL bootstrap refuses user code when its cleanup acknowledgement cannot be written
- actual WSL launcher abrupt death reaps detached Linux descendants before close resolves

## Unavailable listener (1)

- HTTP default port remains a valid persistent port and accepts standard SDK Host formatting

## Optional installed-runtime and native integration checks (31)

- native Diagnostics runs all six task kinds and reloads independently graded results
- native catalog comparison preserves real outcomes and captures transformed outbound definitions
- real Hybrid search indexes the transformed catalog and invokes only its selected provider
- installed Hermes verifies an empty curated catalog without enabling unrelated tools
- installed Hermes executes real MCP tools in isolated state against a llamacpp protocol fixture
- installed Hermes executes real MCP tools in isolated state against a lmstudio protocol fixture
- installed Python verifies GGUF bytes and live model properties without activating models or exporting secrets
- diagnostic fixtures run through actual local delivery modes
- installed OpenClaw executes real Harbor tools and cancels a pending model request in isolated state
- Diagnostics tab in the real Electron window uses backend IPC and preserves primary settings
- native representative campaign runs real file, SQLite and Chromium tasks through installed Hermes
- real Chromium navigates the local fixture, renders values, saves output and leaves proof
- authenticated FastMCP modes use a private catalog key and survive public key rotation
- native gateway key controls protect HTTP and bridge clients, rotate keys and persist without exposing secrets
- All and Hybrid profiles retain independent discovery catalogs and enforce invocation filtering
- FastMCP candidate listeners allow only their private catalog during a protection transition
- real Hybrid traces retain per-method ranks and fused order without recording the query
- portable launcher shows its native window on the first invocation
- native maintenance keeps build controls unavailable until real child shutdown finishes
- native Advisor reads real saved evidence, withholds unsupported advice and clears only opted-in history
- native activation controls preserve a dormant catalog across restart and start only for a real invocation
- real Hybrid search returns dormant cached tools without activating their server; selected invocation starts it once
- native profile capability controls, real connection counts and revision-specific MCP reads work end to end
- old and new profile revisions actually authenticate semantic requests with their retained credentials
- native profile controls save, test, copy, retain session revisions and persist across restart
- Hybrid retains one semantic index per provider and invalidates only changed indexes
- all four bundled models find a paraphrased PDF action offline
- hosted transports work against local mock, hybrid deduplicates and reports partial failure
- a semantic worker crash during queued writes does not crash Harbor and the next request recovers
- native timeline uses real IPC, traces calls, previews/saves the exact export and persists retention
- FastMCP modes share children, refresh catalogs, preserve errors and survive restart
