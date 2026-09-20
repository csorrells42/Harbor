# Measured configuration advice

Open **Advisor → Measured configuration advice → Load saved evidence**. Choose a saved campaign and select **Check this campaign**. Harbor displays verified completion, uncertainty intervals, instruction adherence, task coverage, successful-task latency and available resource measurements. The static toolbox suggestions elsewhere in Advisor do not count as measured evidence.

A candidate needs a complete matched campaign on one identified harness/model/runtime/hardware setup, stable catalog transformations and inference controls, and separated completion intervals. Missing identity, overlapping uncertainty, excluded trials, per-task/adherence regressions or increased false completion claims withhold advice. Faster incorrect work cannot win through latency. A successful-task median is conditional on success; differences are not automatically paired speedups. Resource peaks are whole-system samples. Monetary cost and universal efficiency are not inferred.

The current setup is checked again before review and apply. A relevant source, harness, runtime, model or hardware change marks evidence stale. Unsupported catalog transformations cannot be partially applied. Changing the selected profile or its catalog invalidates a pending review. Synthetic benchmark evidence describes those tasks; transferring delivery settings to your tools requires validation on your workflow.

To apply supported delivery settings:

1. Select a named profile. Advice never targets the live default gateway.
2. Leave history unchecked, or explicitly choose to retain prior delivery values.
3. Select **Review profile change** and inspect each before/after value.
4. Select **Apply reviewed change** within five minutes. Harbor rechecks evidence, profile revision and tool catalog, then saves one new profile revision.
5. Reconnect the intended client to use that revision. Existing sessions keep their current revision.

Only tool delivery mode, hybrid methods, search limit, semantic threshold and local semantic-model choice can change. Existing server selection, isolation, capabilities and credentials remain part of the selected profile. No inference model is loaded by the advice workflow.

History is off by default. Opted-in receipts retain only changed delivery values and evidence/profile identifiers, capped at 50 entries and 256 KiB. **Clear configuration history** removes those receipts without changing current profiles. No application backups or full profile copies are created. A receipt-write or history-refresh failure does not undo or repeat a saved profile change.

Current local acceptance covers the decision engine, revision/catalog races, persistence, browser controls and the real Electron panel. The positive recommendation uses explicit engineering fixtures. LM Studio campaigns currently lack complete loaded-byte/server-default attestation, so automatic product advice remains withheld; independently verified model task outcomes remain inspectable. Final packaged and clean-machine acceptance are separate release gates.
