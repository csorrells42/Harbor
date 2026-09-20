# Lifecycle acceptance

The gateway's lifecycle tests use real SDK connections and disposable child processes where process ownership matters. They do not load language models or operate on personal documents.

## Active-work checks added September 20, 2026

Three focused active-call checks passed locally on Windows without skips:

- Save a changed profile while its original shared upstream call is deliberately held open. The old request completes once under the old revision; a newly connected client receives the new revision and cannot invoke the old profile's tool.
- Repeat that scenario with a separate native process per session. The old and new sessions retain distinct owned processes and the correct results.
- Enter maintenance while a real upstream request is held open. The request fails, the child is reaped, maintenance becomes ready, and an explicit resume accepts a new request without replaying the interrupted one.

The [controlled fixture](../tests/fixtures/gated-profile-server.mjs) signals that the real upstream has entered a request before the [test](../tests/profile-active-call.test.mjs) edits a profile or starts maintenance. It does not infer concurrency from a short sleep.

The extended [semantic cache check](../tests/semantic-cache-regression.test.mjs) also passed locally without skips using the bundled search package and a local mock embedding provider. It holds an embedding response while another search queues a replacement catalog, then verifies both request results and the retained new index. No remote provider or local language model is used. This test needs the Portable tool runtime and is explicitly skipped in CI environments without it.

## Related coverage

| Requirement | Evidence in the test suite |
| --- | --- |
| Bounded queues, concurrency, cancellation and idle expiry | [Scheduler](../tests/request-scheduler.test.mjs), [gateway admission](../tests/gateway-admission.test.mjs), [request lifetime](../tests/request-cancellation.test.mjs) |
| Shutdown during startup and upstream disappearance | [Core lifecycle](../tests/core.test.mjs), [managed processes](../tests/core-managed.test.mjs) |
| Client disconnect and child ownership | [Profile sessions](../tests/gateway-profiles.test.mjs), [isolated startup](../tests/profile-runtime.test.mjs) |
| Maintenance readiness, queued resume and rollback | [Drain regressions](../tests/hub-maintenance-regression.test.mjs), [rollback ownership](../tests/maintenance-rollback-lifecycle.test.mjs) |
| Worker failure and recovery | [Semantic worker failure](../tests/semantic-worker-lifecycle-regression.test.mjs) |

The preceding application source passed Windows/Linux CI at `c7f5ec7`; these later additions change test coverage and documentation only. Their focused local results supplement that run rather than retroactively changing its test count. See [Phase 2 status](PHASE2-STATUS.md) for the exact CI run and packaged acceptance boundaries.

Ownership rules are documented in [profiles](profiles.md) and [on-demand startup](on-demand.md). A timed-out or interrupted tool operation may have an unknown external effect; stopping a process does not roll back work it already performed. The tests establish the specified fixture behavior, not rollback guarantees for every upstream application. Independent clean-machine testing remains separate.
